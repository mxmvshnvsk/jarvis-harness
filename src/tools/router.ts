import type { Runtime } from "../app/runtime.ts";
import { effectiveAllowWrites } from "../core/config/profiles.ts";
import type { ResolvedConfig } from "../core/config/schema.ts";
import type { Run } from "../core/domain/run.ts";
import { runEffect } from "../orchestration/effects.ts";
import type { HeldLease } from "../orchestration/lease.ts";
import { networkAllowed } from "../security/policy/egress.ts";
import type { PathPolicy, Redactor } from "../security/redactor.ts";
import { matchesAny, type ToolRegistry } from "./registry.ts";
import {
  type Capability,
  type CapabilityDescriptor,
  describeCapability,
  type ToolContext,
  type ToolOutput,
  type ToolResult,
} from "./types.ts";

/**
 * Tool Router (ADR-0001 §9, ADR-0016 §2): hands each agent only its allowed subset, enforces
 * policy before every call, journals effects (ADR-0002), redacts and caps outputs (ADR-0010).
 */
export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface BindOptions {
  readonly run: Run;
  readonly stepId: string;
  readonly iteration: number;
  readonly lease: HeldLease;
  readonly workspacePath: string;
  /** Capability patterns this agent may use; `["*"]` for everything policy allows. */
  readonly agentCapabilities: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

export interface RouterDeps {
  readonly runtime: Runtime;
  readonly registry: ToolRegistry;
  readonly redactor: Redactor;
  readonly pathPolicy: PathPolicy;
}

export class ToolRouter {
  private readonly rt: Runtime;
  private readonly registry: ToolRegistry;
  private readonly redactor: Redactor;
  private readonly pathPolicy: PathPolicy;

  constructor(deps: RouterDeps) {
    this.rt = deps.runtime;
    this.registry = deps.registry;
    this.redactor = deps.redactor;
    this.pathPolicy = deps.pathPolicy;
  }

  get config(): ResolvedConfig {
    return this.rt.loaded.config;
  }

  /** The deterministic rule set; evaluated at bind time and again before every call. */
  policy(capability: Capability, agentCapabilities: readonly string[]): PolicyDecision {
    const config = this.config;
    if (!matchesAny(capability.name, agentCapabilities))
      return { allowed: false, reason: "not in the agent's capability set" };
    if (matchesAny(capability.name, config.deniedCapabilities))
      return { allowed: false, reason: `denied by profile${config.profile ? ` "${config.profile}"` : ""}` };
    if (!networkAllowed(config.dataClass, capability.network)) {
      return {
        allowed: false,
        reason: `network "${capability.network}" is not allowed for dataClass "${config.dataClass}" (ADR-0016)`,
      };
    }
    if (capability.access !== "read" && !effectiveAllowWrites(config)) {
      return {
        allowed: false,
        reason: `writes are disabled in this workspace mode/profile (workspace.allowWrites)`,
      };
    }
    if (capability.access === "destructive" && !config.interactive) {
      return {
        allowed: false,
        reason: "destructive capabilities are never allowed in non-interactive profiles (ADR-0009 §6)",
      };
    }
    return { allowed: true };
  }

  allowed(agentCapabilities: readonly string[]): Capability[] {
    return this.registry.list().filter((c) => this.policy(c, agentCapabilities).allowed);
  }

  bind(options: BindOptions): BoundTools {
    return new BoundTools(this, this.rt, this.registry, this.redactor, this.pathPolicy, options);
  }
}

export class BoundTools {
  private readonly router: ToolRouter;
  private readonly rt: Runtime;
  private readonly registry: ToolRegistry;
  private readonly ctx: ToolContext;
  private readonly agentCapabilities: readonly string[];
  private seq = 0;

  constructor(
    router: ToolRouter,
    rt: Runtime,
    registry: ToolRegistry,
    redactor: Redactor,
    pathPolicy: PathPolicy,
    options: BindOptions,
  ) {
    this.router = router;
    this.rt = rt;
    this.registry = registry;
    this.agentCapabilities = options.agentCapabilities;
    this.ctx = {
      run: options.run,
      stepId: options.stepId,
      iteration: options.iteration,
      lease: options.lease,
      workspacePath: options.workspacePath,
      runtime: rt,
      redactor,
      pathPolicy,
      env: options.env ?? process.env,
    };
  }

  has(name: string): boolean {
    return this.registry.get(name) !== undefined;
  }

  /** Tool definitions for the model: only what policy allows (ADR-0001 §9 "разрешённый subset"). */
  list(): CapabilityDescriptor[] {
    return this.router.allowed(this.agentCapabilities).map(describeCapability);
  }

  async invoke(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const started = Date.now();
    const capability = this.registry.get(name);
    const base = { runId: this.ctx.run.id, stepId: this.ctx.stepId, iteration: this.ctx.iteration };
    if (!capability) {
      const result: ToolResult = {
        capability: name,
        ok: false,
        text: "",
        truncated: false,
        durationMs: 0,
        denied: `unknown capability "${name}"`,
      };
      this.rt.events.emit({
        kind: "tool.denied",
        ...base,
        payload: { capability: name, reason: result.denied },
      });
      return result;
    }
    const decision = this.router.policy(capability, this.agentCapabilities);
    if (!decision.allowed) {
      const result: ToolResult = {
        capability: name,
        ok: false,
        text: "",
        truncated: false,
        durationMs: 0,
        denied: decision.reason ?? "denied",
      };
      this.rt.events.emit({
        kind: "tool.denied",
        ...base,
        payload: {
          capability: name,
          reason: decision.reason,
          access: capability.access,
          network: capability.network,
        },
      });
      return result;
    }

    let output: ToolOutput;
    let source: ToolResult["source"] = "executed";
    try {
      if (capability.effect) {
        const outcome = await runEffect<ToolOutput>(this.rt.effects, this.ctx.lease, this.rt.events, {
          ...base,
          capability: name,
          args,
          seq: this.seq++,
          execute: () => capability.handler(args, this.ctx),
          ...(capability.verify
            ? {
                verify: (record) =>
                  (capability.verify as NonNullable<Capability["verify"]>)(args, record, this.ctx),
              }
            : {}),
        });
        output = outcome.result;
        source = outcome.source;
      } else {
        this.ctx.lease.check();
        output = await capability.handler(args, this.ctx);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "LeaseLostError" || error.name === "UnresolvedEffectError")
      )
        throw error;
      output = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const result = this.finish(capability, output, started, source);
    this.rt.events.emit({
      kind: "tool.call",
      ...base,
      payload: {
        capability: name,
        ok: result.ok,
        durationMs: result.durationMs,
        bytes: result.text.length,
        truncated: result.truncated,
        source,
        error: result.error,
        access: capability.access,
      },
    });
    return result;
  }

  private finish(
    capability: Capability,
    output: ToolOutput,
    started: number,
    source: ToolResult["source"],
  ): ToolResult {
    const redactedText = this.ctx.redactor.redact(
      output.text ?? (output.error ? `error: ${output.error}` : ""),
    );
    const redactedData =
      output.data === undefined ? undefined : this.ctx.redactor.redactValue(output.data).value;
    const redactedError = output.error ? this.ctx.redactor.redact(output.error).text : undefined;
    const max = this.rt.loaded.config.tools.maxOutputBytes;
    let text = redactedText.text;
    let truncated = false;
    let fullRef: string | undefined;
    if (Buffer.byteLength(text, "utf8") > max) {
      fullRef = this.rt.blobs.put(text, "text/plain").contentRef;
      text = `${Buffer.from(text, "utf8").subarray(0, max).toString("utf8")}\n…[truncated: full output ${Buffer.byteLength(text)} bytes, blob ${fullRef.slice(0, 12)}]`;
      truncated = true;
    }
    if (redactedText.count > 0) {
      this.rt.events.emit({
        kind: "security.redaction",
        runId: this.ctx.run.id,
        stepId: this.ctx.stepId,
        payload: {
          boundary: "tool",
          capability: capability.name,
          count: redactedText.count,
          byType: redactedText.byType,
        },
      });
    }
    return {
      capability: capability.name,
      ok: output.ok,
      text,
      ...(redactedData !== undefined ? { data: redactedData } : {}),
      truncated,
      ...(fullRef ? { fullRef } : {}),
      durationMs: Date.now() - started,
      ...(redactedError ? { error: redactedError } : {}),
      ...(source ? { source } : {}),
    };
  }
}

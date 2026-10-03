import { createRuntime } from "../../app/runtime.ts";
import { ModelError } from "../../models/errors.ts";
import { type ProbeResult, probeDrift, probeIsStale, probeModel } from "../../models/probe.ts";
import { structuredModeOf } from "../../models/router.ts";
import { modelAllowed } from "../../security/policy/egress.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT, padEnd } from "../output.ts";
import { loadForCli } from "./config.ts";

interface ModelRow {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly egress: string;
  readonly allowed: boolean;
  readonly pool: string;
  readonly contextWindow: number;
  readonly maxOutput: number;
  readonly structured: string;
  readonly tools: boolean;
  readonly roles: string[];
  readonly probe?: { at: string; stale: boolean; drift: string[] };
  readonly window?: {
    outputTokens: number;
    limit?: number;
    requests: number;
    requestLimit?: number;
    resetsIn: string;
  };
}

function fmtDuration(ms: number): string {
  if (ms <= 0) return "now";
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return m > 0 ? `${m}m${s.toString().padStart(2, "0")}s` : `${s}s`;
}

export async function runModelsList(ctx: CliContext): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const rows: ModelRow[] = Object.entries(loaded.config.models).map(([id, model]) => {
      const roles = Object.entries(loaded.config.roles)
        .filter(([, r]) => r.models.includes(id))
        .map(([name]) => name);
      const probe = runtime.probes.get(id);
      const pool = model.quotaPool ?? `model:${id}`;
      const usage = runtime.budget.windowUsage(pool);
      const definition = runtime.budget.pool(pool);
      return {
        id,
        provider: model.provider,
        model: model.model,
        egress: model.egress,
        allowed: modelAllowed(loaded.config.dataClass, model.egress),
        pool,
        contextWindow: model.contextWindow,
        maxOutput: model.maxOutput,
        structured: structuredModeOf(model),
        tools: model.supports.tools,
        roles,
        ...(probe
          ? {
              probe: {
                at: probe.probedAt,
                stale: probeIsStale(probe),
                drift: probeDrift(model, probe).map(
                  (d) => `${d.capability}: config ${d.configured} / probe ${d.probed}`,
                ),
              },
            }
          : {}),
        ...(usage && definition
          ? {
              window: {
                outputTokens: usage.outputTokens,
                ...(definition.limits.outputTokens !== undefined
                  ? { limit: definition.limits.outputTokens }
                  : {}),
                requests: usage.requests,
                ...(definition.limits.requests !== undefined
                  ? { requestLimit: definition.limits.requests }
                  : {}),
                resetsIn: fmtDuration(
                  usage.windowEnd.getTime() + definition.window.minutes * 60_000 - Date.now(),
                ),
              },
            }
          : {}),
      };
    });
    ctx.out.result({ dataClass: loaded.config.dataClass, models: rows }, () => {
      if (rows.length === 0) {
        ctx.out.line("no models configured — add one to ~/.jarvis/config.yaml (ADR-0017 §2)");
        return;
      }
      ctx.out.line(`dataClass: ${loaded.config.dataClass}`);
      ctx.out.line();
      const w = Math.max(...rows.map((r) => r.id.length), 5);
      ctx.out.line(
        `${padEnd("model", w)}  ${padEnd("provider", 17)}  ${padEnd("egress", 8)}  ${padEnd("pool", 14)}  ctx/out        structured  tools  roles`,
      );
      for (const r of rows) {
        const egress = r.allowed ? r.egress : `${r.egress}✗`;
        ctx.out.line(
          `${padEnd(r.id, w)}  ${padEnd(r.provider, 17)}  ${padEnd(egress, 8)}  ${padEnd(r.pool, 14)}  ${padEnd(`${r.contextWindow}/${r.maxOutput}`, 13)}  ${padEnd(r.structured, 10)}  ${padEnd(r.tools ? "yes" : "no", 5)}  ${r.roles.join(",") || "-"}`,
        );
        if (r.window) {
          const limit = r.window.limit !== undefined ? `/${r.window.limit}` : "";
          const rl = r.window.requestLimit !== undefined ? `/${r.window.requestLimit}` : "";
          ctx.out.line(
            `${" ".repeat(w)}  window: ${r.window.outputTokens}${limit} output tokens, ${r.window.requests}${rl} requests`,
          );
        }
        if (r.probe) {
          const drift = r.probe.drift.length > 0 ? ` DRIFT ${r.probe.drift.join("; ")}` : "";
          ctx.out.line(
            `${" ".repeat(w)}  probe: ${r.probe.at.slice(0, 10)}${r.probe.stale ? " (stale)" : ""}${drift}`,
          );
        } else {
          ctx.out.line(`${" ".repeat(w)}  probe: never — run \`jarvis models probe ${r.id}\``);
        }
      }
    });
  } finally {
    await runtime.close();
  }
}

export async function runModelsProbe(ctx: CliContext, modelId: string): Promise<void> {
  const loaded = await loadForCli(ctx);
  const model = loaded.config.models[modelId];
  if (!model) {
    ctx.out.error(`unknown model "${modelId}"; see \`jarvis models list\``);
    throw new CliExit(EXIT.error);
  }
  if (!modelAllowed(loaded.config.dataClass, model.egress)) {
    ctx.out.error(
      `model "${modelId}" has egress ${model.egress}, not allowed for dataClass ${loaded.config.dataClass}; probe refused (ADR-0016 §3)`,
    );
    throw new CliExit(EXIT.policyDenied);
  }
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    let result: ProbeResult;
    try {
      result = await probeModel(runtime.gateway, modelId);
    } catch (error) {
      if (error instanceof ModelError) {
        ctx.out.error(error.message);
        throw new CliExit(error.kind === "quota_exhausted" ? EXIT.waitingBudget : EXIT.error);
      }
      throw error;
    }
    const path = runtime.probes.set(result);
    const drift = probeDrift(model, result);
    ctx.out.result({ ...result, drift, path }, () => {
      ctx.out.line(
        `model ${modelId} (${model.model}) probed in ${result.latencyMs} ms, ${result.outputTokens} output tokens`,
      );
      for (const [k, v] of Object.entries(result.supports)) {
        const err = result.errors[k] ? `  — ${result.errors[k]}` : "";
        ctx.out.line(`  ${padEnd(k, 11)} ${v ? "yes" : "no "}${err}`);
      }
      if (drift.length > 0) {
        ctx.out.line();
        ctx.out.line("drift against configuration:");
        for (const d of drift)
          ctx.out.line(`  ${d.capability}: config says ${d.configured}, probe says ${d.probed}`);
      }
      ctx.out.line(`saved: ${path}`);
    });
  } finally {
    await runtime.close();
  }
}

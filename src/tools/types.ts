import type { Runtime } from "../app/runtime.ts";
import type { Network } from "../core/config/schema.ts";
import type { Run } from "../core/domain/run.ts";
import type { HeldLease } from "../orchestration/lease.ts";
import type { PathPolicy, Redactor } from "../security/redactor.ts";
import type { EffectRecord } from "../storage/effects.ts";

/** read: observes; write: changes the workspace; destructive: removes or changes outside the workspace. */
export type ToolAccess = "read" | "write" | "destructive";

export interface ToolContext {
  readonly run: Run;
  readonly stepId: string;
  readonly iteration: number;
  readonly lease: HeldLease;
  readonly workspacePath: string;
  readonly runtime: Runtime;
  readonly redactor: Redactor;
  readonly pathPolicy: PathPolicy;
  readonly env: NodeJS.ProcessEnv;
  /** Present while an effect runs: its journal key and the marker to embed (ADR-0002 §3). */
  readonly effect?: { readonly key: string; readonly marker: string };
}

export interface ToolOutput {
  readonly ok: boolean;
  /** Human/LLM-readable text. */
  readonly text?: string;
  /** Structured payload for deterministic consumers. */
  readonly data?: unknown;
  readonly error?: string;
}

/**
 * A normalized capability (ADR-0001 §9, ADR-0017 §4): what policy, agents and the effect journal
 * refer to. Local providers declare them directly; MCP profiles map server tools onto them.
 */
export interface Capability {
  readonly name: string;
  readonly description: string;
  readonly network: Network;
  readonly access: ToolAccess;
  /** Side effect on an external system → journaled with an idempotency key (ADR-0002 §1). */
  readonly effect: boolean;
  /** JSON Schema of `args`. */
  readonly parameters: Record<string, unknown>;
  /** The MCP server behind it, if any (an egress exception names a server, ADR-0016 §6). */
  readonly server?: string;
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
  /** For effects: look for the marker on the provider side (ADR-0002 §3). */
  verify?(
    args: Record<string, unknown>,
    record: EffectRecord,
    ctx: ToolContext,
  ): Promise<ToolOutput | "not-found" | undefined>;
}

export interface ToolProvider {
  readonly name: string;
  capabilities(): readonly Capability[];
}

export interface ToolResult {
  readonly capability: string;
  readonly ok: boolean;
  /** Redacted and capped text (ADR-0010 §1, tools.maxOutputBytes). */
  readonly text: string;
  readonly data?: unknown;
  readonly truncated: boolean;
  /** Blob with the full redacted output when truncated. */
  readonly fullRef?: string;
  readonly durationMs: number;
  readonly error?: string;
  /** Set when policy refused the call before it ran. */
  readonly denied?: string;
  readonly source?: "executed" | "journal" | "verified";
}

/** Shape handed to the model as a tool definition. */
export interface CapabilityDescriptor {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly access: ToolAccess;
  readonly effect: boolean;
}

export function describeCapability(c: Capability): CapabilityDescriptor {
  return {
    name: c.name,
    description: c.description,
    parameters: c.parameters,
    access: c.access,
    effect: c.effect,
  };
}

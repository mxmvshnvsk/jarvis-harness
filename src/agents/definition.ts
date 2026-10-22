import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { layoutOf } from "../core/paths.ts";
import type { AgentRequirements } from "../models/router.ts";

/**
 * AgentDefinition (ADR-0001 §6): instructions, model role, capability set, result schema and
 * limits. An agent never sees all tools and never knows the model API.
 */
export interface AgentLimits {
  /** Tool calls per step before the agent is asked to finish. */
  readonly maxToolCalls: number;
  /** Model calls per step (tool rounds + finalization). */
  readonly maxModelCalls: number;
  /** Intra-step checkpoint every N tool calls (ADR-0002 §4). */
  readonly checkpointEvery: number;
  /**
   * How far a pool's unlimited hours may raise the two limits above (`unlimitedScale`); none — as far as
   * the pool says. An agent whose work has a natural end (impact) does not search more because it is night.
   */
  readonly maxScale?: number;
}

export interface AgentOutput<T = unknown> {
  /** Artifact type, e.g. `research`; the file name is `<type>.json`. */
  readonly type: string;
  readonly schema: z.ZodType<T>;
  /** Outcomes the workflow may declare edges for; `ok` is always allowed. */
  readonly outcomes: readonly string[];
}

export interface AgentDefinition<T = unknown> {
  readonly id: string;
  readonly role: string;
  readonly description: string;
  readonly instructions: string;
  /** Capability patterns (ADR-0001 §9): least privilege, read/write separated. */
  readonly capabilities: readonly string[];
  readonly requires: AgentRequirements;
  readonly output: AgentOutput<T>;
  readonly limits: AgentLimits;
  /** Artifact types to inject fully (the rest of the step inputs are listed by name only). */
  readonly contextInputs?: readonly string[];
  /**
   * The task message's size (inputs and knowledge, in characters) for an agent that works in a loop of
   * many model calls: every call sends it again (no prefix cache on the pilot gateway). Without — a
   * share of the model's window. Pilot: implementation sent ~240k characters on each of 162 calls,
   * two thirds of the step's 20M input tokens.
   */
  readonly baseChars?: number;
  /**
   * Where the gateway caches no prefixes, every call sends the task message and the kept tool results
   * again: a leaner `baseChars` and `workingSet` for such a model (with a cache, keeping is cheap and the
   * defaults stay). Pilot: implementation's calls carried ~110k tokens each, most of it re-sent context.
   */
  readonly uncached?: { readonly baseChars?: number; readonly workingSet?: number };
  /** Where the agent may write (globs); without — wherever its capabilities and the path policy allow. */
  readonly writes?: readonly string[];
  /**
   * The outcome as the document's own verdict says it: a model that wrote the verdict and forgot the
   * outcome (default "ok") sent a fix_required review to the approval (pilot). Undefined: as written.
   */
  readonly outcomeOf?: (doc: Record<string, unknown>) => string | undefined;
  /** `reasoning_effort` of the agent's calls (agents.<id>.reasoningEffort overrides it). */
  readonly reasoningEffort?: "none" | "low" | "medium" | "high";
  /**
   * At a used-up limit, by default: `ask` — a person grants more or lets it finish (where one can
   * answer); `finish` (none) — the result from what it has, marked incomplete. `agents.<id>.onLimit`
   * and the step's own come first.
   */
  readonly onLimit?: "finish" | "ask";
}

export const DEFAULT_LIMITS: AgentLimits = { maxToolCalls: 40, maxModelCalls: 60, checkpointEvery: 5 };

export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();
  private readonly projectRoot: string | undefined;

  constructor(definitions: readonly AgentDefinition[], projectRoot?: string) {
    for (const d of definitions) this.agents.set(d.id, d);
    this.projectRoot = projectRoot;
  }

  /** Project override of the instructions: `.jarvis/agents/<id>.md` (ADR-0001 §8 versioned knowledge). */
  get(id: string): AgentDefinition | undefined {
    const base = this.agents.get(id);
    if (!base) return undefined;
    if (!this.projectRoot) return base;
    const override = join(layoutOf(this.projectRoot).jarvisDir, "agents", `${id}.md`);
    if (!existsSync(override)) return base;
    return { ...base, instructions: readFileSync(override, "utf8").trim() };
  }

  list(): AgentDefinition[] {
    return [...this.agents.keys()].sort().map((id) => this.get(id) as AgentDefinition);
  }
}

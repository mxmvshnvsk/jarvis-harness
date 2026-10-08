import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
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
  /** Where the agent may write (globs); without — wherever its capabilities and the path policy allow. */
  readonly writes?: readonly string[];
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
    const override = join(this.projectRoot, ".jarvis", "agents", `${id}.md`);
    if (!existsSync(override)) return base;
    return { ...base, instructions: readFileSync(override, "utf8").trim() };
  }

  list(): AgentDefinition[] {
    return [...this.agents.keys()].sort().map((id) => this.get(id) as AgentDefinition);
  }
}

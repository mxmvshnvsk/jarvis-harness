import { z } from "zod";
import { ActorSchema } from "./actor.ts";

/**
 * Run states (ADR-0001 §4) plus CANCELLED (ADR-0002 §6).
 *
 *   CREATED -> RUNNING -> COMPLETED
 *                 |
 *                 +-> WAITING_BUDGET -> RUNNING
 *                 +-> WAITING_HUMAN  -> RUNNING | FAILED
 *                 +-> SUSPENDED      -> RUNNING
 *                 +-> FAILED         -> RUNNING (retry) | terminal
 *                 +-> CANCELLED
 */
export const RunStateSchema = z.enum([
  "CREATED",
  "RUNNING",
  "WAITING_BUDGET",
  "WAITING_HUMAN",
  "SUSPENDED",
  "FAILED",
  "COMPLETED",
  "CANCELLED",
]);
export type RunState = z.infer<typeof RunStateSchema>;

const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  CREATED: ["RUNNING", "CANCELLED"],
  RUNNING: ["COMPLETED", "WAITING_BUDGET", "WAITING_HUMAN", "SUSPENDED", "FAILED", "CANCELLED"],
  WAITING_BUDGET: ["RUNNING", "CANCELLED"],
  WAITING_HUMAN: ["RUNNING", "FAILED", "CANCELLED"],
  SUSPENDED: ["RUNNING", "CANCELLED"],
  FAILED: ["RUNNING", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(["COMPLETED", "CANCELLED"]);
export const WAITING_STATES: ReadonlySet<RunState> = new Set([
  "WAITING_BUDGET",
  "WAITING_HUMAN",
  "SUSPENDED",
]);

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Whether a run in this state may be picked up by `jarvis resume` or the daemon. */
export function isResumable(state: RunState): boolean {
  return WAITING_STATES.has(state) || state === "FAILED";
}

export class InvalidTransitionError extends Error {
  readonly from: RunState;
  readonly to: RunState;

  constructor(from: RunState, to: RunState) {
    super(`invalid run transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** ADR-0003 §1 */
export const WorkspaceRefSchema = z.strictObject({
  mode: z.enum(["worktree", "cwd"]),
  repoRoot: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1).optional(),
  baseRef: z.string().min(1),
  baseCommit: z.string().min(1).optional(),
  headCommit: z.string().min(1).optional(),
});
export type WorkspaceRef = z.infer<typeof WorkspaceRefSchema>;

/** ADR-0002 §5 */
export const LeaseSchema = z.strictObject({
  owner: z.string().min(1),
  epoch: z.int().nonnegative(),
  until: z.iso.datetime(),
});
export type Lease = z.infer<typeof LeaseSchema>;

export const InteractionKindSchema = z.enum(["approval", "clarification", "review", "conflict"]);
export type InteractionKind = z.infer<typeof InteractionKindSchema>;

export const WaitingForSchema = z.strictObject({
  kind: z.enum(["approval", "clarification", "review", "conflict", "budget", "effect", "loop", "model"]),
  interactionId: z.string().min(1).optional(),
  detail: z.string().optional(),
});
export type WaitingFor = z.infer<typeof WaitingForSchema>;

export const RunSchema = z.strictObject({
  id: z.string().min(1),
  task: z.string().min(1),
  workflow: z.string().min(1),
  state: RunStateSchema,
  owner: ActorSchema,
  workspace: WorkspaceRefSchema,
  currentStep: z.string().min(1).optional(),
  currentIteration: z.int().positive().default(1),
  /** Back-edge iteration counters (ADR-0004 §3): edgeId → count. */
  iterations: z.record(z.string(), z.int().nonnegative()).default({}),
  dataClass: z.enum(["public", "internal", "confidential"]),
  profile: z.string().min(1).optional(),
  lease: LeaseSchema.optional(),
  cancelRequested: z.boolean().default(false),
  stateReason: z.string().optional(),
  /** What a WAITING_HUMAN run waits for (ADR-0019 §2); cleared on resume. */
  waitingFor: WaitingForSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Run = z.infer<typeof RunSchema>;

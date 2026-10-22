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
  /** How the run's checkout is made (`workspace.checkout`): absent — a git worktree. */
  checkout: z.enum(["clone"]).optional(),
  /**
   * The task is in a Story (`relatedWork.story`): its key and branch, and whether the run started from
   * that branch (its PR goes into it) — false when the repository has no such branch yet.
   */
  story: z
    .strictObject({
      key: z.string().min(1),
      branch: z.string().min(1),
      based: z.boolean(),
      /** The branch was made at this run's start (the Story's first task in the repository). */
      created: z.boolean().optional(),
    })
    .optional(),
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
  kind: z.enum([
    "approval",
    "clarification",
    "review",
    "conflict",
    "budget",
    "effect",
    "loop",
    "model",
    // a task across services waits for its subtasks (ADR-0025 §6)
    "children",
    // an sdd whose impact reaches other services: on as a task across services, or only here (§7)
    "scope",
    // a subtask asks its master to change the contract; a person decides on the master (§6)
    "contract",
  ]),
  interactionId: z.string().min(1).optional(),
  detail: z.string().optional(),
});
export type WaitingFor = z.infer<typeof WaitingForSchema>;

/** What a task asks of its run beyond its text; kept with the run, so a resume keeps it too. */
export const FreshSourceSchema = z.enum(["design"]);
export type FreshSource = z.infer<typeof FreshSourceSchema>;
/**
 * What kind of work a task is: it picks the skills and standards scoped by `kinds` (ADR-0020 §1). Set at
 * the start (`--kind`, «Kind» on New task), else the workflow's own `kind`, else `change`.
 */
export const TASK_KINDS = ["feature", "change", "fix", "refactor", "test", "docs"] as const;
export const TaskKindSchema = z.enum(TASK_KINDS);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const RunOptionsSchema = z.strictObject({
  /** The kind of task, when the person said it; otherwise the workflow's (src/agents/knowledge.ts). */
  kind: TaskKindSchema.optional(),
  /** Sources read again past Jarvis's cache: "design" — the Figma frames (a frame changed at the same link). */
  fresh: z.array(FreshSourceSchema).optional(),
  /** A subtask of a task across services (ADR-0025 §6): its master run and its key in the split. */
  parent: z.strictObject({ runId: z.string().min(1), key: z.string().min(1) }).optional(),
  /**
   * How the run delivers itself once its workflow is done (ADR-0003 §4): `pr` — the run pushes its
   * branch and opens the PR itself instead of waiting for a person's Apply (`jarvis work --deliver pr`).
   */
  delivery: z.enum(["pr"]).optional(),
  /** No person in the loop (src/app/autonomy.ts; experimental): `jarvis work --autonomous`. */
  autonomous: z.literal(true).optional(),
  /** Read the work of related tasks before the spec (ADR-0026); none — the project's `relatedWork.enabled`. */
  related: z.boolean().optional(),
  /** The PR flow for this run (`--pr-flow` / `--no-pr-flow`, New task); none — `delivery.flow.enabled`. */
  prFlow: z.boolean().optional(),
  /** A fix of a PR's comments (`jarvis pr-fix`): the run whose PR it is; it pushes onto that PR's branch. */
  prFix: z.strictObject({ runId: z.string().min(1) }).optional(),
});
export type RunOptions = z.infer<typeof RunOptionsSchema>;

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
  options: RunOptionsSchema.optional(),
  lease: LeaseSchema.optional(),
  cancelRequested: z.boolean().default(false),
  stateReason: z.string().optional(),
  /** What a WAITING_HUMAN run waits for (ADR-0019 §2); cleared on resume. */
  waitingFor: WaitingForSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Run = z.infer<typeof RunSchema>;

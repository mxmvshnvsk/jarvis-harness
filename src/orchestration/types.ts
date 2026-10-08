import type { Runtime } from "../app/runtime.ts";
import type { Run, RunState, WaitingFor } from "../core/domain/run.ts";
import type { StepDefinition, StepKind, WorkflowDefinition } from "../core/domain/workflow.ts";
import type { ModelCaller } from "../models/gateway.ts";
import type { BoundTools } from "../tools/router.ts";
import type { HeldLease } from "./lease.ts";
import type { Workspace } from "./workspace.ts";

/** What a step executor returns (ADR-0004 §1–2). */
export interface StepOutcome {
  readonly status: "success" | "failure";
  readonly outcome?: string;
  /** `artifactId@version` references produced by the step. */
  readonly outputs?: readonly string[];
  readonly reason?: string;
}

/** Everything a step executor may touch. The gateway here is budget-aware (ADR-0018 §4). */
export interface StepContext {
  readonly run: Run;
  readonly workflow: WorkflowDefinition;
  readonly step: StepDefinition;
  readonly iteration: number;
  readonly lease: HeldLease;
  readonly runtime: Runtime;
  readonly gateway: ModelCaller;
  readonly workspace: Workspace;
  /** Tools this step may call: policy-filtered, journaled, redacted (ADR-0001 §9). */
  readonly tools: BoundTools;
  /** State restored from the latest intra-step checkpoint of this step/iteration, if any. */
  readonly restored: Record<string, unknown> | undefined;
  /** `artifactId@version` references of the inputs this step received (ADR-0005 §5). */
  readonly inputs: readonly string[];
  saveCheckpoint(state: Record<string, unknown>): void;
  /** Re-reads the run; true once `jarvis cancel` was called (ADR-0002 §6). */
  cancelRequested(): boolean;
  /** A person asked to pause (src/app/pause.ts): who; the agent parks at its next safe point. */
  pauseRequested?(): { by?: string } | undefined;
}

export interface StepExecutor {
  readonly kind: StepKind;
  execute(ctx: StepContext): Promise<StepOutcome>;
}

/** Thrown by executors (or converted by the runtime) to park the run (ADR-0001 §4). */
export class SuspendRun extends Error {
  readonly state: Extract<RunState, "WAITING_BUDGET" | "WAITING_HUMAN" | "SUSPENDED">;
  readonly reason: string;
  readonly resumeAfter?: Date;
  readonly checkpointState: Record<string, unknown>;
  /** ADR-0019 §2: what the parked run waits for. */
  readonly waitingFor?: WaitingFor;

  constructor(
    state: SuspendRun["state"],
    reason: string,
    options: { resumeAfter?: Date; checkpointState?: Record<string, unknown>; waitingFor?: WaitingFor } = {},
  ) {
    super(`${state}: ${reason}`);
    this.name = "SuspendRun";
    this.state = state;
    this.reason = reason;
    if (options.resumeAfter) this.resumeAfter = options.resumeAfter;
    this.checkpointState = options.checkpointState ?? {};
    if (options.waitingFor) this.waitingFor = options.waitingFor;
  }
}

export class LeaseHeldError extends Error {
  readonly heldBy: string;
  readonly until: string;
  constructor(runId: string, heldBy: string, until: string) {
    super(
      `run ${runId} is held by ${heldBy} until ${until}; use --steal only if that process is dead (ADR-0002 §5)`,
    );
    this.name = "LeaseHeldError";
    this.heldBy = heldBy;
    this.until = until;
  }
}

export interface ExecutionResult {
  readonly run: Run;
  /** ADR-0009 §3 */
  readonly exitCode: number;
}

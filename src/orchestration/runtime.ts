import type { Runtime } from "../app/runtime.ts";
import { BudgetExceededError, BudgetedGateway } from "../budget/runBudget.ts";
import { EXIT } from "../cli/output.ts";
import type { Run, RunState } from "../core/domain/run.ts";
import { isTerminal } from "../core/domain/run.ts";
import {
  findStep,
  STEP_DONE,
  STEP_FAIL,
  type StepDefinition,
  selectTransition,
  type WorkflowDefinition,
} from "../core/domain/workflow.ts";
import { afterAnalysis, afterImplementation } from "../interaction/review/lifecycle.ts";
import { ModelError } from "../models/errors.ts";
import { LeaseLostError } from "../storage/runStore.ts";
import { errorFields } from "../telemetry/log.ts";
import { UnresolvedEffectError } from "./effects.ts";
import { AgenticExecutor, ApprovalExecutor, CompositeExecutor, DeterministicExecutor } from "./executors.ts";
import { HeldLease, type HeldLeaseOptions } from "./lease.ts";
import {
  type ExecutionResult,
  LeaseHeldError,
  type StepContext,
  type StepExecutor,
  type StepOutcome,
  SuspendRun,
} from "./types.ts";
import type { Workspace, WorkspaceFactory } from "./workspace.ts";
import { workspaceFactory } from "./worktree.ts";

/**
 * LocalWorkflowEngine (ADR-0011 §1): step execution, deterministic transitions with bounded
 * back edges (ADR-0004), checkpoints on step boundaries (ADR-0002 §4), suspension to the
 * WAITING_* states and resumption from the last checkpoint, cancel at a safe point (ADR-0002 §6).
 */
export interface EngineOptions {
  readonly runtime: Runtime;
  readonly workflows: ReadonlyMap<string, WorkflowDefinition>;
  readonly executors?: Partial<Record<StepExecutor["kind"], StepExecutor>>;
  readonly workspaces?: WorkspaceFactory;
  readonly leaseOptions?: HeldLeaseOptions;
  readonly clock?: () => Date;
}

export interface ExecuteOptions {
  readonly owner: string;
  /** Take the lease even if another process holds it (recorded with the actor by the caller). */
  readonly steal?: boolean;
}

/** ADR-0009 §3: a FAILED run whose reason is a policy refusal exits 12, not 1. */
export const POLICY_REASON_PREFIX = "policy:";

export function exitCodeFor(state: RunState, reason?: string): number {
  switch (state) {
    case "FAILED":
      return reason?.startsWith(POLICY_REASON_PREFIX) ? EXIT.policyDenied : EXIT.error;
    case "COMPLETED":
      return EXIT.ok;
    case "WAITING_HUMAN":
      return EXIT.waitingHuman;
    case "WAITING_BUDGET":
      return EXIT.waitingBudget;
    case "CANCELLED":
      return EXIT.ok;
    default:
      return EXIT.error;
  }
}

export class LocalWorkflowEngine {
  private readonly rt: Runtime;
  private readonly workflows: ReadonlyMap<string, WorkflowDefinition>;
  private readonly executors: Record<StepExecutor["kind"], StepExecutor>;
  private readonly workspaces: WorkspaceFactory;
  private readonly leaseOptions: HeldLeaseOptions;
  private readonly clock: () => Date;

  constructor(options: EngineOptions) {
    this.rt = options.runtime;
    this.workflows = options.workflows;
    this.workspaces = options.workspaces ?? workspaceFactory(options.runtime.env);
    this.leaseOptions = options.leaseOptions ?? {};
    this.clock = options.clock ?? (() => new Date());
    this.executors = {
      deterministic: options.executors?.deterministic ?? new DeterministicExecutor({}),
      agentic: options.executors?.agentic ?? new AgenticExecutor(),
      approval: options.executors?.approval ?? new ApprovalExecutor(),
      composite:
        options.executors?.composite ??
        new CompositeExecutor((ctx, childId) =>
          this.executeStep(
            ctx.run,
            ctx.workflow,
            findStep(ctx.workflow, childId),
            ctx.iteration,
            ctx.lease,
            ctx.workspace,
          ),
        ),
    };
  }

  workflow(name: string): WorkflowDefinition {
    const wf = this.workflows.get(name);
    if (!wf) throw new Error(`unknown workflow "${name}"`);
    return wf;
  }

  /** Starts a CREATED run or resumes a resumable one; returns when the run parks or ends. */
  async execute(runId: string, options: ExecuteOptions): Promise<ExecutionResult> {
    let run = this.rt.runs.require(runId);
    if (isTerminal(run.state)) return { run, exitCode: exitCodeFor(run.state, run.stateReason) };
    const workflow = this.workflow(run.workflow);

    const lease = options.steal
      ? HeldLease.steal(this.rt.runs, run.id, options.owner, this.leaseOptions)
      : HeldLease.acquire(this.rt.runs, run.id, options.owner, this.leaseOptions);
    if (!lease) {
      const held = this.rt.runs.require(run.id).lease;
      throw new LeaseHeldError(run.id, held?.owner ?? "?", held?.until ?? "?");
    }
    this.emit(run, "run.lease", { owner: options.owner, epoch: lease.epoch, stolen: options.steal === true });

    const workspace = await this.workspaces.open(run.workspace);
    try {
      if (run.state !== "CREATED") {
        // ADR-0019 §6: the developer owns the workspace — uncommitted human edits become a
        // human checkpoint first; Jarvis never resets over them.
        const humanEdit = await workspace.humanCheckpoint?.(run.owner.id);
        if (humanEdit) {
          this.rt.checkpoints.save({
            runId: run.id,
            stepId: run.currentStep ?? "?",
            iteration: run.currentIteration,
            kind: "step",
            headCommit: humanEdit.commit,
            state: { humanEdit: humanEdit.files },
          });
          this.emit(run, "workspace.humanEdit", { commit: humanEdit.commit, files: humanEdit.files });
        } else {
          // ADR-0003 §3: the file state of a resumed run is exactly its last checkpoint.
          const last = this.rt.checkpoints.latest(run.id);
          await workspace.restore(last?.headCommit);
        }
      }
      run = this.enter(run, workflow);
      for (;;) {
        if (run.cancelRequested) {
          run = this.rt.runs.transition(run.id, "CANCELLED", { reason: "cancelled at a safe point" });
          this.emit(run, "run.state", { state: run.state });
          break;
        }
        const step = findStep(workflow, run.currentStep as string);
        const iteration = run.currentIteration;
        let outcome: StepOutcome;
        try {
          outcome = await this.executeStep(run, workflow, step, iteration, lease, workspace);
        } catch (error) {
          const suspend = this.toSuspension(error);
          if (suspend) {
            run = await this.park(run, step, iteration, suspend, workspace);
            break;
          }
          if (error instanceof LeaseLostError) {
            this.emit(run, "run.leaseLost", { reason: error.message });
            throw error;
          }
          // an unexpected exception: the stack goes to the journal (cut) and to the log (whole)
          const detail = errorFields(error);
          this.emit(run, "step.error", {
            stepId: step.id,
            iteration,
            error: String(detail.name ?? "Error"),
            message: String(detail.message ?? "").slice(0, 600),
            stack: String(detail.stack ?? "").slice(0, 4000),
          });
          this.rt.log.error("step.error.detail", {
            runId: run.id,
            stepId: step.id,
            iteration,
            ...detail,
          });
          run = this.rt.runs.transition(run.id, "FAILED", {
            reason: error instanceof Error ? error.message : String(error),
          });
          this.emit(run, "run.state", { state: run.state, reason: run.stateReason });
          break;
        }

        const next = await this.advance(run, step, iteration, outcome, workspace);
        run = next.run;
        if (next.stop) break;
      }
    } finally {
      lease.release();
    }
    const final = this.rt.runs.require(run.id);
    return { run: final, exitCode: exitCodeFor(final.state, final.stateReason) };
  }

  /* ---- step execution ---- */

  private async executeStep(
    run: Run,
    workflow: WorkflowDefinition,
    step: StepDefinition,
    iteration: number,
    lease: HeldLease,
    workspace: Workspace,
  ): Promise<StepOutcome> {
    lease.check();
    const skip = this.skipReason(run, step);
    if (skip) {
      const historyId = this.rt.history.start(run.id, step.id, iteration, []);
      this.emit(run, "step.start", { stepId: step.id, iteration, kind: step.kind, inputs: [] });
      this.rt.history.finish(historyId, "success", "skipped", []);
      this.emit(run, "step.finish", { stepId: step.id, iteration, status: "skipped", reason: skip });
      return { status: "success" };
    }
    const inputs = this.inputsFor(run, step);
    const restored = this.restoredState(run, step, iteration);
    const historyId = this.rt.history.start(run.id, step.id, iteration, inputs);
    this.emit(run, "step.start", { stepId: step.id, iteration, kind: step.kind, inputs });
    const gateway = new BudgetedGateway(this.rt.gateway, this.rt.db.db, this.rt.loaded.config, {
      runId: run.id,
      stepId: step.id,
      iteration,
    });
    const tools = this.rt.tools.bind({
      run,
      stepId: step.id,
      iteration,
      lease,
      workspacePath: workspace.ref.path,
      agentCapabilities: ["*"],
      env: this.rt.env,
    });
    const ctx: StepContext = {
      run,
      workflow,
      step,
      iteration,
      lease,
      runtime: this.rt,
      gateway,
      workspace,
      tools,
      restored,
      inputs,
      saveCheckpoint: (state) => {
        this.rt.checkpoints.save({ runId: run.id, stepId: step.id, iteration, kind: "intra", state });
      },
      cancelRequested: () => this.rt.runs.require(run.id).cancelRequested,
    };
    try {
      const outcome = await this.executors[step.kind].execute(ctx);
      this.rt.history.finish(historyId, outcome.status, outcome.outcome, outcome.outputs ?? []);
      this.emit(run, "step.finish", {
        stepId: step.id,
        iteration,
        status: outcome.status,
        outcome: outcome.outcome,
        reason: outcome.reason,
      });
      return outcome;
    } catch (error) {
      const suspend = this.toSuspension(error);
      this.rt.history.finish(historyId, suspend ? "suspended" : "failure", suspend?.state);
      throw error;
    }
  }

  /** Why a conditional step (`when:`) has nothing to do in this run; undefined when it runs. */
  private skipReason(run: Run, step: StepDefinition): string | undefined {
    const affects = step.when?.affects;
    if (!affects) return undefined;
    const impact = this.rt.artifacts.listLatest(run.id, "impact")[0];
    if (!impact) return undefined;
    try {
      const doc = JSON.parse(this.rt.artifacts.text(impact)) as { affected?: Array<{ kind?: string }> };
      return (doc.affected ?? []).some((a) => a.kind === affects)
        ? undefined
        : `the impact analysis names nothing of kind ${affects}`;
    } catch {
      return undefined;
    }
  }

  private inputsFor(run: Run, step: StepDefinition): string[] {
    return step.inputs.flatMap((type) =>
      this.rt.artifacts.listLatest(run.id, type).map((a) => `${a.artifactId}@${a.version}`),
    );
  }

  /** The last intra-step checkpoint of this step/iteration, if the step was interrupted. */
  private restoredState(
    run: Run,
    step: StepDefinition,
    iteration: number,
  ): Record<string, unknown> | undefined {
    const intra = this.rt.checkpoints
      .list(run.id)
      .filter((c) => c.kind === "intra" && c.stepId === step.id && c.iteration === iteration);
    return intra.at(-1)?.state;
  }

  /* ---- transitions (ADR-0004 §3) ---- */

  private async advance(
    run: Run,
    step: StepDefinition,
    iteration: number,
    outcome: StepOutcome,
    workspace: Workspace,
  ): Promise<{ run: Run; stop: boolean }> {
    if (outcome.status === "success") this.reviewHooks(run, step, outcome);
    let transition: ReturnType<typeof selectTransition>;
    try {
      transition = selectTransition(step, {
        status: outcome.status,
        ...(outcome.outcome ? { outcome: outcome.outcome } : {}),
      });
    } catch (error) {
      const failed = this.rt.runs.transition(run.id, "FAILED", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return { run: failed, stop: true };
    }

    const headCommit = await workspace.checkpoint(`jarvis: ${step.id} #${iteration} ${outcome.status}`, {
      "Jarvis-Run": run.id,
      "Jarvis-Step": step.id,
      "Jarvis-Iteration": String(iteration),
    });
    const iterations = { ...run.iterations };
    if (transition.edgeId) {
      const count = (iterations[transition.edgeId] ?? 0) + 1;
      const max = transition.maxIterations ?? 2;
      if (count > max) {
        const exhausted = this.rt.artifacts.put({
          runId: run.id,
          type: "loop-exhausted",
          name: `${transition.edgeId}.json`,
          content: JSON.stringify(
            {
              edge: transition.edgeId,
              iterations: count - 1,
              maxIterations: max,
              lastOutcome: outcome.outcome,
              reason: outcome.reason,
            },
            null,
            2,
          ),
          mediaType: "application/json",
          provenance: { kind: "tool", capability: "runtime.loop" },
          stepId: step.id,
          iteration,
        });
        this.rt.checkpoints.save({
          runId: run.id,
          stepId: step.id,
          iteration,
          kind: "step",
          ...(headCommit ? { headCommit } : {}),
          state: { loopExhausted: transition.edgeId },
        });
        const parked = this.rt.runs.transition(run.id, "WAITING_HUMAN", {
          reason: `back edge ${transition.edgeId} exhausted after ${max} iteration(s) (ADR-0004 §3)`,
          waitingFor: { kind: "loop", detail: transition.edgeId },
        });
        this.emit(parked, "workflow.loopExhausted", {
          edge: transition.edgeId,
          artifact: `${exhausted.artifactId}@${exhausted.version}`,
        });
        this.emit(parked, "run.state", { state: parked.state, reason: parked.stateReason });
        return { run: parked, stop: true };
      }
      iterations[transition.edgeId] = count;
      this.emit(run, "workflow.loop", {
        edge: transition.edgeId,
        iteration: count,
        max,
        reasons: outcome.reason,
      });
    }

    if (transition.to === STEP_DONE) {
      this.rt.checkpoints.save({
        runId: run.id,
        stepId: step.id,
        iteration,
        kind: "step",
        ...(headCommit ? { headCommit } : {}),
      });
      const done = this.rt.runs.transition(run.id, "COMPLETED", { reason: "workflow done" });
      this.emit(done, "run.state", { state: done.state });
      return { run: done, stop: true };
    }
    if (transition.to === STEP_FAIL) {
      this.rt.checkpoints.save({
        runId: run.id,
        stepId: step.id,
        iteration,
        kind: "step",
        ...(headCommit ? { headCommit } : {}),
      });
      const failed = this.rt.runs.transition(run.id, "FAILED", {
        reason: outcome.reason ?? `step ${step.id} failed`,
      });
      this.emit(failed, "run.state", { state: failed.state, reason: failed.stateReason });
      return { run: failed, stop: true };
    }

    const nextIteration = this.rt.history.list(run.id).filter((h) => h.stepId === transition.to).length + 1;
    const updated = this.rt.runs.update(run.id, {
      currentStep: transition.to,
      currentIteration: nextIteration,
      iterations,
    });
    this.rt.checkpoints.save({
      runId: run.id,
      stepId: transition.to,
      iteration: nextIteration,
      kind: "step",
      ...(headCommit ? { headCommit } : {}),
    });
    this.emit(updated, "step.next", { from: step.id, to: transition.to, iteration: nextIteration });
    return { run: updated, stop: false };
  }

  /* ---- entering and parking ---- */

  private enter(run: Run, workflow: WorkflowDefinition): Run {
    if (run.state === "CREATED") {
      // a run handed on from a shorter workflow starts where that one stopped (src/app/handoff.ts)
      const start =
        run.currentStep && workflow.steps.some((s) => s.id === run.currentStep)
          ? run.currentStep
          : workflow.entry;
      const started = this.rt.runs.update(run.id, { currentStep: start, currentIteration: 1 });
      const running = this.rt.runs.transition(started.id, "RUNNING", { reason: "started" });
      this.emit(running, "run.state", { state: running.state });
      return running;
    }
    if (run.state === "RUNNING") {
      // A previous holder died mid-step; its lease expired. Continue from the step the run is on.
      this.emit(run, "run.recovered", { stepId: run.currentStep });
      return run;
    }
    const resumed = this.rt.runs.transition(run.id, "RUNNING", { reason: `resumed from ${run.state}` });
    this.emit(resumed, "run.state", { state: resumed.state, reason: resumed.stateReason });
    return resumed;
  }

  /** ADR-0019 §5: review comments move with the workflow. */
  private reviewHooks(run: Run, step: StepDefinition, outcome: StepOutcome): void {
    if (step.agent === "review-analysis") {
      const ref = outcome.outputs?.[0];
      const [id, version] = (ref ?? "").split("@");
      const artifact = id ? this.rt.artifacts.get(id, Number(version)) : undefined;
      if (artifact && artifact.type === "review-analysis") {
        try {
          afterAnalysis(
            this.rt,
            run,
            JSON.parse(this.rt.artifacts.text(artifact)) as {
              comments?: Array<{ id: string; class: string; action?: string }>;
            },
          );
        } catch {
          // not JSON — nothing to classify
        }
      }
    }
    if (step.agent === "implementation") afterImplementation(this.rt, run);
  }

  private async park(
    run: Run,
    step: StepDefinition,
    iteration: number,
    suspend: SuspendRun,
    workspace: Workspace,
  ): Promise<Run> {
    const headCommit = await workspace.checkpoint(`jarvis: ${step.id} #${iteration} ${suspend.state}`, {
      "Jarvis-Run": run.id,
      "Jarvis-Step": step.id,
      "Jarvis-Iteration": String(iteration),
    });
    this.rt.checkpoints.save({
      runId: run.id,
      stepId: step.id,
      iteration,
      kind: "suspend",
      ...(headCommit ? { headCommit } : {}),
      state: {
        ...suspend.checkpointState,
        ...(suspend.resumeAfter ? { resumeAfter: suspend.resumeAfter.toISOString() } : {}),
      },
    });
    const parked = this.rt.runs.transition(run.id, suspend.state, {
      reason: suspend.reason,
      ...(suspend.waitingFor ? { waitingFor: suspend.waitingFor } : {}),
    });
    this.emit(parked, "run.state", {
      state: parked.state,
      reason: parked.stateReason,
      waitingFor: suspend.waitingFor,
      resumeAfter: suspend.resumeAfter?.toISOString(),
    });
    return parked;
  }

  /** Maps runtime errors to a parking decision (ADR-0001 §19, ADR-0002 §2, ADR-0018 §4). */
  private toSuspension(error: unknown): SuspendRun | undefined {
    if (error instanceof SuspendRun) return error;
    if (error instanceof ModelError && error.kind === "quota_exhausted") {
      const resumeAfter = new Date(this.clock().getTime() + (error.retryAfterMs ?? 60_000));
      return new SuspendRun("WAITING_BUDGET", error.message, {
        resumeAfter,
        checkpointState: { modelId: error.modelId },
      });
    }
    if (error instanceof UnresolvedEffectError) {
      return new SuspendRun("WAITING_HUMAN", error.message, {
        checkpointState: { unresolvedEffect: error.record.key },
        waitingFor: { kind: "effect", detail: error.record.capability },
      });
    }
    if (error instanceof BudgetExceededError) {
      return new SuspendRun("WAITING_HUMAN", error.message, {
        checkpointState: {
          budget: { scope: error.scope, dimension: error.dimension, used: error.used, cap: error.cap },
        },
        waitingFor: { kind: "budget", detail: `${error.scope} ${error.dimension}` },
      });
    }
    return undefined;
  }

  private emit(run: Run, kind: string, payload: Record<string, unknown>): void {
    this.rt.events.emit({
      kind,
      runId: run.id,
      ...(run.currentStep ? { stepId: run.currentStep } : {}),
      iteration: run.currentIteration,
      actor: `${run.owner.kind}:${run.owner.id}`,
      payload,
    });
  }
}

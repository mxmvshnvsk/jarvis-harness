import { COVERAGE_ACTOR } from "../agents/coverage.ts";
import { reasonOf } from "../app/activity.ts";
import { ANALYSIS_AGENTS, ARBITER_ACTOR, arbitrate } from "../app/arbiter.ts";
import { isAutonomous, noteAutonomy } from "../app/autonomy.ts";
import { type BudgetStop, grantBudget } from "../app/budgetStop.ts";
import { proposeGlossaryCandidates } from "../app/candidates.ts";
import { goOnRequested, rerunBackTo } from "../app/decide.ts";
import { DeliveryError, deliverPr, deliversItself, PR_REQUEST, prFlowOn, prOf } from "../app/deliver.ts";
import { proposeDriftCandidates } from "../app/knowledgeDrift.ts";
import { checkMasterBudget } from "../app/masterBudget.ts";
import { pausedText, pauseRequested } from "../app/pause.ts";
import { pendingRedo } from "../app/redo.ts";
import { proposeRepeatedFindings } from "../app/repeatedFindings.ts";
import { roundStop } from "../app/rounds.ts";
import type { Runtime } from "../app/runtime.ts";
import { checksAskOf, pauseAfterRequested } from "../app/steer.ts";
import { syncEditable } from "../artifacts/editable.ts";
import { BudgetExceededError, BudgetedGateway } from "../budget/runBudget.ts";
import { EXIT } from "../cli/output.ts";
import { onBehalfOfFromEnv } from "../core/actor/resolve.ts";
import { type Actor, formatActor, parseActorId } from "../core/domain/actor.ts";
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
import { noteEvalCandidate } from "../evals/candidates.ts";
import {
  type HandEditConflict,
  handEditConflict,
  openConflict,
  runCommitOf,
} from "../interaction/conflict.ts";
import { afterAnalysis, afterImplementation } from "../interaction/review/lifecycle.ts";
import { ModelError } from "../models/errors.ts";
import { effectMarker } from "../storage/effects.ts";
import { LeaseLostError } from "../storage/runStore.ts";
import { actingAs, currentActing } from "../telemetry/events.ts";
import { errorFields } from "../telemetry/log.ts";
import { git } from "../tools/local/exec.ts";
import { UnresolvedEffectError } from "./effects.ts";
import { AgenticExecutor, ApprovalExecutor, CompositeExecutor, DeterministicExecutor } from "./executors.ts";
import { InterruptedError, interruption } from "./interrupt.ts";
import { HeldLease, type HeldLeaseOptions } from "./lease.ts";
import { roundCostOf } from "./roundCost.ts";
import { relatedOn } from "./tools/related.ts";
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
  /**
   * Who drives this execution (ADR-0006 §2): the daemon resuming a run, a CI job; the run's owner when
   * unset. Every event of the execution names it, and the owner as `onBehalfOf` when it is not them.
   */
  readonly actor?: Actor;
  /** Whose run it is done for, when not the run's owner (CI: the change's author). */
  readonly onBehalfOf?: Actor;
}

/** Who acts in one execution, and for whom (ADR-0006 §2). */
interface Driver {
  readonly actor: Actor;
  readonly onBehalfOf?: Actor;
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
    case "SUSPENDED":
      return EXIT.interrupted;
    default:
      return EXIT.error;
  }
}

/** A run stopped with Ctrl-C keeps its place: SUSPENDED, `jarvis continue` goes on from it. */
function interrupted(): SuspendRun {
  return new SuspendRun("SUSPENDED", "interrupted with Ctrl-C; `jarvis continue` goes on from here");
}

export class LocalWorkflowEngine {
  private readonly rt: Runtime;
  private readonly workflows: ReadonlyMap<string, WorkflowDefinition>;
  private readonly executors: Record<StepExecutor["kind"], StepExecutor>;
  private readonly workspaces: WorkspaceFactory;
  private readonly leaseOptions: HeldLeaseOptions;
  private readonly clock: () => Date;
  /** The actor of each execution under way, by run: the delivery at its end acts as them. */
  private readonly drivers = new Map<string, Driver>();

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
        new CompositeExecutor((ctx, childId, skip) =>
          this.executeStep(
            ctx.run,
            ctx.workflow,
            findStep(ctx.workflow, childId),
            ctx.iteration,
            ctx.lease,
            ctx.workspace,
            skip,
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
    const driver = this.driverOf(this.rt.runs.require(runId), options);
    const onBehalfOf = driver.onBehalfOf ? formatActor(driver.onBehalfOf) : undefined;
    this.drivers.set(runId, driver);
    try {
      return await actingAs({ actor: formatActor(driver.actor), ...(onBehalfOf ? { onBehalfOf } : {}) }, () =>
        this.executeAs(runId, options),
      );
    } finally {
      this.drivers.delete(runId);
    }
  }

  /** The daemon acts for the run's owner; a CI job for the change's author when the job names one. */
  private driverOf(run: Run, options: ExecuteOptions): Driver {
    const actor = options.actor ?? run.owner;
    const fromEnv = actor.kind === "ci" ? onBehalfOfFromEnv(this.rt.env) : undefined;
    const behalf =
      options.onBehalfOf ??
      (formatActor(actor) !== formatActor(run.owner)
        ? run.owner
        : fromEnv
          ? parseActorId(fromEnv)
          : undefined);
    return { actor, ...(behalf && formatActor(behalf) !== formatActor(actor) ? { onBehalfOf: behalf } : {}) };
  }

  private async executeAs(runId: string, options: ExecuteOptions): Promise<ExecutionResult> {
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
        const runCommit = runCommitOf(this.rt, run.id);
        const humanEdit = await workspace.humanCheckpoint?.(run.owner.id);
        if (humanEdit)
          this.emit(run, "workspace.humanEdit", { commit: humanEdit.commit, files: humanEdit.files });
        // ADR-0019 §6.3: a hand edit of a file the step itself changed — the person decides first
        const conflict = await handEditConflict(this.rt, run, runCommit);
        if (conflict) {
          run = this.parkOnConflict(run, conflict);
          return { run, exitCode: exitCodeFor(run.state, run.stateReason) };
        }
        const head = humanEdit ? undefined : await this.headOf(workspace);
        if (humanEdit || (head && runCommit && head !== runCommit)) {
          // the person's commits made in the checkout are theirs as well: taken, not reset away
          const commit = humanEdit?.commit ?? (head as string);
          const files = humanEdit?.files ?? (await this.filesBetween(workspace, runCommit, commit));
          this.rt.checkpoints.save({
            runId: run.id,
            stepId: run.currentStep ?? "?",
            iteration: run.currentIteration,
            kind: "step",
            headCommit: commit,
            state: { humanEdit: files },
          });
          if (!humanEdit) this.emit(run, "workspace.humanEdit", { commit, files });
        } else {
          // ADR-0003 §3: the file state of a resumed run is exactly its last commit (an intra-step
          // checkpoint has none: it is not the base of the run)
          await workspace.restore(runCommit);
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
        if (this.deliveryPending(run)) {
          // the workflow was done; the run waited before its PR (an approval, the owner, an effect)
          run = await this.complete(run, step, iteration, lease, workspace, "workflow done");
          break;
        }
        if (interruption.requested) {
          // Ctrl-C between steps: park before the next one
          run = await this.park(run, step, iteration, interrupted(), workspace);
          break;
        }
        const pause = pauseRequested(this.rt, run.id);
        if (pause) {
          run = await this.park(
            run,
            step,
            iteration,
            new SuspendRun("SUSPENDED", pausedText(pause.by)),
            workspace,
          );
          break;
        }
        // «stop after this step»: the step asked about ended, the next one waits for the person
        const after = pauseAfterRequested(this.rt, run.id);
        if (after && (after.step !== step.id || after.iteration !== iteration)) {
          run = await this.park(
            run,
            step,
            iteration,
            new SuspendRun(
              "SUSPENDED",
              `paused after ${after.step}${after.iteration > 1 ? `#${after.iteration}` : ""}${after.by ? ` by ${after.by}` : ""}; Resume (or \`jarvis continue\`) goes on with ${step.id}`,
            ),
            workspace,
          );
          break;
        }
        let outcome: StepOutcome;
        try {
          outcome = await this.executeStep(run, workflow, step, iteration, lease, workspace);
        } catch (error) {
          const suspend = this.toSuspension(error, run);
          // an analysis that left gaps: one round to cover them by itself, no person asked (coverage.ts)
          const gapStop = suspend?.checkpointState?.budget as Record<string, unknown> | undefined;
          if (suspend?.waitingFor?.kind === "budget" && gapStop?.retry === true) {
            const cap = Number(gapStop.cap) || 20;
            this.rt.events.emit({
              kind: "budget.grant",
              runId: run.id,
              stepId: step.id,
              iteration,
              actor: COVERAGE_ACTOR,
              payload: {
                scope: "agent",
                dimension: "toolCalls",
                toolCalls: Math.max(5, Math.round(cap / 4)),
                modelCalls: 5,
                gaps: Array.isArray(gapStop.gaps) ? gapStop.gaps.length : 0,
                channel: "auto",
              },
            });
            continue;
          }
          // an autonomous run at a budget stop: its judge grants more and the step goes on, or the run ends
          if (suspend && isAutonomous(run) && suspend.waitingFor?.kind === "budget") {
            const judged = await this.judgeBudget(run, step, iteration, suspend);
            if (judged === "go-on") continue;
            if (judged) {
              run = judged;
              break;
            }
          }
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

        // a step that stopped on the cancel (an agent between its calls): the run is cancelled, not
        // failed — pilot: «Cancel» on the page left it FAILED, and its research could not go on again
        if (outcome.status === "failure" && this.rt.runs.require(run.id).cancelRequested) {
          this.emit(run, "step.finish", { stepId: step.id, iteration, status: "cancelled" });
          run = this.rt.runs.transition(run.id, "CANCELLED", { reason: "cancelled at a safe point" });
          this.emit(run, "run.state", { state: run.state });
          break;
        }
        const next = await this.advance(run, step, iteration, outcome, workspace, lease);
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
    skipBecause?: string,
  ): Promise<StepOutcome> {
    lease.check();
    const skip = skipBecause ?? this.skipReason(run, step, iteration);
    if (skip) {
      const historyId = this.rt.history.start(run.id, step.id, iteration, []);
      this.emit(run, "step.start", { stepId: step.id, iteration, kind: step.kind, inputs: [] });
      this.rt.history.finish(historyId, "success", "skipped", []);
      this.emit(run, "step.finish", { stepId: step.id, iteration, status: "skipped", reason: skip });
      return { status: "success" };
    }
    // ADR-0005 §3: a person's edit of a document in its file becomes the version this step reads
    this.syncEdits(run);
    const inputs = this.inputsFor(run, step);
    const restored = this.restoredState(run, step, iteration);
    const historyId = this.rt.history.start(run.id, step.id, iteration, inputs);
    this.emit(run, "step.start", { stepId: step.id, iteration, kind: step.kind, inputs });
    const models = this.rt.loaded.config.models;
    const gateway = new BudgetedGateway(
      this.rt.gateway,
      this.rt.db.db,
      this.rt.loaded.config,
      { runId: run.id, stepId: step.id, iteration },
      (modelId) => this.rt.budget.scaleNow(models[modelId]?.quotaPool ?? `model:${modelId}`),
      (modelId, at) => this.rt.budget.unlimitedAt(models[modelId]?.quotaPool ?? `model:${modelId}`, at),
      // a subtask spends its master's budget too: the sum of the subtasks' (ADR-0025 §6)
      run.options?.parent ? () => checkMasterBudget(this.rt, run) : undefined,
    );
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
      pauseRequested: () => pauseRequested(this.rt, run.id),
    };
    try {
      const outcome = await this.executors[step.kind].execute(ctx);
      this.syncEdits(run);
      if (step.kind === "agentic") {
        // files the agent made to try something out do not go into the run's commits
        const swept = (await workspace.sweepScratch?.()) ?? [];
        if (swept.length > 0)
          this.emit(run, "workspace.scratchRemoved", {
            stepId: step.id,
            iteration,
            files: swept.slice(0, 50),
          });
      }
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
      const suspend = this.toSuspension(error, run);
      this.rt.history.finish(historyId, suspend ? "suspended" : "failure", suspend?.state);
      throw error;
    }
  }

  /** Why a conditional step (`when:`) has nothing to do in this run; undefined when it runs. */
  private skipReason(run: Run, step: StepDefinition, iteration = 1): string | undefined {
    // ADR-0026: reading related work is the person's choice per run
    if ((step.tool === "related.collect" || step.tool === "related.check") && !relatedOn(this.rt, run))
      return "related work is off for this run";
    const affects = step.when?.affects;
    if (!affects) return undefined;
    // a later round fixes what review or checks found: the docs and telemetry of the first round
    // stand (pilot: each fix round wrote them again, minutes of model calls for the same text)
    if (iteration > 1 && step.outputs.some((t) => this.rt.artifacts.listLatest(run.id, t).length > 0))
      return "done in an earlier round: a fix round does not write it again";
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
    lease: HeldLease,
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

    // the subject says what the step found (`verify #3 → defects_found`), not only that it ran
    const found = outcome.outcome && outcome.outcome !== "success" ? outcome.outcome : undefined;
    const why = outcome.reason?.split("\n")[0]?.slice(0, 200);
    const headCommit = await workspace.checkpoint(
      `jarvis: ${step.id} #${iteration} ${found ? `→ ${found}` : outcome.status}`,
      {
        "Jarvis-Run": run.id,
        "Jarvis-Step": step.id,
        "Jarvis-Iteration": String(iteration),
        ...(found ? { "Jarvis-Outcome": found } : {}),
        ...(found && why ? { "Jarvis-Reason": why } : {}),
      },
    );
    const iterations = { ...run.iterations };
    if (transition.edgeId) {
      const count = (iterations[transition.edgeId] ?? 0) + 1;
      const max = transition.maxIterations ?? 2;
      // the round's checks failed as the round before, or no test ran: the person decides before the
      // next round is spent (src/app/rounds.ts); the rounds left stay for after their decision
      const stop =
        count > max || !this.runsChecks(run, step)
          ? undefined
          : roundStop(this.rt, run, iteration, checksAskOf(this.rt, run.id));
      if (count > max || stop) {
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
              // every round's reasons, not only the last: the next attempt (or the person) sees the
              // whole story of what went back and why (ADR-0004 §3)
              rounds: this.roundsOf(run.id, transition.edgeId, outcome),
              ...(stop ? { why: stop.why, round: stop.round, same: stop.same } : {}),
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
        if (isAutonomous(run)) {
          // nobody to decide: the run ends here, its rounds kept in the loop-exhausted document
          const reason = `autonomous: back edge ${transition.edgeId} exhausted after ${max} round(s) — nobody to decide; restart it from a step with a person`;
          noteAutonomy(this.rt, run, "stopped", { why: "loop", edge: transition.edgeId }, step.id);
          const failed = this.rt.runs.transition(run.id, "FAILED", { reason });
          this.emit(failed, "workflow.loopExhausted", {
            edge: transition.edgeId,
            artifact: `${exhausted.artifactId}@${exhausted.version}`,
          });
          this.emit(failed, "run.state", { state: failed.state, reason: failed.stateReason });
          return { run: failed, stop: true };
        }
        const parked = this.rt.runs.transition(run.id, "WAITING_HUMAN", {
          reason: stop
            ? `checks of round ${iteration} ${stop.why === "not-started" ? "ran no test" : stop.why === "same-failure" ? "failed as the round before" : "failed"}: a person decides before ${transition.edgeId} is taken again`
            : `back edge ${transition.edgeId} exhausted after ${max} iteration(s) (ADR-0004 §3)`,
          waitingFor: { kind: "loop", detail: transition.edgeId },
        });
        this.emit(parked, "workflow.loopExhausted", {
          edge: transition.edgeId,
          artifact: `${exhausted.artifactId}@${exhausted.version}`,
          ...(stop ? { why: stop.why } : {}),
        });
        this.emit(parked, "run.state", { state: parked.state, reason: parked.stateReason });
        return { run: parked, stop: true };
      }
      iterations[transition.edgeId] = count;
      this.emit(run, "workflow.loop", {
        edge: transition.edgeId,
        iteration: count,
        max,
        ...(outcome.outcome ? { outcome: outcome.outcome } : {}),
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
      return {
        run: await this.complete(run, step, iteration, lease, workspace, "workflow done"),
        stop: true,
      };
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

    const nextIteration = this.rt.history.nextIteration(run.id, transition.to);
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
    // ADR-0004 §5: a round the pool cannot pay for is not started, to stop halfway
    if (transition.edgeId) {
      const short = this.roundUnaffordable(updated, step.id, transition.to);
      if (short) {
        const target = this.workflow(run.workflow).steps.find((s) => s.id === transition.to) ?? step;
        return { run: await this.park(updated, target, nextIteration, short, workspace), stop: true };
      }
    }
    return { run: updated, stop: false };
  }

  /** The reasons of every round of an edge, oldest first, the one ending now last. */
  private roundsOf(
    runId: string,
    edge: string,
    outcome: StepOutcome,
  ): Array<{ round: number; outcome?: string; reason?: string }> {
    const past = this.rt.events
      .list({ runId, kind: "workflow.loop", limit: 10_000 })
      .filter((e) => e.payload?.edge === edge)
      .map((e, i) => ({
        round: i + 1,
        ...(typeof e.payload?.outcome === "string" ? { outcome: e.payload.outcome } : {}),
        ...(typeof e.payload?.reasons === "string" ? { reason: e.payload.reasons } : {}),
      }));
    return [
      ...past,
      {
        round: past.length + 1,
        ...(outcome.outcome ? { outcome: outcome.outcome } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      },
    ];
  }

  /** WAITING_BUDGET when the median past round of the loop does not fit what the pool has left. */
  private roundUnaffordable(run: Run, from: string, to: string): SuspendRun | undefined {
    const models = this.rt.loaded.config.models;
    const cost = roundCostOf(
      // the step starts and model calls only: on every back edge, every event of the run was read
      this.rt.events.list({ runId: run.id, kinds: ["step.start", "model.call"], limit: 1_000_000 }),
      this.workflow(run.workflow),
      { from, to },
      (modelId) => models[modelId]?.quotaPool ?? `model:${modelId}`,
    );
    if (!cost) return undefined;
    const decision = this.rt.budget.admit({ pool: cost.pool, estimatedOutputTokens: cost.outputTokens });
    if (decision.allowed) return undefined;
    return new SuspendRun(
      "WAITING_BUDGET",
      `one more round from ${to} costs about ${cost.outputTokens} output tokens (the median of ${cost.rounds}); pool ${cost.pool} has not that left: ${decision.reason ?? "its window is full"}`,
      { resumeAfter: decision.resetAt, checkpointState: { roundCost: cost } },
    );
  }

  /* ---- the end, and the delivery that may come with it (ADR-0003 §4) ---- */

  /**
   * COMPLETED — after the run's own PR when it delivers itself (`--deliver pr`, workflow `deliver: pr`).
   * The PR waiting for a person (an approval, the owner's credentials, an effect nobody can tell) parks
   * the run; one that cannot be made does not undo the work: the run completes and says why, and a
   * person creates the PR from its page.
   */
  private async complete(
    run: Run,
    step: StepDefinition,
    iteration: number,
    lease: HeldLease,
    workspace: Workspace,
    reason: string,
  ): Promise<Run> {
    let why = reason;
    // asked for (`--deliver pr`, the workflow's `deliver: pr`), or the PR flow (`delivery.flow`): a run
    // in the flow that has nothing to put up (no change, its own checkout) ends as before, said once
    const asked = deliversItself(run, this.workflow(run.workflow));
    const byFlow = !asked && prFlowOn(this.rt, run);
    if ((asked || byFlow) && !prOf(this.rt, run)) {
      const driver = this.drivers.get(run.id) ?? { actor: run.owner };
      try {
        await deliverPr(this.rt, run, {
          actor: driver.actor,
          ...(driver.onBehalfOf ? { onBehalfOf: driver.onBehalfOf } : {}),
          channel: "run",
          lease,
        });
        this.closeDeliveryThread(run);
      } catch (error) {
        const suspend = this.deliverySuspension(error, run, step, iteration);
        if (suspend) return this.park(run, step, iteration, suspend, workspace);
        if (error instanceof LeaseLostError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        this.closeDeliveryThread(run);
        if (byFlow && error instanceof DeliveryError && ["empty", "no-branch"].includes(error.code)) {
          this.emit(run, "delivery.skipped", { reason: message, code: error.code });
          const done = this.rt.runs.transition(run.id, "COMPLETED", { reason });
          this.emit(done, "run.state", { state: done.state });
          noteEvalCandidate(this.rt, done);
          this.completed(done);
          return done;
        }
        this.emit(run, "delivery.failed", {
          reason: message,
          ...(error instanceof DeliveryError ? { code: error.code } : {}),
        });
        why = `${reason}; no PR: ${message}`;
      }
    }
    const done = this.rt.runs.transition(run.id, "COMPLETED", { reason: why });
    this.emit(done, "run.state", { state: done.state, ...(why !== reason ? { reason: why } : {}) });
    noteEvalCandidate(this.rt, done);
    this.completed(done);
    return done;
  }

  /** The run's workflow is done and it waits before its own PR. */
  private deliveryPending(run: Run): boolean {
    return this.rt.checkpoints.latest(run.id)?.state.delivery === "pending";
  }

  /** Where the PR waits for a person, the run waits with it; undefined when it does not wait. */
  private deliverySuspension(
    error: unknown,
    run: Run,
    step: StepDefinition,
    iteration: number,
  ): SuspendRun | undefined {
    const pending = { delivery: "pending" };
    if (error instanceof DeliveryError && error.code === "approval" && error.request) {
      const request = error.request;
      const contentRef = `${request.artifactId}@${request.version}`;
      const thread =
        this.rt.interactions.openFor(run.id, "approval") ??
        this.rt.interactions.open({
          runId: run.id,
          kind: "approval",
          stepId: step.id,
          iteration,
          contentRef,
          openedBy: "runtime",
          meta: { artifactType: PR_REQUEST },
        });
      return new SuspendRun("WAITING_HUMAN", error.message, {
        checkpointState: {
          ...pending,
          awaitingApproval: { artifactId: request.artifactId, version: request.version, type: PR_REQUEST },
        },
        waitingFor: { kind: "approval", interactionId: thread.id, detail: PR_REQUEST },
      });
    }
    if (error instanceof DeliveryError && error.code === "credentials")
      return new SuspendRun("WAITING_HUMAN", error.message, { checkpointState: pending });
    const suspend = this.toSuspension(error, run);
    if (!suspend) return undefined;
    return new SuspendRun(suspend.state, suspend.reason, {
      ...(suspend.resumeAfter ? { resumeAfter: suspend.resumeAfter } : {}),
      ...(suspend.waitingFor ? { waitingFor: suspend.waitingFor } : {}),
      checkpointState: { ...suspend.checkpointState, ...pending },
    });
  }

  private closeDeliveryThread(run: Run): void {
    const open = this.rt.interactions.openFor(run.id, "approval");
    if (!open || open.meta?.artifactType !== PR_REQUEST) return;
    const request = this.rt.artifacts.listLatest(run.id, PR_REQUEST)[0];
    const decision = request ? this.rt.artifacts.approvalsFor(request.artifactId)[0] : undefined;
    this.rt.interactions.close(open.id, "resolved", decision?.actor.id ?? "human", open.contentRef);
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
    // a person sent the run back to a step (src/app/redo.ts): it goes on from there, a fresh round
    const redo = pendingRedo(this.rt, run.id);
    if (redo && workflow.steps.some((s) => s.id === redo.step)) {
      this.rt.runs.update(run.id, { currentStep: redo.step, currentIteration: redo.iteration });
      this.emit(run, "step.redo.applied", {
        step: redo.step,
        iteration: redo.iteration,
        from: run.currentStep,
      });
      if (run.state === "RUNNING") return this.rt.runs.get(run.id) ?? run;
    } else if (run.state === "RUNNING") {
      // A previous holder died mid-step; its lease expired. Continue from the step the run is on.
      this.emit(run, "run.recovered", { stepId: run.currentStep });
      return run;
    } else if (run.state === "WAITING_HUMAN" && run.waitingFor?.kind === "loop" && run.currentStep) {
      // a used-up back edge (ADR-0004 §3): the person fixed the checkout, the step runs again as a
      // fresh round — not the round that used the loop up, whose agents' state would be restored;
      // or the person asked the step the loop went back to for one more round
      const edge = run.waitingFor.detail ?? "";
      const back = rerunBackTo(this.rt, run.id);
      // «go on without it»: the step is taken as passed, the run goes where its success goes
      const goOn = goOnRequested(this.rt, run.id);
      const onSuccess = goOn
        ? workflow.steps.find((s) => s.id === run.currentStep)?.transitions.onSuccess
        : undefined;
      if (goOn && onSuccess === STEP_DONE) {
        const done = this.rt.runs.transition(run.id, "COMPLETED", {
          reason: "went on without the failed checks",
        });
        this.emit(done, "run.state", { state: done.state });
        noteEvalCandidate(this.rt, done);
        this.completed(done);
        return done;
      }
      const to =
        goOn && onSuccess && workflow.steps.some((s) => s.id === onSuccess)
          ? onSuccess
          : back && edge.includes(`->${back}#`)
            ? back
            : run.currentStep;
      const fresh = this.rt.history.nextIteration(run.id, to);
      this.rt.runs.update(run.id, { currentStep: to, currentIteration: fresh });
    }
    const resumed = this.rt.runs.transition(run.id, "RUNNING", { reason: `resumed from ${run.state}` });
    this.emit(resumed, "run.state", { state: resumed.state, reason: resumed.stateReason });
    return resumed;
  }

  /** The step runs the project's checks (writes `checks`): itself, or one of its children. */
  private runsChecks(run: Run, step: StepDefinition): boolean {
    const checks = (s: StepDefinition | undefined) =>
      s !== undefined && (s.tool === "project.checks" || s.outputs.includes("checks"));
    if (checks(step)) return true;
    if (step.kind !== "composite") return false;
    try {
      const wf = this.workflow(run.workflow);
      return (step.children ?? []).some((id) => checks(wf.steps.find((s) => s.id === id)));
    } catch {
      return false;
    }
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
    // ADR-0020 §6: an issue review found in another run too becomes a standard candidate
    const reviewed = (outcome.outputs ?? []).some((ref) => {
      const [id, version] = ref.split("@");
      return id ? this.rt.artifacts.get(id, Number(version))?.type === "review" : false;
    });
    if (reviewed) {
      try {
        proposeRepeatedFindings(this.rt, run);
      } catch (error) {
        // a candidate is a suggestion: failing to make one never stops the run
        this.rt.log.error("candidates.repeated", { runId: run.id, stepId: step.id, ...errorFields(error) });
      }
    }
  }

  /**
   * The budget judge of an autonomous run (src/app/arbiter.ts) on a stop: more — recorded as its grant,
   * the step goes on from its checkpoint; no — an analysis agent's run ends (a gap must not reach the
   * code), another agent finishes with what it has. Undefined: no judge here, the stop goes as before.
   */
  private async judgeBudget(
    run: Run,
    step: StepDefinition,
    iteration: number,
    suspend: SuspendRun,
  ): Promise<Run | "go-on" | undefined> {
    if (!this.rt.loaded.config.human.arbiter.enabled) return undefined;
    const b = suspend.checkpointState?.budget as Record<string, unknown> | undefined;
    if (!b) return undefined;
    const stop: BudgetStop = {
      scope: b.scope as BudgetStop["scope"],
      dimension: b.dimension as BudgetStop["dimension"],
      used: Number(b.used),
      cap: Number(b.cap),
      stepId: step.id,
      iteration,
      ...(typeof b.agent === "string" ? { agent: b.agent } : {}),
      suggested: 0,
      ...(Array.isArray(b.gaps) ? { gaps: b.gaps.filter((g): g is string => typeof g === "string") } : {}),
    };
    if (!Number.isFinite(stop.used) || !Number.isFinite(stop.cap)) return undefined;
    const decision = await arbitrate(this.rt, run, stop);
    const agent = stop.agent ?? step.agent;
    noteAutonomy(
      this.rt,
      run,
      "budget",
      {
        grant: decision.grant,
        ...(decision.amount ? { amount: decision.amount } : {}),
        scope: stop.scope,
        dimension: stop.dimension,
        used: stop.used,
        cap: stop.cap,
        diagnosis: decision.diagnosis,
        why: decision.why,
        by: decision.by,
        ...(agent ? { agent } : {}),
      },
      step.id,
    );
    if (decision.grant && decision.amount) {
      grantBudget(this.rt, run, stop, ARBITER_ACTOR, { more: decision.amount }, "auto");
      return "go-on";
    }
    if (agent && ANALYSIS_AGENTS.has(agent)) {
      const failed = this.rt.runs.transition(run.id, "FAILED", {
        reason: `autonomous: ${suspend.reason} — the budget judge said no: ${decision.why}`,
      });
      this.emit(failed, "run.state", { state: failed.state, reason: failed.stateReason });
      return failed;
    }
    // another agent: its result from what it has, marked incomplete — the checks after it judge it
    grantBudget(this.rt, run, stop, ARBITER_ACTOR, { finish: true }, "auto");
    return "go-on";
  }

  private async park(
    run: Run,
    step: StepDefinition,
    iteration: number,
    suspend: SuspendRun,
    workspace: Workspace,
  ): Promise<Run> {
    // a run that waits has its documents in files, ready to be edited
    this.syncEdits(run);
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
    if (isAutonomous(run) && suspend.waitingFor?.kind === "budget") {
      // a spent budget with nobody to grant more: the run ends with what it has, not half-delivered
      noteAutonomy(this.rt, run, "stopped", { why: "budget", detail: suspend.waitingFor.detail }, step.id);
      const failed = this.rt.runs.transition(run.id, "FAILED", {
        reason: `autonomous: ${suspend.reason} — nobody to grant more; restart it with a bigger budget or with a person`,
      });
      this.emit(failed, "run.state", { state: failed.state, reason: failed.stateReason });
      return failed;
    }
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

  /**
   * ADR-0019 §6.3: the run waits for the person's way out of a conflict with their hand edit. Nothing
   * is committed or checkpointed here: the next resume sees the same conflict until it is decided.
   */
  private parkOnConflict(run: Run, conflict: HandEditConflict): Run {
    const thread = openConflict(this.rt, run, conflict);
    // the state machine parks a running run: a resumed one is running for this moment
    const running =
      run.state === "RUNNING"
        ? run
        : this.rt.runs.transition(run.id, "RUNNING", { reason: `resumed from ${run.state}` });
    const parked = this.rt.runs.transition(running.id, "WAITING_HUMAN", {
      reason: `${conflict.files.length} file(s) changed both by ${run.currentStep} and by hand: ${conflict.files.slice(0, 5).join(", ")}`,
      waitingFor: { kind: "conflict", interactionId: thread.id, detail: conflict.files.join(", ") },
    });
    this.emit(parked, "run.state", {
      state: parked.state,
      reason: parked.stateReason,
      waitingFor: parked.waitingFor,
    });
    return parked;
  }

  private async headOf(workspace: Workspace): Promise<string | undefined> {
    if (workspace.ref.mode !== "worktree") return undefined;
    const r = await git(["rev-parse", "HEAD"], workspace.ref.path);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }

  private async filesBetween(workspace: Workspace, from: string | undefined, to: string): Promise<string[]> {
    if (!from) return [];
    const r = await git(["diff", "--name-only", from, to], workspace.ref.path);
    return r.code === 0 ? r.stdout.split("\n").filter(Boolean).sort() : [];
  }

  /** Maps runtime errors to a parking decision (ADR-0001 §19, ADR-0002 §2, ADR-0018 §4). */
  private toSuspension(error: unknown, run: Run): SuspendRun | undefined {
    if (error instanceof SuspendRun) return error;
    if (error instanceof InterruptedError) return interrupted();
    if (error instanceof ModelError && error.kind === "transient" && error.modelId) {
      return this.waitForModel(error, error.modelId, run);
    }
    if (error instanceof ModelError && error.kind === "quota_exhausted") {
      const resumeAfter = new Date(this.clock().getTime() + (error.retryAfterMs ?? 60_000));
      return new SuspendRun("WAITING_BUDGET", error.message, {
        resumeAfter,
        checkpointState: { modelId: error.modelId },
      });
    }
    if (error instanceof UnresolvedEffectError) {
      // what was tried and where its traces would be, for the person who decides (src/app/effects.ts)
      const record = error.record;
      this.rt.artifacts.put({
        runId: run.id,
        type: "effect-unresolved",
        name: `${record.key.slice(0, 12)}.json`,
        content: JSON.stringify(
          {
            capability: record.capability,
            step: record.stepId,
            iteration: record.iteration,
            startedAt: record.createdAt,
            args: this.rt.effects.args(record),
            marker: effectMarker(run.id, record.key),
            lookFor: `the text "${effectMarker(run.id, record.key)}" in the system ${record.capability} writes to (a comment, a commit trailer, a PR description)`,
            decide: [
              `jarvis effect ${run.id.slice(4, 12)} --happened   (it is there: go on without doing it again)`,
              `jarvis effect ${run.id.slice(4, 12)} --again      (it is not there: do it again)`,
            ],
          },
          null,
          2,
        ),
        mediaType: "application/json",
        provenance: { kind: "tool", capability: "runtime.effects" },
        stepId: record.stepId,
        iteration: record.iteration,
      });
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

  /**
   * The gateway gave up on a model after its retries (network errors, 5xx, timeouts): the run
   * waits for the model instead of failing — checked again in `modelWait.checkEveryMinutes`, by
   * `jarvis continue` in the foreground or the daemon — until it has been down for
   * `modelWait.giveUpAfterHours`. Pilot: a gateway slow for a whole afternoon failed run after run.
   */
  private waitForModel(error: ModelError, modelId: string, run: Run): SuspendRun | undefined {
    const wait = this.rt.loaded.config.modelWait;
    const now = this.clock().getTime();
    // the outage goes on when the run parked for it last and no step succeeded since
    const parkedAt = this.rt.checkpoints
      .list(run.id)
      .filter((c) => c.kind === "suspend")
      .at(-1);
    const lastSuccess = this.rt.history
      .list(run.id)
      .filter((h) => h.status === "success" && h.finishedAt)
      .at(-1)?.finishedAt;
    const previous =
      parkedAt && (!lastSuccess || parkedAt.createdAt > lastSuccess)
        ? (parkedAt.state.modelUnavailable as { since?: string; checks?: number } | undefined)
        : undefined;
    const since = previous?.since ?? new Date(now).toISOString();
    if (now - Date.parse(since) >= wait.giveUpAfterHours * 3_600_000) return undefined;
    const reason = reasonOf(error.message);
    return new SuspendRun("WAITING_BUDGET", `model ${modelId} is unavailable: ${reason}`, {
      resumeAfter: new Date(now + wait.checkEveryMinutes * 60_000),
      waitingFor: { kind: "model", detail: modelId },
      checkpointState: {
        modelId,
        modelUnavailable: { since, reason, checks: (previous?.checks ?? 0) + 1 },
      },
    });
  }

  /** The engine runs for the run's owner: an edit it finds is theirs (a gate decision syncs as its actor). */
  private syncEdits(run: Run): void {
    syncEditable(this.rt, run);
  }

  /** A completed run: the terms it linked to code become glossary candidates (ADR-0015 §3), the documents it found the code disagrees with — fixes. */
  private completed(run: Run): void {
    try {
      proposeGlossaryCandidates(this.rt, run);
    } catch (error) {
      // proposals are a by-product: a glossary that cannot be read never fails the run
      this.emit(run, "glossary.failed", { error: error instanceof Error ? error.message : String(error) });
    }
    try {
      proposeDriftCandidates(this.rt, run);
    } catch (error) {
      // a by-product too: a document that cannot be read never fails the run
      this.emit(run, "knowledge.drift.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private emit(run: Run, kind: string, payload: Record<string, unknown>): void {
    this.rt.events.emit({
      kind,
      runId: run.id,
      ...(run.currentStep ? { stepId: run.currentStep } : {}),
      iteration: run.currentIteration,
      // inside an execution its driver names itself (the daemon, for the owner); outside, the owner
      ...(currentActing() ? {} : { actor: formatActor(run.owner) }),
      payload,
    });
  }
}

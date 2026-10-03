import type { Runtime } from "../app/runtime.ts";
import type { Run } from "../core/domain/run.ts";
import { leaseOwner } from "./lease.ts";
import type { LocalWorkflowEngine } from "./runtime.ts";
import { LeaseHeldError } from "./types.ts";

/**
 * Daemon tick (ADR-0001 §3, ADR-0002 §5): resumes parked runs nobody holds —
 * WAITING_BUDGET once `resumeAfter` has passed, WAITING_HUMAN once the awaited approval exists.
 * FAILED and SUSPENDED runs are left to people.
 */
export interface TickReport {
  readonly at: string;
  readonly considered: number;
  readonly resumed: Array<{ runId: string; state: string; exitCode: number }>;
  readonly skipped: Array<{ runId: string; reason: string }>;
}

export interface DaemonOptions {
  readonly owner?: string;
  readonly clock?: () => Date;
}

export function resumeDecision(
  runtime: Runtime,
  run: Run,
  now: Date,
): { resume: true } | { resume: false; reason: string } {
  const checkpoint = runtime.checkpoints.latest(run.id);
  if (run.state === "WAITING_BUDGET") {
    const after =
      typeof checkpoint?.state.resumeAfter === "string"
        ? Date.parse(checkpoint.state.resumeAfter)
        : undefined;
    if (after !== undefined && after > now.getTime())
      return { resume: false, reason: `budget window frees at ${new Date(after).toISOString()}` };
    return { resume: true };
  }
  if (run.state === "WAITING_HUMAN") {
    const awaiting = checkpoint?.state.awaitingApproval as { artifactId?: string } | undefined;
    if (awaiting?.artifactId && runtime.artifacts.isApproved(awaiting.artifactId).approved)
      return { resume: true };
    // ADR-0019 §4: a clarification resolved through `jarvis answer` clears waitingFor.
    const clarification = checkpoint?.state.clarification as string | undefined;
    if (clarification && run.waitingFor === undefined) {
      const thread = runtime.interactions.get(clarification);
      if (thread?.state === "resolved") return { resume: true };
    }
    return { resume: false, reason: "waiting for a human decision" };
  }
  return { resume: false, reason: `${run.state} is not auto-resumed` };
}

export async function daemonTick(
  runtime: Runtime,
  engine: LocalWorkflowEngine,
  options: DaemonOptions = {},
): Promise<TickReport> {
  const now = options.clock?.() ?? new Date();
  const owner = options.owner ?? leaseOwner("daemon");
  const candidates = runtime.runs.resumable();
  const resumed: TickReport["resumed"] = [];
  const skipped: TickReport["skipped"] = [];
  for (const run of candidates) {
    const decision = resumeDecision(runtime, run, now);
    if (!decision.resume) {
      skipped.push({ runId: run.id, reason: decision.reason });
      continue;
    }
    try {
      const result = await engine.execute(run.id, { owner });
      resumed.push({ runId: run.id, state: result.run.state, exitCode: result.exitCode });
    } catch (error) {
      if (error instanceof LeaseHeldError) {
        skipped.push({ runId: run.id, reason: `held by ${error.heldBy}` });
        continue;
      }
      skipped.push({ runId: run.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const report: TickReport = { at: now.toISOString(), considered: candidates.length, resumed, skipped };
  runtime.events.emit({
    kind: "daemon.tick",
    actor: owner,
    payload: { considered: report.considered, resumed: resumed.length, skipped: skipped.length },
  });
  return report;
}

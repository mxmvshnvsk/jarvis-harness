import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import type { WorkflowDefinition } from "../core/domain/workflow.ts";
import type { Runtime } from "./runtime.ts";

/**
 * A finished `spec` (or `research`) run handed on to the full `sdd` workflow: the new run starts
 * where the shorter one stopped — after the approved specification — with its artifacts and
 * approvals, instead of researching and specifying again. Pilot: an approved spec ended the run and
 * there was no way on to the implementation without starting over.
 */
/** Kinds of artifacts that belong to the course of a run, not to its bookkeeping. */
const NOT_CARRIED = new Set(["candidate", "tool-output", "loop-exhausted", "invalid-output"]);

/** Where `target` goes on after the step `from` finished on, or undefined when it cannot. */
export function continuationStep(from: Run, target: WorkflowDefinition): string | undefined {
  if (from.state !== "COMPLETED" || !from.currentStep) return undefined;
  const last = target.steps.find((s) => s.id === from.currentStep);
  const next = last?.transitions.onSuccess;
  return next && next !== "DONE" && target.steps.some((s) => s.id === next) ? next : undefined;
}

/** The run that took this one on, if any. */
export function continuedBy(runtime: Runtime, from: Run): string | undefined {
  let found: string | undefined;
  for (const e of runtime.events.list({ kind: "run.created", limit: 100_000 })) {
    const p = (e.payload ?? {}) as { continuedFrom?: string };
    if (p.continuedFrom !== from.id || !e.runId) continue;
    // a continuation that was cancelled does not count: the approved spec can go on again
    // (pilot: an implementation cancelled while the gateway was down left its spec stranded)
    if (runtime.runs.get(e.runId)?.state === "CANCELLED") continue;
    found = e.runId;
  }
  return found;
}

/**
 * Copies the artifacts of `from` (latest versions) into the CREATED run `to`, with their approvals,
 * and points `to` at `startAt`: the engine enters the run there.
 */
export function handOff(runtime: Runtime, from: Run, to: Run, startAt: string): ArtifactVersion[] {
  const carried: ArtifactVersion[] = [];
  const latest = runtime.artifacts
    .listLatest(from.id)
    .filter((a) => !NOT_CARRIED.has(a.type))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const a of latest) {
    const copy = runtime.artifacts.put({
      runId: to.id,
      type: a.type,
      name: a.name,
      content: runtime.artifacts.content(a),
      provenance: { kind: "import", source: `run:${from.id}`, externalId: `${a.artifactId}@${a.version}` },
      sourceRefs: [`${a.artifactId}@${a.version}`],
      ...(a.stepId ? { stepId: a.stepId } : {}),
      iteration: 1,
    });
    const approval = runtime.artifacts.approvalsFor(a.artifactId, a.version)[0];
    if (approval?.decision === "approve")
      runtime.artifacts.approve({
        runId: to.id,
        stepId: approval.stepId,
        artifactId: copy.artifactId,
        version: copy.version,
        actor: approval.actor,
        decision: "approve",
        comment: `approved in run ${from.id}${approval.comment ? `: ${approval.comment}` : ""}`,
      });
    carried.push(copy);
  }
  runtime.runs.update(to.id, { currentStep: startAt, currentIteration: 1 });
  return carried;
}

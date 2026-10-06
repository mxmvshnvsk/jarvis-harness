import type { Approval } from "../artifacts/store.ts";
import type { Actor } from "../core/domain/actor.ts";
import type { ApprovalDecision, ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import type { Runtime } from "./runtime.ts";

/** What a run parked at an approval gate waits on: the latest version of the gated artifact. */
export function awaitedArtifact(
  runtime: Runtime,
  run: Run,
): { type: string; artifact: ArtifactVersion } | undefined {
  const checkpoint = runtime.checkpoints.latest(run.id);
  const awaiting = checkpoint?.state.awaitingApproval as { type?: string } | undefined;
  const type = awaiting?.type;
  if (!type) return undefined;
  const artifact = runtime.artifacts.listLatest(run.id, type)[0];
  return artifact ? { type, artifact } : undefined;
}

/**
 * A human decision on a gated artifact (ADR-0005 §4): stored with the approval and announced as
 * `approval.recorded`. Shared by `jarvis approve` and the interactive gate.
 */
export function recordDecision(
  runtime: Runtime,
  run: Run,
  input: {
    readonly actor: Actor;
    readonly artifact: ArtifactVersion;
    readonly type: string;
    readonly decision: ApprovalDecision;
    readonly comment?: string;
  },
): Approval {
  const checkpoint = runtime.checkpoints.latest(run.id);
  const approval = runtime.artifacts.approve({
    runId: run.id,
    stepId: checkpoint?.stepId ?? run.currentStep ?? "approve",
    artifactId: input.artifact.artifactId,
    version: input.artifact.version,
    actor: input.actor,
    decision: input.decision,
    ...(input.comment ? { comment: input.comment } : {}),
  });
  runtime.events.emit({
    kind: "approval.recorded",
    runId: run.id,
    stepId: approval.stepId,
    actor: `${input.actor.kind}:${input.actor.id}`,
    payload: {
      artifactId: input.artifact.artifactId,
      version: input.artifact.version,
      type: input.type,
      decision: input.decision,
    },
  });
  return approval;
}

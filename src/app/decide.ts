import { hostname } from "node:os";
import type { Approval } from "../artifacts/store.ts";
import type { Actor } from "../core/domain/actor.ts";
import type { ApprovalDecision, ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import type { StoredEvent } from "../telemetry/events.ts";
import type { Runtime } from "./runtime.ts";

/**
 * Where a decision was made (ADR-0023 §5): the terminal (`cli`: the card, `jarvis approve`) or the
 * page of `jarvis ui` (`ui`). One function records it whichever window it comes from.
 */
export type DecisionChannel = "cli" | "ui";

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

/** A second decision on a version already decided (ADR-0023 §4: one decision per version). */
export class DecisionTakenError extends Error {
  readonly approval: Approval;

  constructor(label: string, approval: Approval) {
    super(
      `${label} is already decided: ${approval.decision.replace("_", " ")} by ${approval.actor.id} at ${approval.createdAt.slice(0, 19).replace("T", " ")}`,
    );
    this.name = "DecisionTakenError";
    this.approval = approval;
  }
}

/**
 * A human decision on a gated artifact (ADR-0005 §4): stored with the approval and announced as
 * `approval.recorded`. Shared by `jarvis approve`, the interactive gate and `jarvis ui`; a version
 * takes one decision — a second one (a browser and a terminal both answering) is refused.
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
    readonly channel?: DecisionChannel;
  },
): Approval {
  const prior = runtime.artifacts.approvalsFor(input.artifact.artifactId, input.artifact.version)[0];
  if (prior)
    throw new DecisionTakenError(`${input.type}/${input.artifact.name}@${input.artifact.version}`, prior);
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
      channel: input.channel ?? "cli",
    },
  });
  return approval;
}

/** The decision on one version, with the window it came from (from its `approval.recorded`). */
export interface Decision {
  readonly approval: Approval;
  readonly channel?: DecisionChannel;
}

export function decisionOn(runtime: Runtime, artifact: ArtifactVersion): Decision | undefined {
  const approval = runtime.artifacts.approvalsFor(artifact.artifactId, artifact.version)[0];
  if (!approval) return undefined;
  const event = runtime.events
    .list({ runId: artifact.runId, kind: "approval.recorded", limit: 1000 })
    .findLast(
      (e) => e.payload?.artifactId === artifact.artifactId && e.payload?.version === artifact.version,
    );
  const channel = event?.payload?.channel;
  return { approval, ...(channel === "cli" || channel === "ui" ? { channel } : {}) };
}

/** The latest event of these kinds for a run, newest last in the journal. */
function lastOf(runtime: Runtime, runId: string, kind: string): StoredEvent | undefined {
  return runtime.events.list({ runId, kind, limit: 100_000 }).at(-1);
}

/** Where the run last stopped for a person: requests before it belong to an earlier stop. */
export function parkedAt(runtime: Runtime, runId: string): number {
  const parks = runtime.events
    .list({ runId, kind: "run.state", limit: 100_000 })
    .filter((e) => e.payload?.state === "WAITING_HUMAN");
  return parks.at(-1)?.seq ?? 0;
}

/**
 * "Run <step> again" on a used-up loop (the card's `r`, the page's button): recorded in the journal
 * with the actor, so the card waiting in a terminal goes on, or `jarvis continue` does it next.
 */
export function requestRerun(runtime: Runtime, run: Run, actor: Actor, channel: DecisionChannel): void {
  runtime.events.emit({
    kind: "loop.rerun",
    runId: run.id,
    ...(run.currentStep ? { stepId: run.currentStep } : {}),
    actor: `${actor.kind}:${actor.id}`,
    payload: { step: run.currentStep, channel },
  });
}

/** A "run again" asked since the run last stopped for a person, if any. */
export function rerunRequested(
  runtime: Runtime,
  runId: string,
): { actor?: string; channel?: DecisionChannel; seq: number } | undefined {
  const asked = lastOf(runtime, runId, "loop.rerun");
  if (!asked || asked.seq < parkedAt(runtime, runId)) return undefined;
  const channel = asked.payload?.channel;
  return {
    seq: asked.seq,
    ...(asked.actor ? { actor: asked.actor.replace(/^(user|service|ci):/, "") } : {}),
    ...(channel === "cli" || channel === "ui" ? { channel } : {}),
  };
}

/**
 * A card waiting in a terminal for this run (ADR-0023 §4): announced in the journal when it starts
 * asking and when it stops, so the page can say whether a decision goes on at once or waits for
 * `jarvis continue`. Returns the function that closes it.
 */
export function openCard(runtime: Runtime, run: Run, kind: "approval" | "loop" | "budget"): () => void {
  const payload = { kind, pid: process.pid, host: hostname() };
  runtime.events.emit({ kind: "card.open", runId: run.id, payload });
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try {
      runtime.events.emit({ kind: "card.closed", runId: run.id, payload });
    } catch {
      // the database is closing with the process: the pid check below covers it
    }
  };
}

/** The card waiting for this run in a live terminal of this machine, if there is one. */
export function waitingCard(runtime: Runtime, runId: string): { kind: string; since: string } | undefined {
  const open = lastOf(runtime, runId, "card.open");
  if (!open) return undefined;
  const closed = lastOf(runtime, runId, "card.closed");
  if (closed && closed.seq > open.seq) return undefined;
  const pid = Number(open.payload?.pid);
  if (open.payload?.host !== hostname() || !Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM: the process is there, it is someone else's
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return undefined;
  }
  return { kind: String(open.payload?.kind ?? "approval"), since: open.ts };
}

/**
 * Where a decision came from, for a terminal card's line: `in the browser`, `in another terminal`
 * (while the card waited), `in the terminal` (before it opened: `jarvis approve`).
 */
export function whereFrom(channel: DecisionChannel | undefined, before: boolean): string {
  if (channel === "ui") return "in the browser";
  if (channel === "cli") return before ? "in the terminal" : "in another terminal";
  return "elsewhere";
}

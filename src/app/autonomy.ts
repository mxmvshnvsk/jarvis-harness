import type { Actor } from "../core/domain/actor.ts";
import type { Run } from "../core/domain/run.ts";
import type { Runtime } from "./runtime.ts";

/**
 * An autonomous run (experimental): nobody is expected to answer, so where a run would wait for a
 * person it decides by a fixed rule and says so — a gate passes, an agent's question gets the most
 * cautious assumption written into the document, failed checks take every round, an agent at its
 * limit finishes with what it has, a task that reaches another service stays in this one. A dead end
 * — rounds used up, a budget spent, the agent still asking — ends the run as FAILED with the reason,
 * never a half-done result delivered. What protects the outside stays a person's: an effect after
 * untrusted internet content, an effect whose outcome is unknown, `delivery.pr: approve`.
 */
export function isAutonomous(run: Pick<Run, "options"> | undefined): boolean {
  return run?.options?.autonomous === true;
}

/** Who decides in an autonomous run: recorded as acting for the run's owner. */
export const AUTONOMOUS_ACTOR: Actor = {
  kind: "service",
  id: "autonomous",
  display: "autonomous run",
  verified: false,
};

/** The rule an agent's question gets when nobody can answer it. */
export const AUTONOMOUS_RULE =
  "Nobody can answer in this run (it is autonomous). Take the most cautious reading the sources support: change as little behaviour as possible and keep what exists. Write that choice in the document as an assumption, keep the question among its open questions, and go on.";

export const AUTONOMY_DECIDED = "autonomy.decided";

/** One decision taken without a person, in the run's journal and feed. */
export function noteAutonomy(
  runtime: Runtime,
  run: Pick<Run, "id" | "owner">,
  what: "gate" | "assumption" | "scope" | "contract" | "stopped",
  payload: Record<string, unknown>,
  stepId?: string,
): void {
  runtime.events.emit({
    kind: AUTONOMY_DECIDED,
    runId: run.id,
    ...(stepId ? { stepId } : {}),
    actor: `${AUTONOMOUS_ACTOR.kind}:${AUTONOMOUS_ACTOR.id}`,
    onBehalfOf: `${run.owner.kind}:${run.owner.id}`,
    payload: { what, ...payload },
  });
}

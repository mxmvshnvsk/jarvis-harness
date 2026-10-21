import type { Run } from "../core/domain/run.ts";
import { isAutonomous } from "./autonomy.ts";
import type { AskWhen } from "./rounds.ts";
import type { Runtime } from "./runtime.ts";

/**
 * Steering a run while it works (pilot: once implementation started, the only way in was Cancel):
 * «Ask me when tests fail» for this run — every failed check stops it, whatever the project says —
 * and «Stop after this step» — the run parks as paused when the step in flight ends, before the next
 * one starts. Both are journal events with the actor; the process running the run reads them.
 */
export const CHECKS_ASK = "run.checksAsk";
export const PAUSE_AFTER = "run.pauseAfter";

/** «Ask me when tests fail» on (`every-failure`) or off (back to the project's setting). */
export function setChecksAsk(runtime: Runtime, run: Pick<Run, "id">, on: boolean, actor: string): void {
  runtime.events.emit({
    kind: CHECKS_ASK,
    runId: run.id,
    actor,
    payload: { ask: on ? "every-failure" : null },
  });
}

/** This run's own setting, when a person set one. */
export function runChecksAsk(runtime: Runtime, runId: string): AskWhen | undefined {
  const last = runtime.events.list({ runId, kind: CHECKS_ASK, limit: 100_000 }).at(-1);
  const ask = last?.payload?.ask;
  return ask === "every-failure" || ask === "same-failure" || ask === "when-rounds-end" ? ask : undefined;
}

/** What failed checks do in this run: its own setting, else the project's. */
export function checksAskOf(runtime: Runtime, runId: string): AskWhen {
  // nobody to ask: every round is taken before the run stops (src/app/autonomy.ts)
  if (isAutonomous(runtime.runs.get(runId))) return "when-rounds-end";
  return runChecksAsk(runtime, runId) ?? runtime.loaded.config.human.checks.ask;
}

/** «Stop after this step»: the step and its round in flight now; `off` takes it back. */
export function requestPauseAfter(
  runtime: Runtime,
  run: Pick<Run, "id" | "currentStep" | "currentIteration">,
  actor: string,
  off = false,
): void {
  runtime.events.emit({
    kind: PAUSE_AFTER,
    runId: run.id,
    actor,
    payload: off ? { off: true } : { step: run.currentStep, iteration: run.currentIteration },
  });
}

/** A «stop after» asked since the run last stopped and not taken back: the step it waits for. */
export function pauseAfterRequested(
  runtime: Runtime,
  runId: string,
): { by?: string; step: string; iteration: number; seq: number } | undefined {
  const asked = runtime.events.list({ runId, kind: PAUSE_AFTER, limit: 100_000 }).at(-1);
  const p = asked?.payload as { off?: unknown; step?: unknown; iteration?: unknown } | undefined;
  if (!asked || p?.off === true || typeof p?.step !== "string" || typeof p.iteration !== "number")
    return undefined;
  const stopped = runtime.events
    .list({ runId, kind: "run.state", limit: 100_000 })
    .filter((e) => e.payload?.state !== "RUNNING")
    .at(-1);
  if (stopped && stopped.seq > asked.seq) return undefined;
  return {
    seq: asked.seq,
    step: p.step,
    iteration: p.iteration,
    ...(asked.actor ? { by: asked.actor.replace(/^(user|service|ci):/, "") } : {}),
  };
}

import type { Run } from "../core/domain/run.ts";
import type { Runtime } from "./runtime.ts";

/**
 * Pause from the page: the run stops at its next safe point — after the model or tool call in flight,
 * its conversation kept — and parks as SUSPENDED; Resume goes on from there. Pilot: «I want to do
 * something with the model on the side and put the main work off» — only Cancel was there.
 * Recorded as `run.pause` with the actor; the process that executes the run reads it at its safe points.
 */
export const PAUSE = "run.pause";

export function requestPause(runtime: Runtime, run: Run, actor: string, channel: "ui" | "cli"): void {
  runtime.events.emit({ kind: PAUSE, runId: run.id, actor, payload: { channel } });
}

/** A pause asked since the run last stopped, not honoured yet: who asked. */
export function pauseRequested(runtime: Runtime, runId: string): { by?: string; seq: number } | undefined {
  const asked = runtime.events.list({ runId, kind: PAUSE, limit: 100_000 }).at(-1);
  if (!asked) return undefined;
  const stopped = runtime.events
    .list({ runId, kind: "run.state", limit: 100_000 })
    .filter((e) => e.payload?.state !== "RUNNING")
    .at(-1);
  if (stopped && stopped.seq > asked.seq) return undefined;
  return { seq: asked.seq, ...(asked.actor ? { by: asked.actor.replace(/^(user|service|ci):/, "") } : {}) };
}

export function pausedText(by?: string): string {
  return `paused${by ? ` by ${by}` : ""}; Resume (or \`jarvis continue\`) goes on from here`;
}

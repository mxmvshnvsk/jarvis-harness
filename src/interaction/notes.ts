import type { Runtime } from "../app/runtime.ts";
import type { Run } from "../core/domain/run.ts";

/**
 * A person's note to a run while it works (the page's «Add a note»): binding for the agent of the step
 * running now — it gets the note before its next model call — and for every agent after it. Pilot: a
 * defect turned out to be a mistake in the spec, and there was no way to say so until the next gate.
 */
export interface RunNote {
  readonly seq: number;
  readonly stepId?: string;
  readonly text: string;
  readonly by: string;
  readonly at: string;
  /** The agent got it. */
  readonly delivered: boolean;
}

export const NOTE = "human.note";
export const NOTE_DELIVERED = "human.note.delivered";

export function notesOf(runtime: Runtime, runId: string): RunNote[] {
  const delivered = new Set(
    runtime.events
      .list({ runId, kind: NOTE_DELIVERED, limit: 10_000 })
      .map((e) => (e.payload as { seq?: unknown } | undefined)?.seq)
      .filter((s): s is number => typeof s === "number"),
  );
  return runtime.events.list({ runId, kind: NOTE, limit: 10_000 }).flatMap((e) => {
    const p = (e.payload ?? {}) as { text?: unknown; by?: unknown };
    if (typeof p.text !== "string" || !p.text.trim()) return [];
    return [
      {
        seq: e.seq,
        ...(e.stepId ? { stepId: e.stepId } : {}),
        text: p.text,
        by: typeof p.by === "string" ? p.by : "a person",
        at: e.ts,
        delivered: delivered.has(e.seq),
      },
    ];
  });
}

export function addNote(runtime: Runtime, run: Run, text: string, by: string): void {
  runtime.events.emit({
    kind: NOTE,
    runId: run.id,
    ...(run.currentStep ? { stepId: run.currentStep } : {}),
    actor: `user:${by}`,
    payload: { text: text.trim().slice(0, 4000), by },
  });
}

/** The notes as an agent reads them. */
export function notesText(notes: readonly RunNote[]): string {
  return notes.map((n) => `- from ${n.by}${n.stepId ? ` (during ${n.stepId})` : ""}: ${n.text}`).join("\n");
}

import type { EffectJournal, EffectRecord } from "../storage/effects.ts";
import type { EventSink } from "../telemetry/events.ts";
import type { HeldLease } from "./lease.ts";

/**
 * Runs one side effect under the journal protocol (ADR-0002 §2) with lease fencing (§5).
 *
 *   done     → return the stored result, never call the provider
 *   unknown  → verify(); found → done, not found → execute, undecidable → UnresolvedEffectError
 *   new      → record intended, execute, record done/failed
 */
export interface EffectExecution<T> {
  readonly runId: string;
  readonly stepId: string;
  readonly iteration: number;
  readonly capability: string;
  readonly args: unknown;
  readonly seq: number;
  /** Receives the journal record so providers can embed its key as a marker (ADR-0002 §3). */
  readonly execute: (record: EffectRecord) => Promise<T>;
  /** Provider-side check by marker (ADR-0002 §3). `undefined` = cannot tell. */
  readonly verify?: (record: EffectRecord) => Promise<T | undefined | "not-found">;
}

export class UnresolvedEffectError extends Error {
  readonly record: EffectRecord;
  constructor(record: EffectRecord) {
    super(
      `effect ${record.capability} (key ${record.key.slice(0, 12)}) has an unknown outcome and cannot be verified; human decision required (ADR-0002 §2)`,
    );
    this.name = "UnresolvedEffectError";
    this.record = record;
  }
}

export interface EffectOutcome<T> {
  readonly result: T;
  readonly record: EffectRecord;
  readonly source: "executed" | "journal" | "verified";
}

export async function runEffect<T>(
  journal: EffectJournal,
  lease: HeldLease,
  events: EventSink,
  execution: EffectExecution<T>,
): Promise<EffectOutcome<T>> {
  lease.check();
  const begun = journal.begin({
    runId: execution.runId,
    stepId: execution.stepId,
    iteration: execution.iteration,
    capability: execution.capability,
    args: execution.args,
    seq: execution.seq,
    leaseEpoch: lease.epoch,
  });
  const base = { runId: execution.runId, stepId: execution.stepId, iteration: execution.iteration };

  if (begun.status === "done") {
    events.emit({
      kind: "effect.replayed",
      ...base,
      payload: { capability: execution.capability, key: begun.record.key },
    });
    return { result: begun.result as T, record: begun.record, source: "journal" };
  }

  if (begun.status === "unknown") {
    const verified = execution.verify ? await execution.verify(begun.record) : undefined;
    if (verified !== undefined && verified !== "not-found") {
      const record = journal.complete(begun.record.id, verified);
      events.emit({
        kind: "effect.verified",
        ...base,
        payload: { capability: execution.capability, key: record.key },
      });
      return { result: verified, record, source: "verified" };
    }
    if (verified === undefined) {
      events.emit({
        kind: "effect.unresolved",
        ...base,
        payload: { capability: execution.capability, key: begun.record.key },
      });
      throw new UnresolvedEffectError(begun.record);
    }
    // Verified as not done: fall through and execute under the same record.
  }

  const record = begun.record;
  lease.check();
  try {
    const result = await execution.execute(record);
    const done = journal.complete(record.id, result);
    events.emit({
      kind: "effect.done",
      ...base,
      payload: { capability: execution.capability, key: done.key, leaseEpoch: lease.epoch },
    });
    return { result, record: done, source: "executed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = journal.fail(record.id, message);
    events.emit({
      kind: "effect.failed",
      ...base,
      payload: { capability: execution.capability, key: failed.key, error: message },
    });
    throw error;
  }
}

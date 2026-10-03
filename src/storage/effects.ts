import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BlobStore } from "../artifacts/blobs.ts";

/**
 * Effect journal (ADR-0002 §2): every side effect on an external system is recorded as `intended`
 * before it runs and `done` after, under an idempotency key, so a resumed run never repeats it.
 */
export type EffectStatus = "intended" | "done" | "failed" | "unknown";

export interface EffectRecord {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly iteration: number;
  readonly key: string;
  readonly capability: string;
  readonly argsRef?: string;
  readonly leaseEpoch: number;
  readonly status: EffectStatus;
  readonly resultRef?: string;
  readonly error?: string;
  readonly createdAt: string;
  readonly finishedAt?: string;
}

export interface EffectInput {
  readonly runId: string;
  readonly stepId: string;
  readonly iteration: number;
  readonly capability: string;
  readonly args: unknown;
  /** Sequence of this effect within the step; makes identical calls in one step distinct. */
  readonly seq: number;
  readonly leaseEpoch: number;
}

export type BeginResult =
  | { readonly status: "new"; readonly record: EffectRecord }
  | { readonly status: "done"; readonly record: EffectRecord; readonly result: unknown }
  | { readonly status: "unknown"; readonly record: EffectRecord };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

export function effectKey(input: Omit<EffectInput, "leaseEpoch">): string {
  const material = JSON.stringify([
    input.runId,
    input.stepId,
    input.iteration,
    input.capability,
    canonical(input.args),
    input.seq,
  ]);
  return createHash("sha256").update(material).digest("hex");
}

/** Marker placed in comments, PR descriptions and commit trailers (ADR-0002 §3). */
export function effectMarker(runId: string, key: string): string {
  return `jarvis:run=${runId} effect=${key.slice(0, 12)}`;
}

interface Row {
  id: string;
  run_id: string;
  step_id: string;
  iteration: number;
  key: string;
  capability: string;
  args_ref: string | null;
  lease_epoch: number;
  status: EffectStatus;
  result_ref: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

const COLUMNS =
  "id, run_id, step_id, iteration, key, capability, args_ref, lease_epoch, status, result_ref, error, created_at, finished_at";

function rowToRecord(r: Row): EffectRecord {
  return {
    id: r.id,
    runId: r.run_id,
    stepId: r.step_id,
    iteration: r.iteration,
    key: r.key,
    capability: r.capability,
    ...(r.args_ref ? { argsRef: r.args_ref } : {}),
    leaseEpoch: r.lease_epoch,
    status: r.status,
    ...(r.result_ref ? { resultRef: r.result_ref } : {}),
    ...(r.error ? { error: r.error } : {}),
    createdAt: r.created_at,
    ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
  };
}

export class EffectJournal {
  private readonly db: DatabaseSync;
  private readonly blobs: BlobStore;
  private readonly clock: () => Date;

  constructor(db: DatabaseSync, blobs: BlobStore, clock: () => Date = () => new Date()) {
    this.db = db;
    this.blobs = blobs;
    this.clock = clock;
  }

  byKey(key: string): EffectRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM effects WHERE key = ?`).get(key) as Row | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  get(id: string): EffectRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM effects WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  byRun(runId: string): EffectRecord[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM effects WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(runId) as unknown as Row[];
    return rows.map(rowToRecord);
  }

  /**
   * Step 1–3 of the protocol: a `done` record returns its result; `intended`/`unknown` means the
   * outcome must be verified; otherwise an `intended` record is written atomically.
   */
  begin(input: EffectInput): BeginResult {
    const key = effectKey(input);
    const existing = this.byKey(key);
    if (existing) {
      if (existing.status === "done") {
        const result = existing.resultRef
          ? (JSON.parse(this.blobs.getText(existing.resultRef)) as unknown)
          : undefined;
        return { status: "done", record: existing, result };
      }
      if (existing.status === "failed") {
        // A recorded failure may be retried: supersede it under the same key.
        this.db.prepare("DELETE FROM effects WHERE id = ?").run(existing.id);
      } else {
        if (existing.status === "intended") this.setStatus(existing.id, "unknown");
        return { status: "unknown", record: this.get(existing.id) as EffectRecord };
      }
    }
    const argsRef = this.blobs.put(
      JSON.stringify(canonical(input.args) ?? null),
      "application/json",
    ).contentRef;
    const id = `eff_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.db
      .prepare(
        `INSERT INTO effects (id, run_id, step_id, iteration, key, capability, args_ref, lease_epoch, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'intended', ?)`,
      )
      .run(
        id,
        input.runId,
        input.stepId,
        input.iteration,
        key,
        input.capability,
        argsRef,
        input.leaseEpoch,
        this.clock().toISOString(),
      );
    return { status: "new", record: this.get(id) as EffectRecord };
  }

  complete(id: string, result: unknown): EffectRecord {
    const resultRef = this.blobs.put(JSON.stringify(result ?? null), "application/json").contentRef;
    this.db
      .prepare(
        "UPDATE effects SET status = 'done', result_ref = ?, error = NULL, finished_at = ? WHERE id = ?",
      )
      .run(resultRef, this.clock().toISOString(), id);
    return this.get(id) as EffectRecord;
  }

  fail(id: string, error: string): EffectRecord {
    this.db
      .prepare("UPDATE effects SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .run(error.slice(0, 2000), this.clock().toISOString(), id);
    return this.get(id) as EffectRecord;
  }

  private setStatus(id: string, status: EffectStatus): void {
    this.db.prepare("UPDATE effects SET status = ? WHERE id = ?").run(status, id);
  }

  args(record: EffectRecord): unknown {
    return record.argsRef ? (JSON.parse(this.blobs.getText(record.argsRef)) as unknown) : undefined;
  }

  result(record: EffectRecord): unknown {
    return record.resultRef ? (JSON.parse(this.blobs.getText(record.resultRef)) as unknown) : undefined;
  }
}

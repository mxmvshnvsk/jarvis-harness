import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Checkpoints (ADR-0002 §4, ADR-0003 §3): a durable point a run resumes from. `state` is the
 * runtime's own snapshot (tool results so far, pending handoff), `headCommit` the workspace commit.
 */
export type CheckpointKind = "step" | "intra" | "suspend";

export interface Checkpoint {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly iteration: number;
  readonly kind: CheckpointKind;
  readonly headCommit?: string;
  readonly state: Record<string, unknown>;
  readonly createdAt: string;
}

export interface SaveCheckpointInput {
  readonly runId: string;
  readonly stepId: string;
  readonly iteration: number;
  readonly kind: CheckpointKind;
  readonly headCommit?: string;
  readonly state?: Record<string, unknown>;
}

interface Row {
  id: string;
  run_id: string;
  step_id: string;
  iteration: number;
  kind: CheckpointKind;
  head_commit: string | null;
  state_json: string;
  created_at: string;
}

function rowToCheckpoint(r: Row): Checkpoint {
  return {
    id: r.id,
    runId: r.run_id,
    stepId: r.step_id,
    iteration: r.iteration,
    kind: r.kind,
    ...(r.head_commit ? { headCommit: r.head_commit } : {}),
    state: JSON.parse(r.state_json) as Record<string, unknown>,
    createdAt: r.created_at,
  };
}

export class CheckpointStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => Date;

  constructor(db: DatabaseSync, clock: () => Date = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }

  save(input: SaveCheckpointInput): Checkpoint {
    const id = `ckp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const createdAt = this.clock().toISOString();
    this.db
      .prepare(
        "INSERT INTO checkpoints (id, run_id, step_id, iteration, kind, head_commit, state_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.runId,
        input.stepId,
        input.iteration,
        input.kind,
        input.headCommit ?? null,
        JSON.stringify(input.state ?? {}),
        createdAt,
      );
    return {
      id,
      runId: input.runId,
      stepId: input.stepId,
      iteration: input.iteration,
      kind: input.kind,
      ...(input.headCommit ? { headCommit: input.headCommit } : {}),
      state: input.state ?? {},
      createdAt,
    };
  }

  latest(runId: string): Checkpoint | undefined {
    const row = this.db
      .prepare(
        "SELECT id, run_id, step_id, iteration, kind, head_commit, state_json, created_at FROM checkpoints WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(runId) as Row | undefined;
    return row ? rowToCheckpoint(row) : undefined;
  }

  list(runId: string): Checkpoint[] {
    const rows = this.db
      .prepare(
        "SELECT id, run_id, step_id, iteration, kind, head_commit, state_json, created_at FROM checkpoints WHERE run_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .all(runId) as unknown as Row[];
    return rows.map(rowToCheckpoint);
  }
}

/* ---- step history (ADR-0004 §4, ADR-0005 §5) ---- */

export interface StepRecord {
  readonly id: number;
  readonly runId: string;
  readonly stepId: string;
  readonly iteration: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly status?: "success" | "failure";
  readonly outcome?: string;
  /** Exact `artifactId@version` references consumed and produced. */
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

export class StepHistoryStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => Date;

  constructor(db: DatabaseSync, clock: () => Date = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }

  start(runId: string, stepId: string, iteration: number, inputs: readonly string[] = []): number {
    const result = this.db
      .prepare(
        "INSERT INTO step_history (run_id, step_id, iteration, started_at, inputs_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(runId, stepId, iteration, this.clock().toISOString(), JSON.stringify(inputs));
    return Number(result.lastInsertRowid);
  }

  finish(id: number, status: "success" | "failure", outcome?: string, outputs: readonly string[] = []): void {
    this.db
      .prepare(
        "UPDATE step_history SET finished_at = ?, status = ?, outcome = ?, outputs_json = ? WHERE id = ?",
      )
      .run(this.clock().toISOString(), status, outcome ?? null, JSON.stringify(outputs), id);
  }

  list(runId: string): StepRecord[] {
    const rows = this.db
      .prepare(
        "SELECT id, run_id, step_id, iteration, started_at, finished_at, status, outcome, inputs_json, outputs_json FROM step_history WHERE run_id = ? ORDER BY id ASC",
      )
      .all(runId) as unknown as Array<{
      id: number;
      run_id: string;
      step_id: string;
      iteration: number;
      started_at: string;
      finished_at: string | null;
      status: "success" | "failure" | null;
      outcome: string | null;
      inputs_json: string;
      outputs_json: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      stepId: r.step_id,
      iteration: r.iteration,
      startedAt: r.started_at,
      ...(r.finished_at ? { finishedAt: r.finished_at } : {}),
      ...(r.status ? { status: r.status } : {}),
      ...(r.outcome ? { outcome: r.outcome } : {}),
      inputs: JSON.parse(r.inputs_json) as string[],
      outputs: JSON.parse(r.outputs_json) as string[],
    }));
  }
}

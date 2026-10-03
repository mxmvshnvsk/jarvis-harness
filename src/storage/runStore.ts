import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Actor } from "../core/domain/actor.ts";
import {
  assertTransition,
  isResumable,
  isTerminal,
  type Lease,
  type Run,
  RunSchema,
  type RunState,
  type WaitingFor,
  type WorkspaceRef,
} from "../core/domain/run.ts";

/** RunStore — the single source of truth for Run state (ADR-0011 §2), with the lease of ADR-0002 §5. */
export interface CreateRunInput {
  readonly id?: string;
  readonly task: string;
  readonly workflow: string;
  readonly owner: Actor;
  readonly workspace: WorkspaceRef;
  readonly dataClass: Run["dataClass"];
  readonly profile?: string;
}

export interface RunFilter {
  readonly state?: RunState | readonly RunState[];
  readonly task?: string;
  readonly includeTerminal?: boolean;
  readonly limit?: number;
}

export type LeaseResult =
  | { readonly ok: true; readonly lease: Lease }
  | { readonly ok: false; readonly heldBy: string; readonly until: string; readonly epoch: number };

export class RunNotFoundError extends Error {
  constructor(id: string) {
    super(`run "${id}" not found`);
    this.name = "RunNotFoundError";
  }
}

export class LeaseLostError extends Error {
  readonly runId: string;
  constructor(runId: string, detail: string) {
    super(`lease on run ${runId} lost: ${detail}`);
    this.name = "LeaseLostError";
    this.runId = runId;
  }
}

export class StaleStateError extends Error {
  constructor(id: string, expected: RunState, actual: RunState) {
    super(`run ${id} is ${actual}, expected ${expected}`);
    this.name = "StaleStateError";
  }
}

interface RunRow {
  id: string;
  task: string;
  workflow: string;
  state: RunState;
  state_reason: string | null;
  waiting_for_json: string | null;
  owner_json: string;
  workspace_json: string;
  current_step: string | null;
  current_iteration: number;
  iterations_json: string;
  data_class: Run["dataClass"];
  profile: string | null;
  lock_owner: string | null;
  lock_epoch: number;
  lock_until: string | null;
  cancel_requested: number;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  "id, task, workflow, state, state_reason, waiting_for_json, owner_json, workspace_json, current_step, current_iteration, iterations_json, data_class, profile, lock_owner, lock_epoch, lock_until, cancel_requested, created_at, updated_at";

function rowToRun(row: RunRow): Run {
  return RunSchema.parse({
    id: row.id,
    task: row.task,
    workflow: row.workflow,
    state: row.state,
    owner: JSON.parse(row.owner_json),
    workspace: JSON.parse(row.workspace_json),
    ...(row.current_step ? { currentStep: row.current_step } : {}),
    currentIteration: row.current_iteration,
    iterations: JSON.parse(row.iterations_json),
    dataClass: row.data_class,
    ...(row.profile ? { profile: row.profile } : {}),
    ...(row.lock_owner && row.lock_until
      ? { lease: { owner: row.lock_owner, epoch: row.lock_epoch, until: row.lock_until } }
      : {}),
    cancelRequested: row.cancel_requested === 1,
    ...(row.state_reason ? { stateReason: row.state_reason } : {}),
    ...(row.waiting_for_json ? { waitingFor: JSON.parse(row.waiting_for_json) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function newRunId(): string {
  return `run_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function shortRunId(id: string): string {
  return id.replace(/^run_/, "").slice(0, 8);
}

export class SqliteRunStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => Date;

  constructor(db: DatabaseSync, clock: () => Date = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }

  create(input: CreateRunInput): Run {
    const now = this.clock().toISOString();
    const id = input.id ?? newRunId();
    this.db
      .prepare(
        `INSERT INTO runs (id, task, workflow, state, owner_json, workspace_json, current_iteration, iterations_json, data_class, profile, created_at, updated_at)
         VALUES (?, ?, ?, 'CREATED', ?, ?, 1, '{}', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.task,
        input.workflow,
        JSON.stringify(input.owner),
        JSON.stringify(input.workspace),
        input.dataClass,
        input.profile ?? null,
        now,
        now,
      );
    return this.require(id);
  }

  get(id: string): Run | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  /** Resolves a full id or a unique prefix (with or without `run_`). */
  resolve(idOrPrefix: string): Run | undefined {
    const exact = this.get(idOrPrefix);
    if (exact) return exact;
    const needle = idOrPrefix.startsWith("run_") ? idOrPrefix : `run_${idOrPrefix}`;
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM runs WHERE id LIKE ? ORDER BY created_at DESC LIMIT 2`)
      .all(`${needle}%`) as unknown as RunRow[];
    if (rows.length !== 1) return undefined;
    return rowToRun(rows[0] as RunRow);
  }

  require(id: string): Run {
    const run = this.get(id);
    if (!run) throw new RunNotFoundError(id);
    return run;
  }

  list(filter: RunFilter = {}): Run[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filter.state) {
      const states = Array.isArray(filter.state) ? filter.state : [filter.state];
      clauses.push(`state IN (${states.map(() => "?").join(",")})`);
      params.push(...(states as string[]));
    } else if (!filter.includeTerminal) {
      clauses.push("state NOT IN ('COMPLETED','CANCELLED')");
    }
    if (filter.task) {
      clauses.push("task = ?");
      params.push(filter.task);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(filter.limit ?? 100);
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM runs ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params) as unknown as RunRow[];
    return rows.map(rowToRun);
  }

  /** State transition guarded by the state machine and, optionally, by the expected current state. */
  transition(
    id: string,
    to: RunState,
    options: { reason?: string; expectedState?: RunState; waitingFor?: WaitingFor } = {},
  ): Run {
    const run = this.require(id);
    if (options.expectedState && run.state !== options.expectedState)
      throw new StaleStateError(id, options.expectedState, run.state);
    assertTransition(run.state, to);
    const now = this.clock().toISOString();
    // waiting_for describes a WAITING_HUMAN state only; every other transition clears it.
    const waiting = to === "WAITING_HUMAN" && options.waitingFor ? JSON.stringify(options.waitingFor) : null;
    this.db
      .prepare(
        "UPDATE runs SET state = ?, state_reason = ?, waiting_for_json = ?, updated_at = ? WHERE id = ? AND state = ?",
      )
      .run(to, options.reason ?? null, waiting, now, id, run.state);
    return this.require(id);
  }

  setWaitingFor(id: string, waitingFor: WaitingFor | undefined): Run {
    this.db
      .prepare("UPDATE runs SET waiting_for_json = ?, updated_at = ? WHERE id = ?")
      .run(waitingFor ? JSON.stringify(waitingFor) : null, this.clock().toISOString(), id);
    return this.require(id);
  }

  update(
    id: string,
    patch: Partial<Pick<Run, "currentStep" | "currentIteration" | "iterations" | "stateReason">>,
  ): Run {
    const run = this.require(id);
    const now = this.clock().toISOString();
    this.db
      .prepare(
        "UPDATE runs SET current_step = ?, current_iteration = ?, iterations_json = ?, state_reason = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        patch.currentStep ?? run.currentStep ?? null,
        patch.currentIteration ?? run.currentIteration,
        JSON.stringify(patch.iterations ?? run.iterations),
        patch.stateReason ?? run.stateReason ?? null,
        now,
        id,
      );
    return this.require(id);
  }

  /* ---- lease (ADR-0002 §5) ---- */

  acquireLease(id: string, owner: string, ttlMs: number): LeaseResult {
    const run = this.require(id);
    const now = this.clock();
    const until = new Date(now.getTime() + ttlMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE runs SET lock_owner = ?, lock_epoch = lock_epoch + 1, lock_until = ?, updated_at = ?
         WHERE id = ? AND (lock_until IS NULL OR lock_until < ?)`,
      )
      .run(owner, until, now.toISOString(), id, now.toISOString());
    if (Number(result.changes) === 1) {
      const fresh = this.require(id);
      return { ok: true, lease: fresh.lease as Lease };
    }
    const lease = run.lease as Lease;
    return { ok: false, heldBy: lease.owner, until: lease.until, epoch: lease.epoch };
  }

  /** Extends the lease; false means it was taken by someone else — stop before the next effect. */
  renewLease(id: string, owner: string, epoch: number, ttlMs: number): boolean {
    const now = this.clock();
    const until = new Date(now.getTime() + ttlMs).toISOString();
    const result = this.db
      .prepare("UPDATE runs SET lock_until = ? WHERE id = ? AND lock_owner = ? AND lock_epoch = ?")
      .run(until, id, owner, epoch);
    return Number(result.changes) === 1;
  }

  releaseLease(id: string, owner: string, epoch: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE runs SET lock_owner = NULL, lock_until = NULL WHERE id = ? AND lock_owner = ? AND lock_epoch = ?",
      )
      .run(id, owner, epoch);
    return Number(result.changes) === 1;
  }

  /** `--steal`: takes the lease regardless of expiry; the caller records the actor (ADR-0002 §5). */
  stealLease(id: string, owner: string, ttlMs: number): Lease {
    const now = this.clock();
    const until = new Date(now.getTime() + ttlMs).toISOString();
    this.db
      .prepare(
        "UPDATE runs SET lock_owner = ?, lock_epoch = lock_epoch + 1, lock_until = ?, updated_at = ? WHERE id = ?",
      )
      .run(owner, until, now.toISOString(), id);
    return this.require(id).lease as Lease;
  }

  /** Fencing check before any effect: the caller's epoch must still be the current one. */
  assertLease(id: string, owner: string, epoch: number): void {
    const run = this.require(id);
    const lease = run.lease;
    if (!lease || lease.owner !== owner || lease.epoch !== epoch) {
      throw new LeaseLostError(
        id,
        lease ? `held by ${lease.owner} (epoch ${lease.epoch}), ours ${epoch}` : "no lease",
      );
    }
    if (Date.parse(lease.until) < this.clock().getTime()) throw new LeaseLostError(id, "expired");
  }

  /* ---- cancel (ADR-0002 §6) ---- */

  requestCancel(id: string): Run {
    const run = this.require(id);
    if (isTerminal(run.state)) return run;
    const now = this.clock();
    const liveLease = run.lease && Date.parse(run.lease.until) >= now.getTime();
    if (!liveLease) {
      // Nobody is executing: the transition happens immediately.
      this.db
        .prepare(
          "UPDATE runs SET state = 'CANCELLED', cancel_requested = 1, state_reason = ?, updated_at = ? WHERE id = ?",
        )
        .run("cancelled", now.toISOString(), id);
      return this.require(id);
    }
    this.db
      .prepare("UPDATE runs SET cancel_requested = 1, updated_at = ? WHERE id = ?")
      .run(now.toISOString(), id);
    return this.require(id);
  }

  /** Runs the daemon may pick up: resumable state and no live lease (ADR-0002 §5). */
  resumable(): Run[] {
    const now = this.clock().toISOString();
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM runs
         WHERE state IN ('WAITING_BUDGET','WAITING_HUMAN','SUSPENDED','FAILED') AND (lock_until IS NULL OR lock_until < ?)
         ORDER BY updated_at ASC`,
      )
      .all(now) as unknown as RunRow[];
    return rows.map(rowToRun).filter((r) => isResumable(r.state));
  }
}

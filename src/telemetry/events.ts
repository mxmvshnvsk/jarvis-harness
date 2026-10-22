import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

/** Append-only event log (ADR-0018 §2). Payloads must already be redacted (ADR-0010). */
export interface JarvisEvent {
  readonly kind: string;
  readonly runId?: string;
  readonly stepId?: string;
  readonly iteration?: number;
  readonly actor?: string;
  /** ADR-0006 §2: whose run the actor acts for when it is not the owner (the daemon resuming it). */
  readonly onBehalfOf?: string;
  readonly payload?: Record<string, unknown>;
  readonly ts?: string;
}

/** Who acts while some code runs: `user:…`, `service:daemon`, `ci:…`, and for whom. */
export interface ActingAs {
  readonly actor: string;
  readonly onBehalfOf?: string;
}

const acting = new AsyncLocalStorage<ActingAs>();

/**
 * Runs `fn` with `who` as the actor of every event emitted inside it that names none (ADR-0006 §2):
 * a model call or a tool call deep in a step is attributed without each emitter knowing the run.
 */
export function actingAs<T>(who: ActingAs, fn: () => T): T {
  return acting.run(who, fn);
}

export function currentActing(): ActingAs | undefined {
  return acting.getStore();
}

/**
 * The event as it is stored: the acting actor when it names none; `onBehalfOf` only when the actor is
 * the acting one — a person's decision recorded inside a daemon's tick is theirs, for nobody else.
 */
export function attributed(event: JarvisEvent, who: ActingAs | undefined = currentActing()): JarvisEvent {
  if (!who) return event;
  const actor = event.actor ?? who.actor;
  const onBehalfOf = event.onBehalfOf ?? (actor === who.actor ? who.onBehalfOf : undefined);
  return {
    ...event,
    actor,
    ...(onBehalfOf && onBehalfOf !== actor ? { onBehalfOf } : {}),
  };
}

export interface StoredEvent extends JarvisEvent {
  readonly seq: number;
  readonly ts: string;
}

export interface EventSink {
  emit(event: JarvisEvent): void;
}

export class SqliteEventStore implements EventSink {
  private readonly db: DatabaseSync;
  private tap: ((event: JarvisEvent) => void) | undefined;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Every stored event is also handed to `tap` (the technical log mirrors the journal). */
  setTap(tap: (event: JarvisEvent) => void): void {
    this.tap = tap;
  }

  emit(raw: JarvisEvent): void {
    const event = attributed(raw);
    this.db
      .prepare(
        `INSERT INTO events (ts, run_id, step_id, iteration, actor, on_behalf_of, kind, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.ts ?? new Date().toISOString(),
        event.runId ?? null,
        event.stepId ?? null,
        event.iteration ?? null,
        event.actor ?? null,
        event.onBehalfOf ?? null,
        event.kind,
        event.payload ? JSON.stringify(event.payload) : null,
      );
    try {
      this.tap?.(event);
    } catch {
      // the log never breaks the journal
    }
  }

  /** The newest sequence number (0 for an empty journal): where a live view starts following. */
  lastSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM events").get() as { seq: number | null };
    return row.seq ?? 0;
  }

  /** How many events of a run (of a kind) there are: a count, not the rows read and parsed. */
  count(options: { runId: string; kind?: string }): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE run_id = ?${options.kind ? " AND kind = ?" : ""}`)
      .get(...(options.kind ? [options.runId, options.kind] : [options.runId])) as { n: number };
    return row.n;
  }

  /**
   * Events after `afterSeq`, oldest first (used by `status --watch` and the TUI). `latest`: the last
   * `limit` of them rather than the first — still returned oldest first.
   */
  list(
    options: {
      runId?: string;
      afterSeq?: number;
      kind?: string;
      /** Several kinds at once (a run's step starts and model calls, not its every event). */
      kinds?: readonly string[];
      since?: string;
      limit?: number;
      latest?: boolean;
    } = {},
  ): StoredEvent[] {
    const clauses: string[] = ["seq > ?"];
    const params: Array<string | number> = [options.afterSeq ?? 0];
    if (options.runId) {
      clauses.push("run_id = ?");
      params.push(options.runId);
    }
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.kinds && options.kinds.length > 0) {
      clauses.push(`kind IN (${options.kinds.map(() => "?").join(", ")})`);
      params.push(...options.kinds);
    }
    if (options.since) {
      clauses.push("ts >= ?");
      params.push(options.since);
    }
    params.push(options.limit ?? 1000);
    const rows = this.db
      .prepare(
        `SELECT seq, ts, run_id, step_id, iteration, actor, on_behalf_of, kind, payload_json
         FROM events WHERE ${clauses.join(" AND ")} ORDER BY seq ${options.latest ? "DESC" : "ASC"} LIMIT ?`,
      )
      .all(...params) as Array<{
      seq: number;
      ts: string;
      run_id: string | null;
      step_id: string | null;
      iteration: number | null;
      actor: string | null;
      on_behalf_of: string | null;
      kind: string;
      payload_json: string | null;
    }>;
    if (options.latest) rows.reverse();
    return rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      kind: r.kind,
      ...(r.run_id ? { runId: r.run_id } : {}),
      ...(r.step_id ? { stepId: r.step_id } : {}),
      ...(r.iteration !== null ? { iteration: r.iteration } : {}),
      ...(r.actor ? { actor: r.actor } : {}),
      ...(r.on_behalf_of ? { onBehalfOf: r.on_behalf_of } : {}),
      ...(r.payload_json ? { payload: JSON.parse(r.payload_json) as Record<string, unknown> } : {}),
    }));
  }
}

export class MemoryEventStore implements EventSink {
  readonly events: JarvisEvent[] = [];

  emit(raw: JarvisEvent): void {
    const event = attributed(raw);
    this.events.push({ ...event, ts: event.ts ?? new Date().toISOString() });
  }
}

import type { DatabaseSync } from "node:sqlite";

/** Append-only event log (ADR-0018 §2). Payloads must already be redacted (ADR-0010). */
export interface JarvisEvent {
  readonly kind: string;
  readonly runId?: string;
  readonly stepId?: string;
  readonly iteration?: number;
  readonly actor?: string;
  readonly payload?: Record<string, unknown>;
  readonly ts?: string;
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

  emit(event: JarvisEvent): void {
    this.db
      .prepare(
        `INSERT INTO events (ts, run_id, step_id, iteration, actor, kind, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.ts ?? new Date().toISOString(),
        event.runId ?? null,
        event.stepId ?? null,
        event.iteration ?? null,
        event.actor ?? null,
        event.kind,
        event.payload ? JSON.stringify(event.payload) : null,
      );
    try {
      this.tap?.(event);
    } catch {
      // the log never breaks the journal
    }
  }

  /** Events after `afterSeq`, oldest first (used by `status --watch` and the TUI). */
  list(options: { runId?: string; afterSeq?: number; kind?: string; limit?: number } = {}): StoredEvent[] {
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
    params.push(options.limit ?? 1000);
    const rows = this.db
      .prepare(
        `SELECT seq, ts, run_id, step_id, iteration, actor, kind, payload_json
         FROM events WHERE ${clauses.join(" AND ")} ORDER BY seq ASC LIMIT ?`,
      )
      .all(...params) as Array<{
      seq: number;
      ts: string;
      run_id: string | null;
      step_id: string | null;
      iteration: number | null;
      actor: string | null;
      kind: string;
      payload_json: string | null;
    }>;
    return rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      kind: r.kind,
      ...(r.run_id ? { runId: r.run_id } : {}),
      ...(r.step_id ? { stepId: r.step_id } : {}),
      ...(r.iteration !== null ? { iteration: r.iteration } : {}),
      ...(r.actor ? { actor: r.actor } : {}),
      ...(r.payload_json ? { payload: JSON.parse(r.payload_json) as Record<string, unknown> } : {}),
    }));
  }
}

export class MemoryEventStore implements EventSink {
  readonly events: JarvisEvent[] = [];

  emit(event: JarvisEvent): void {
    this.events.push({ ...event, ts: event.ts ?? new Date().toISOString() });
  }
}

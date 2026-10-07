import type { DatabaseSync } from "node:sqlite";
import type { QuotaPool } from "../core/config/schema.ts";

/** One model call's cost, recorded per pool (ADR-0018 §5). */
export interface UsageRecord {
  readonly pool: string;
  readonly model: string;
  readonly runId?: string;
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly ts?: Date;
}

export interface WindowUsage {
  readonly pool: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly requests: number;
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  /** Oldest record inside the window; the sliding window frees budget when it expires. */
  readonly oldestTs?: Date;
}

export interface UsageStore {
  record(usage: UsageRecord): void;
  /** `since`: nothing before it counts (the end of the pool's unlimited hours). */
  windowUsage(pool: string, definition: QuotaPool, now?: Date, since?: Date): WindowUsage;
}

/** Window bounds: sliding = now − minutes; fixed = aligned to multiples of the window since epoch. */
export function windowBounds(definition: QuotaPool, now: Date, since?: Date): { start: Date; end: Date } {
  const ms = definition.window.minutes * 60_000;
  const from = (start: number) => new Date(since && since.getTime() > start ? since.getTime() : start);
  if (definition.window.kind === "fixed") {
    const start = Math.floor(now.getTime() / ms) * ms;
    return { start: from(start), end: new Date(start + ms) };
  }
  return { start: from(now.getTime() - ms), end: now };
}

export class SqliteUsageStore implements UsageStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  record(usage: UsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO usage_window (pool, ts, model, run_id, prompt_tokens, cached_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        usage.pool,
        (usage.ts ?? new Date()).toISOString(),
        usage.model,
        usage.runId ?? null,
        usage.promptTokens,
        usage.cachedTokens,
        usage.outputTokens,
      );
  }

  windowUsage(pool: string, definition: QuotaPool, now: Date = new Date(), since?: Date): WindowUsage {
    const { start, end } = windowBounds(definition, now, since);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(prompt_tokens), 0) AS prompt,
                COALESCE(SUM(cached_tokens), 0) AS cached,
                COALESCE(SUM(output_tokens), 0) AS output,
                MIN(ts) AS oldest
         FROM usage_window WHERE pool = ? AND ts > ? AND ts <= ?`,
      )
      .get(pool, start.toISOString(), end.toISOString()) as {
      requests: number;
      prompt: number;
      cached: number;
      output: number;
      oldest: string | null;
    };
    return {
      pool,
      windowStart: start,
      windowEnd: end,
      requests: row.requests,
      promptTokens: row.prompt,
      cachedTokens: row.cached,
      outputTokens: row.output,
      ...(row.oldest ? { oldestTs: new Date(row.oldest) } : {}),
    };
  }

  /** Folds rows older than 2 × window into hourly aggregates is a later concern; prune for now. */
  prune(pool: string, definition: QuotaPool, now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - 2 * definition.window.minutes * 60_000).toISOString();
    const result = this.db.prepare("DELETE FROM usage_window WHERE pool = ? AND ts <= ?").run(pool, cutoff);
    return Number(result.changes);
  }
}

export class MemoryUsageStore implements UsageStore {
  readonly records: Array<UsageRecord & { ts: Date }> = [];

  record(usage: UsageRecord): void {
    this.records.push({ ...usage, ts: usage.ts ?? new Date() });
  }

  windowUsage(pool: string, definition: QuotaPool, now: Date = new Date(), since?: Date): WindowUsage {
    const { start, end } = windowBounds(definition, now, since);
    const rows = this.records.filter((r) => r.pool === pool && r.ts > start && r.ts <= end);
    const oldest = rows.reduce<Date | undefined>(
      (a, r) => (a === undefined || r.ts < a ? r.ts : a),
      undefined,
    );
    return {
      pool,
      windowStart: start,
      windowEnd: end,
      requests: rows.length,
      promptTokens: rows.reduce((a, r) => a + r.promptTokens, 0),
      cachedTokens: rows.reduce((a, r) => a + r.cachedTokens, 0),
      outputTokens: rows.reduce((a, r) => a + r.outputTokens, 0),
      ...(oldest ? { oldestTs: oldest } : {}),
    };
  }
}

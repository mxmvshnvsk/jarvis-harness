import type { DatabaseSync } from "node:sqlite";
import type { McpCallResult } from "../types.ts";

/**
 * Calls per minute to an MCP server (`mcp.servers.<id>.rateLimit.rpm`), counted for the user across
 * every process — runs side by side, the daemon, the UI — in the database: a limit per user (pilot:
 * Jira's 200 RPM) is not kept by counting per process. A call past it waits for the minute to free.
 */
export class McpRateLimiter {
  private readonly db: DatabaseSync;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(db: DatabaseSync, options: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {}) {
    this.db = db;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? Date.now;
  }

  /** Takes a place in the server's minute; waits when it is full. `onWait` hears how long, once. */
  async acquire(serverId: string, rpm: number, onWait?: (ms: number) => void): Promise<void> {
    if (rpm <= 0) return;
    let told = false;
    for (;;) {
      const wait = this.take(serverId, rpm);
      if (wait === 0) return;
      if (!told) onWait?.(wait);
      told = true;
      await this.sleep(wait);
    }
  }

  /** 0 when a place was taken, else how long until the oldest call of the minute leaves it. */
  private take(serverId: string, rpm: number): number {
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM mcp_calls WHERE server = ? AND ts > ?")
        .get(serverId, now - MINUTE) as { n: number; oldest: number | null };
      if (row.n >= rpm) {
        this.db.exec("COMMIT");
        return Math.max(50, (row.oldest ?? now) + MINUTE - now + 10);
      }
      this.db.prepare("INSERT INTO mcp_calls (server, ts) VALUES (?, ?)").run(serverId, now);
      this.db.prepare("DELETE FROM mcp_calls WHERE server = ? AND ts <= ?").run(serverId, now - 2 * MINUTE);
      this.db.exec("COMMIT");
      return 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const MINUTE = 60_000;

/** A server's «too many requests» (HTTP 429), as an MCP tool's failed answer words it. */
export function tooManyRequests(result: McpCallResult): boolean {
  return !result.ok && /\b429\b|too many requests|rate[- ]?limit(ed)? exceeded/i.test(result.text);
}

/** Seconds the answer says to wait (`Retry-After: 12`, «retry after 12 s»), when it says. */
export function retryAfterOf(text: string): number | undefined {
  const m = /retry[-_ ]?after["':\s]*(\d+(?:\.\d+)?)/i.exec(text);
  return m ? Math.ceil(Number(m[1])) : undefined;
}

/** Tries after a 429, and the waits between them when the server names none (seconds). */
export const RETRY_WAITS = [2, 4, 8, 16] as const;
/** A wait longer than this is not waited out in the call: the answer says so instead. */
export const RETRY_WAIT_MAX_S = 60;

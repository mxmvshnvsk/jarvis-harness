import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpCallResult } from "../types.ts";

/**
 * What MCP servers answered, kept on disk (`~/.jarvis/cache/mcp-results/<server>/`): a read a profile
 * marks cacheable (a design frame) is answered from here within its time, and a server that said
 * "not before" (429 with Retry-After) is not asked again until then. Pilot: a personal Figma seat has
 * 20 file reads a month; a run spent 7 of them on 429s, and every rerun read the same frames again.
 */
export class McpResultStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private serverDir(serverId: string): string {
    return join(this.dir, serverId.replace(/[^A-Za-z0-9_.-]/g, "_"));
  }

  static key(parts: unknown): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
  }

  get(serverId: string, key: string, ttlMs: number, now = Date.now()): McpCallResult | undefined {
    const file = join(this.serverDir(serverId), `${key}.json`);
    if (!existsSync(file)) return undefined;
    try {
      const entry = JSON.parse(readFileSync(file, "utf8")) as { at: string; result: McpCallResult };
      return now - Date.parse(entry.at) <= ttlMs ? entry.result : undefined;
    } catch {
      return undefined;
    }
  }

  put(serverId: string, key: string, result: McpCallResult, now = Date.now()): void {
    const dir = this.serverDir(serverId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key}.json`), JSON.stringify({ at: new Date(now).toISOString(), result }));
  }

  /** The server asked not to be called before this moment; undefined when it may be. */
  blockedUntil(serverId: string, now = Date.now()): { until: string; reason: string } | undefined {
    const file = join(this.serverDir(serverId), "blocked.json");
    if (!existsSync(file)) return undefined;
    try {
      const b = JSON.parse(readFileSync(file, "utf8")) as { until: string; reason: string };
      return Date.parse(b.until) > now ? b : undefined;
    } catch {
      return undefined;
    }
  }

  block(serverId: string, seconds: number, reason: string, now = Date.now()): string {
    const dir = this.serverDir(serverId);
    mkdirSync(dir, { recursive: true });
    const until = new Date(now + seconds * 1000).toISOString();
    writeFileSync(join(dir, "blocked.json"), JSON.stringify({ until, reason }));
    return until;
  }
}

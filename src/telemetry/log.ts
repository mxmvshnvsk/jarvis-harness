import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { describeCauses } from "../core/errorCause.ts";

/**
 * Technical log (ADR-0018): NDJSON files, one per day, in `<home>/logs`. It mirrors the event journal
 * (so a crash that never reached the database is still visible), adds what events must not carry —
 * model requests and responses, tool results, stack traces — and is redacted like everything else.
 *
 * Levels (`JARVIS_LOG`): off | error | info (default: every event + invocations) | debug (adds the
 * bodies: prompts as deltas, model replies, tool arguments and results).
 */
export type LogLevel = "off" | "error" | "info" | "debug";

const RANK: Record<LogLevel, number> = { off: 0, error: 1, info: 2, debug: 3 };

export interface LogRecord {
  readonly ts: string;
  readonly level: Exclude<LogLevel, "off">;
  readonly event: string;
  readonly runId?: string;
  readonly stepId?: string;
  readonly iteration?: number;
  readonly [field: string]: unknown;
}

export interface LoggerOptions {
  readonly dir: string;
  readonly level: LogLevel;
  /** Applied to every string before it is written. */
  readonly redact?: (text: string) => string;
  readonly keepDays?: number;
  /** Longest string value kept in a record; longer ones are cut with a marker. */
  readonly maxField?: number;
  readonly clock?: () => Date;
}

export const DEFAULT_KEEP_DAYS = 14;
export const DEFAULT_MAX_FIELD = 20_000;

export function logLevelFrom(env: NodeJS.ProcessEnv): LogLevel {
  const raw = (env.JARVIS_LOG ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "none" || raw === "0" || raw === "false") return "off";
  if (raw === "error" || raw === "info" || raw === "debug") return raw;
  if (raw === "trace" || raw === "verbose") return "debug";
  return "info";
}

export function logSettingsFrom(env: NodeJS.ProcessEnv): { keepDays: number; maxField: number } {
  const keep = Number(env.JARVIS_LOG_KEEP_DAYS);
  const max = Number(env.JARVIS_LOG_MAX_FIELD);
  return {
    keepDays: Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : DEFAULT_KEEP_DAYS,
    maxField: Number.isFinite(max) && max >= 200 ? Math.floor(max) : DEFAULT_MAX_FIELD,
  };
}

/** Error → plain fields (message and stack are the point of a technical log). */
export function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const extra = error as unknown as { status?: unknown; code?: unknown };
    const causes = describeCauses(error);
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      ...(typeof extra.code === "string" ? { code: extra.code } : {}),
      ...(causes !== undefined ? { cause: causes } : {}),
      ...(typeof extra.status === "number" ? { status: extra.status } : {}),
    };
  }
  return { message: String(error) };
}

export class Logger {
  readonly level: LogLevel;
  readonly dir: string;
  private readonly redact: (text: string) => string;
  private readonly maxField: number;
  private readonly clock: () => Date;
  private readonly keepDays: number;
  private pruned = false;
  /** Per call stream: hashes of the messages already written, so a prompt is logged as a delta. */
  private readonly prompts = new Map<string, string[]>();

  constructor(options: LoggerOptions) {
    this.level = options.level;
    this.dir = options.dir;
    this.redact = options.redact ?? ((s) => s);
    this.maxField = options.maxField ?? DEFAULT_MAX_FIELD;
    this.keepDays = options.keepDays ?? DEFAULT_KEEP_DAYS;
    this.clock = options.clock ?? (() => new Date());
  }

  enabled(level: Exclude<LogLevel, "off">): boolean {
    return RANK[this.level] >= RANK[level];
  }

  /** Path of today's file. */
  get file(): string {
    return join(this.dir, `jarvis-${this.clock().toISOString().slice(0, 10)}.ndjson`);
  }

  log(level: Exclude<LogLevel, "off">, event: string, fields: Record<string, unknown> = {}): void {
    if (!this.enabled(level)) return;
    try {
      const record = { ts: this.clock().toISOString(), level, event, ...fields };
      const line = JSON.stringify(this.clean(record, 0));
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      this.prune();
      appendFileSync(this.file, `${line}\n`, "utf8");
    } catch {
      // logging must never break a run
    }
  }

  error(event: string, fields?: Record<string, unknown>): void {
    this.log("error", event, fields);
  }
  info(event: string, fields?: Record<string, unknown>): void {
    this.log("info", event, fields);
  }
  debug(event: string, fields?: Record<string, unknown>): void {
    this.log("debug", event, fields);
  }

  /**
   * The messages of a model request that were not already logged for this stream. A prompt grows
   * by appending, so the first call logs everything and later calls only what is new; when context
   * management rewrote the history, `rewritten` says how many earlier messages no longer match.
   */
  promptDelta(
    stream: string,
    messages: readonly unknown[],
  ): { from: number; total: number; messages: unknown[]; rewritten: number } {
    const hashes = messages.map((m) =>
      createHash("sha1").update(JSON.stringify(m)).digest("hex").slice(0, 12),
    );
    const before = this.prompts.get(stream) ?? [];
    let common = 0;
    while (common < before.length && common < hashes.length && before[common] === hashes[common]) common += 1;
    this.prompts.set(stream, hashes);
    return {
      from: common,
      total: messages.length,
      messages: messages.slice(common) as unknown[],
      rewritten: before.length - common,
    };
  }

  private prune(): void {
    if (this.pruned) return;
    this.pruned = true;
    try {
      const cutoff = this.clock().getTime() - this.keepDays * 86_400_000;
      for (const name of readdirSync(this.dir)) {
        if (!/^jarvis-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)) continue;
        const path = join(this.dir, name);
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      }
    } catch {
      // best effort
    }
  }

  /** Redacts every string, cuts long ones and bounds depth and width. */
  private clean(value: unknown, depth: number): unknown {
    if (typeof value === "string") {
      const redacted = this.redact(value);
      return redacted.length > this.maxField
        ? `${redacted.slice(0, this.maxField)}…[cut ${redacted.length - this.maxField} chars]`
        : redacted;
    }
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Error) return this.clean(errorFields(value), depth);
    if (depth > 8) return "[too deep]";
    if (Array.isArray(value)) {
      const items = value.slice(0, 500).map((v) => this.clean(v, depth + 1));
      if (value.length > 500) items.push(`[${value.length - 500} more]`);
      return items;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = this.clean(v, depth + 1);
    }
    return out;
  }
}

export const NULL_LOGGER = new Logger({ dir: "", level: "off" });

/** Event kinds that are failures: written at `error` level so `JARVIS_LOG=error` keeps them. */
export function eventLevel(kind: string): "error" | "info" {
  return /(\.|_)(error|failed|denied|unresolved|overflow|unavailable|leaseLost)$/.test(kind)
    ? "error"
    : "info";
}

export interface LogFilter {
  readonly run?: string;
  readonly level?: LogLevel;
  readonly event?: string;
  readonly sinceMs?: number;
  readonly tail?: number;
}

export function logFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^jarvis-\d{4}-\d{2}-\d{2}\.ndjson$/.test(n))
    .sort()
    .map((n) => join(dir, n));
}

/** Reads the log files in time order and applies the filter; the last `tail` records win. */
export function readLogs(dir: string, filter: LogFilter = {}, now = Date.now()): LogRecord[] {
  const min = RANK[filter.level ?? "info"];
  const out: LogRecord[] = [];
  for (const file of logFiles(dir)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let record: LogRecord;
      try {
        record = JSON.parse(line) as LogRecord;
      } catch {
        continue;
      }
      if (RANK[record.level] > min) continue;
      if (filter.run && !(record.runId ?? "").startsWith(filter.run)) continue;
      if (filter.event && !record.event.includes(filter.event)) continue;
      if (filter.sinceMs !== undefined && Date.parse(record.ts) < now - filter.sinceMs) continue;
      out.push(record);
    }
  }
  return filter.tail !== undefined && filter.tail > 0 ? out.slice(-filter.tail) : out;
}

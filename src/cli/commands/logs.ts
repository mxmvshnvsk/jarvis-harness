import { statSync } from "node:fs";
import { jarvisHome } from "../../core/paths.ts";
import { type LogLevel, type LogRecord, logFiles, logLevelFrom, readLogs } from "../../telemetry/log.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";

/**
 * `jarvis logs [run]` — reads the technical log files (`<home>/logs/jarvis-YYYY-MM-DD.ndjson`).
 * It does not load the configuration: the log is most needed exactly when the configuration is broken.
 */
export interface LogsOptions {
  readonly level?: string;
  readonly event?: string;
  readonly tail?: number;
  readonly since?: string;
  readonly path?: boolean;
  readonly full?: boolean;
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseSince(text: string): number | undefined {
  const m = /^(\d+)\s*([smhd])$/.exec(text.trim());
  return m ? Number(m[1]) * (UNITS[m[2] as string] as number) : undefined;
}

const FIXED = new Set(["ts", "level", "event", "runId", "stepId", "iteration"]);

function compact(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const one = (text ?? "").replace(/\s+/g, " ");
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

export function formatRecord(r: LogRecord, full: boolean): string {
  const time = r.ts.slice(11, 23);
  const where = [r.runId?.slice(0, 12), r.stepId, r.iteration !== undefined ? `#${r.iteration}` : undefined]
    .filter(Boolean)
    .join(" ");
  const fields = Object.entries(r)
    .filter(([k]) => !FIXED.has(k))
    .map(([k, v]) => `${k}=${compact(v, full ? 100_000 : 160)}`)
    .join(" ");
  return `${time} ${r.level.toUpperCase().padEnd(5)} ${r.event}${where ? `  [${where}]` : ""}${fields ? `  ${fields}` : ""}`;
}

export async function runLogs(ctx: CliContext, run: string | undefined, options: LogsOptions): Promise<void> {
  const home = jarvisHome(ctx.env, ctx.homeDir);
  const dir = home.logsDir;
  if (options.path) {
    ctx.out.result({ dir, files: logFiles(dir) }, () => ctx.out.line(dir));
    return;
  }
  const level = (options.level ?? "info").toLowerCase();
  if (!["error", "info", "debug"].includes(level)) {
    ctx.out.error(`unknown level "${options.level}" (error, info or debug)`);
    throw new CliExit(EXIT.error);
  }
  let sinceMs: number | undefined;
  if (options.since !== undefined) {
    sinceMs = parseSince(options.since);
    if (sinceMs === undefined) {
      ctx.out.error(`cannot read --since "${options.since}" (examples: 30m, 2h, 1d)`);
      throw new CliExit(EXIT.error);
    }
  }
  const records = readLogs(dir, {
    level: level as LogLevel,
    ...(run ? { run } : {}),
    ...(options.event ? { event: options.event } : {}),
    ...(sinceMs !== undefined ? { sinceMs } : {}),
    tail: options.tail ?? 100,
  });
  ctx.out.result({ dir, level, records }, () => {
    if (records.length === 0) {
      const files = logFiles(dir);
      ctx.out.line(
        files.length === 0
          ? `no log files in ${dir} (JARVIS_LOG=${logLevelFrom(ctx.env)}; nothing has been logged yet)`
          : `no records match (level ${level}${run ? `, run ${run}` : ""}); ${files.length} file(s) in ${dir}${level !== "debug" ? "; model and tool bodies need JARVIS_LOG=debug" : ""}`,
      );
      return;
    }
    for (const r of records) ctx.out.line(formatRecord(r, options.full === true));
  });
}

/** Size and age of the log directory for `jarvis doctor`. */
export function logDirSummary(dir: string): { files: number; bytes: number } {
  const files = logFiles(dir);
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += statSync(f).size;
    } catch {
      // gone meanwhile
    }
  }
  return { files: files.length, bytes };
}

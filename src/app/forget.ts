import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "../core/domain/run.ts";
import type { Runtime } from "./runtime.ts";

/**
 * `jarvis forget`: a finished run leaves no trace in Jarvis's store — its record, history,
 * checkpoints, events, artifacts (and their blobs nobody else refers to), approvals, threads, the
 * files `show` wrote for reading. Quota usage stays: it belongs to the pool's window, not to the run.
 * Pilot: after an experiment the person wanted a clean slate before the next one.
 */
export interface Forgotten {
  readonly runs: number;
  readonly artifacts: number;
  readonly events: number;
  readonly blobs: number;
}

const FINISHED = new Set(["COMPLETED", "CANCELLED", "FAILED"]);

export function canForget(run: Run): boolean {
  return FINISHED.has(run.state);
}

export function forgetRuns(runtime: Runtime, runs: readonly Run[]): Forgotten {
  const db = runtime.db.db;
  const count = (sql: string, id: string) => (db.prepare(sql).get(id) as { n: number }).n;
  let artifacts = 0;
  let events = 0;
  const refs = new Set<string>();
  db.exec("BEGIN");
  try {
    for (const run of runs) {
      if (!canForget(run)) throw new Error(`run ${run.id} is ${run.state}: only finished runs are forgotten`);
      const id = run.id;
      for (const r of db
        .prepare("SELECT content_ref AS ref FROM artifacts WHERE run_id = ?")
        .all(id) as Array<{ ref: string }>)
        refs.add(r.ref);
      artifacts += count("SELECT COUNT(*) AS n FROM artifacts WHERE run_id = ?", id);
      events += count("SELECT COUNT(*) AS n FROM events WHERE run_id = ?", id);
      db.prepare(
        "DELETE FROM interaction_messages WHERE interaction_id IN (SELECT id FROM interactions WHERE run_id = ?)",
      ).run(id);
      for (const table of [
        "interactions",
        "approvals",
        "artifacts",
        "checkpoints",
        "step_history",
        "effects",
        "events",
      ])
        db.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(id);
      db.prepare("UPDATE usage_window SET run_id = NULL WHERE run_id = ?").run(id);
      db.prepare("DELETE FROM runs WHERE id = ?").run(id);
    }
    // blobs are shared by content: only those no artifact or approval refers to any more go
    let blobs = 0;
    const orphan: string[] = [];
    for (const ref of refs) {
      const used =
        count("SELECT COUNT(*) AS n FROM artifacts WHERE content_ref = ?", ref) +
        count("SELECT COUNT(*) AS n FROM approvals WHERE content_ref = ?", ref);
      if (used > 0) continue;
      db.prepare("DELETE FROM blobs WHERE content_ref = ?").run(ref);
      orphan.push(ref);
      blobs += 1;
    }
    db.exec("COMMIT");
    for (const ref of orphan) rmSync(runtime.blobs.path(ref), { force: true });
    for (const run of runs) {
      const view = join(runtime.loaded.home.cacheDir, "view", run.id);
      if (existsSync(view)) rmSync(view, { recursive: true, force: true });
    }
    return { runs: runs.length, artifacts, events, blobs };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

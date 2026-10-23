import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { DataClass } from "../core/config/schema.ts";
import { WorktreeWorkspace } from "../orchestration/worktree.ts";
import { git } from "../tools/local/exec.ts";
import type { Runtime } from "./runtime.ts";

/**
 * Run bundles (ADR-0009 §5): everything a run is — its rows, artifacts with blobs, effects,
 * approvals, threads and the workspace patch — as one gzipped JSON file, so a CI run parked at a
 * human gate can be continued on a developer's machine (and the other way round).
 */
export const BUNDLE_SCHEMA_VERSION = 1;

type Row = Record<string, unknown>;

export interface RunBundle {
  readonly schemaVersion: number;
  readonly exportedAt: string;
  readonly runId: string;
  /**
   * The run's data class, in the header (ADR-0016 §3): the file leaves Jarvis's control, and whoever
   * receives it sees what it holds. Absent in bundles written before it.
   */
  readonly dataClass?: DataClass;
  readonly tables: Record<string, Row[]>;
  /** contentRef → base64 */
  readonly blobs: Record<string, string>;
  readonly patch?: string;
}

/** Tables keyed by run_id, in dependency order (parents first). */
const RUN_TABLES = [
  "runs",
  "step_history",
  "checkpoints",
  "artifacts",
  "approvals",
  "effects",
  "interactions",
  "events",
];

function rowsOf(runtime: Runtime, table: string, where: string, params: unknown[]): Row[] {
  return runtime.db.db
    .prepare(`SELECT * FROM ${table} WHERE ${where}`)
    .all(...(params as string[])) as unknown as Row[];
}

/** The blobs of the agents' conversations: the latest transcript of each step's round, and what it cut. */
function conversationRefs(runtime: Runtime, tables: Record<string, Row[]>): string[] {
  const latest = new Map<string, { at: string; ref: string }>();
  for (const c of tables.checkpoints ?? []) {
    let ref: unknown;
    try {
      ref = (JSON.parse(String(c.state_json ?? "{}")) as { transcriptRef?: unknown }).transcriptRef;
    } catch {
      continue;
    }
    if (typeof ref !== "string") continue;
    const key = `${c.step_id}#${c.iteration}`;
    const at = String(c.created_at ?? "");
    if ((latest.get(key)?.at ?? "") <= at) latest.set(key, { at, ref });
  }
  const refs = new Set([...latest.values()].map((l) => l.ref));
  for (const e of tables.events ?? []) {
    if (e.kind !== "context.trimmed") continue;
    try {
      const p = JSON.parse(String(e.payload_json ?? "{}")) as { originals?: Array<{ ref?: unknown }> };
      for (const o of p.originals ?? []) if (typeof o.ref === "string") refs.add(o.ref);
    } catch {
      // a payload that does not parse: nothing to take
    }
  }
  // a long tool output names its full text by a prefix: «…[truncated: full output N bytes, blob 1a2b…]»
  const prefixes = new Set<string>();
  for (const ref of refs) {
    if (!runtime.blobs.has(ref)) continue;
    for (const m of runtime.blobs.getText(ref).matchAll(/blob ([0-9a-f]{12})\b/g))
      prefixes.add(m[1] as string);
  }
  for (const prefix of prefixes)
    for (const r of rowsOf(runtime, "blobs", "content_ref LIKE ?", [`${prefix}%`]))
      refs.add(r.content_ref as string);
  return [...refs];
}

export async function exportRun(runtime: Runtime, runId: string): Promise<RunBundle> {
  const run = runtime.runs.require(runId);
  const tables: Record<string, Row[]> = {};
  for (const table of RUN_TABLES) {
    tables[table] = rowsOf(runtime, table, table === "runs" ? "id = ?" : "run_id = ?", [runId]);
  }
  const threadIds = (tables.interactions ?? []).map((r) => r.id as string);
  tables.interaction_messages = threadIds.flatMap((id) =>
    rowsOf(runtime, "interaction_messages", "interaction_id = ?", [id]),
  );

  const refs = new Set<string>();
  for (const a of tables.artifacts ?? []) refs.add(a.content_ref as string);
  for (const e of tables.effects ?? []) {
    if (e.args_ref) refs.add(e.args_ref as string);
    if (e.result_ref) refs.add(e.result_ref as string);
  }
  // what the agents saw and said: the last saved conversation of each step's round, and the full
  // text of what was cut from it (a tool's long output, trimmed context) — without it a bundle tells
  // that a check failed, not why (pilot: «project.lint exit 1» five times, its output nowhere)
  for (const ref of conversationRefs(runtime, tables)) refs.add(ref);
  const blobs: Record<string, string> = {};
  tables.blobs = [];
  for (const ref of refs) {
    if (!runtime.blobs.has(ref)) continue;
    blobs[ref] = runtime.blobs.get(ref).toString("base64");
    tables.blobs.push(...rowsOf(runtime, "blobs", "content_ref = ?", [ref]));
  }

  let patch: string | undefined;
  const ws = run.workspace;
  if (existsSync(ws.path)) {
    const base = ws.baseCommit ?? ws.baseRef;
    const committed = await git(["diff", "--no-color", "--binary", `${base}..HEAD`], ws.path);
    const working = await git(["diff", "--no-color", "--binary", "HEAD"], ws.path);
    patch = [committed.code === 0 ? committed.stdout : "", working.code === 0 ? working.stdout : ""].join("");
  }
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    runId,
    dataClass: run.dataClass,
    tables,
    blobs,
    ...(patch ? { patch } : {}),
  };
}

/**
 * What `jarvis export` says about a run that is not public (ADR-0016 §3): moving the file outside the
 * organization's contour is a person's call, and Jarvis does not track it.
 */
export function exportWarning(dataClass: DataClass | undefined): string | undefined {
  if (dataClass === undefined || dataClass === "public") return undefined;
  return `dataClass ${dataClass}: the bundle holds the run's task, artifacts, journal and code changes as they are — keep it inside the organization's contour; moving it out is on you (ADR-0016 §3)`;
}

export function writeBundle(bundle: RunBundle, file: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(bundle), "utf8")));
}

export function readBundle(file: string): RunBundle {
  const raw = readFileSync(file);
  const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
  const bundle = JSON.parse(text) as RunBundle;
  if (bundle.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    throw new Error(
      `bundle schema v${bundle.schemaVersion} is not supported (this Jarvis reads v${BUNDLE_SCHEMA_VERSION})`,
    );
  }
  return bundle;
}

export class BundleImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleImportError";
  }
}

export interface ImportOptions {
  /** Repository to rebuild the workspace in; without it the run keeps a cwd workspace pointing here. */
  readonly repoRoot?: string;
  readonly worktreesDir: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ImportResult {
  readonly runId: string;
  readonly workspace: "worktree" | "cwd" | "missing";
  readonly patched: boolean;
}

function insertRows(runtime: Runtime, table: string, rows: Row[]): void {
  for (const row of rows) {
    const keys = Object.keys(row);
    runtime.db.db
      .prepare(
        `INSERT OR IGNORE INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
      )
      .run(...(keys.map((k) => row[k]) as Array<string | number | null>));
  }
}

/**
 * Imports a bundle into the local database and rebuilds the workspace: a worktree from the base
 * commit with the patch applied when the repository has that commit; otherwise the run points at
 * the repository root in cwd mode and the patch is left next to the bundle for manual application.
 */
export async function importRun(
  runtime: Runtime,
  bundle: RunBundle,
  options: ImportOptions,
): Promise<ImportResult> {
  if (runtime.runs.get(bundle.runId))
    throw new BundleImportError(`run ${bundle.runId} already exists locally`);
  const runRow = (bundle.tables.runs ?? [])[0];
  if (!runRow) throw new BundleImportError("bundle has no run row");

  // Blobs first (artifacts reference them), then the run and everything that points at it.
  for (const [ref, b64] of Object.entries(bundle.blobs)) {
    runtime.blobs.put(
      Buffer.from(b64, "base64"),
      (bundle.tables.blobs ?? []).find((r) => r.content_ref === ref)?.media_type as string | undefined,
    );
  }
  const workspace = JSON.parse(runRow.workspace_json as string) as {
    mode: string;
    repoRoot: string;
    path: string;
    baseRef: string;
    baseCommit?: string;
    branch?: string;
  };
  let mode: ImportResult["workspace"] = "missing";
  let patched = false;
  const repoRoot = options.repoRoot;
  const task = runRow.task as string;
  if (repoRoot && workspace.baseCommit) {
    const has = await git(["cat-file", "-e", `${workspace.baseCommit}^{commit}`], repoRoot);
    if (has.code === 0) {
      const wt = await WorktreeWorkspace.create({
        repoRoot,
        worktreesDir: options.worktreesDir,
        task,
        runId: bundle.runId,
        baseRef: workspace.baseCommit,
        env: options.env ?? process.env,
      });
      if (bundle.patch && bundle.patch.trim().length > 0) {
        const apply = await git(["apply", "--whitespace=nowarn", "-"], wt.ref.path, { input: bundle.patch });
        if (apply.code !== 0)
          throw new BundleImportError(
            `patch does not apply on ${workspace.baseCommit.slice(0, 10)}: ${apply.stderr.trim()}`,
          );
        await wt.checkpoint("jarvis: imported bundle", {
          "Jarvis-Run": bundle.runId,
          "Jarvis-Kind": "import",
        });
        patched = true;
      }
      runRow.workspace_json = JSON.stringify(wt.ref);
      mode = "worktree";
    }
  }
  if (mode === "missing" && repoRoot) {
    runRow.workspace_json = JSON.stringify({
      mode: "cwd",
      repoRoot,
      path: repoRoot,
      baseRef: workspace.baseRef,
      ...(workspace.baseCommit ? { baseCommit: workspace.baseCommit } : {}),
    });
    mode = "cwd";
  }
  // A lease never travels: the importing side starts fresh (ADR-0002 §5).
  runRow.lock_owner = null;
  runRow.lock_until = null;
  insertRows(runtime, "runs", [runRow]);
  for (const table of RUN_TABLES.filter((t) => t !== "runs" && t !== "events"))
    insertRows(runtime, table, bundle.tables[table] ?? []);
  // autoincrement keys are local: events and messages get new ones here
  insertRows(
    runtime,
    "events",
    (bundle.tables.events ?? []).map(({ seq: _seq, ...rest }) => rest),
  );
  insertRows(
    runtime,
    "interaction_messages",
    (bundle.tables.interaction_messages ?? []).map(({ id: _id, ...rest }) => rest),
  );
  runtime.events.emit({
    kind: "run.imported",
    runId: bundle.runId,
    payload: { workspace: mode, patched, exportedAt: bundle.exportedAt },
  });
  return { runId: bundle.runId, workspace: mode, patched };
}

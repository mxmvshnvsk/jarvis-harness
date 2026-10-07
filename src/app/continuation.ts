import type { Run } from "../core/domain/run.ts";
import type { LocalWorkflowEngine } from "../orchestration/runtime.ts";
import { git } from "../tools/local/exec.ts";
import { continuationStep, continuedBy } from "./handoff.ts";
import type { Runtime } from "./runtime.ts";

/**
 * Going on from a finished `research`/`spec` run to `sdd` from the page (src/app/handoff.ts does the
 * hand-off itself): what a finished run can go on as, where a run came from, and — for "New task" —
 * which finished run of the same issue a new one can start from, and whether the code it read has
 * changed since. Pilot: a research ended and the only way on was `jarvis continue` in a terminal.
 */

/** The workflow a finished run goes on as (`next:` of its definition), if any. */
export function nextWorkflowOf(engine: LocalWorkflowEngine, run: Run): string | undefined {
  try {
    return engine.workflow(run.workflow).next;
  } catch {
    return undefined;
  }
}

export interface Continuation {
  readonly workflow: string;
  /** The step the new run starts at. */
  readonly startAt: string;
  /** The steps it goes through, approvals left out: `requirements → spec → …`. */
  readonly rest: readonly string[];
}

/** How `run` would go on, or undefined: not finished, nowhere to go, or gone on already. */
export function continuationOf(
  runtime: Runtime,
  engine: LocalWorkflowEngine,
  run: Run,
): Continuation | undefined {
  const workflow = nextWorkflowOf(engine, run);
  if (!workflow || run.state !== "COMPLETED") return undefined;
  let target: ReturnType<LocalWorkflowEngine["workflow"]>;
  try {
    target = engine.workflow(workflow);
  } catch {
    return undefined;
  }
  const startAt = continuationStep(run, target);
  if (!startAt || continuedBy(runtime, run)) return undefined;
  const ids = target.steps.map((s) => s.id);
  const rest = ids.slice(ids.indexOf(startAt)).filter((id) => !id.startsWith("approve-"));
  return { workflow, startAt, rest };
}

/** The run this one went on from (`jarvis continue`, the page's "Continue to …"). */
export function continuedFromOf(runtime: Runtime, run: Pick<Run, "id">): string | undefined {
  const created = runtime.events.list({ runId: run.id, kind: "run.created", limit: 1 })[0];
  const from = (created?.payload as { continuedFrom?: unknown } | undefined)?.continuedFrom;
  return typeof from === "string" && from.length > 0 ? from : undefined;
}

/** Contradictions in the requirements the run's agents found (the last count said). */
export function contradictionsOf(runtime: Runtime, runId: string): number {
  let n = 0;
  for (const e of runtime.events.list({ runId, kind: "agent.finish", limit: 10_000 })) {
    const c = (e.payload as { contradictions?: unknown } | undefined)?.contradictions;
    if (typeof c === "number" && c > 0) n = c;
  }
  return n;
}

/** `ABC-42` of a task, when it names an issue. */
export function issueKeyOf(task: string): string | undefined {
  return /\b[A-Z][A-Z0-9]+-\d+\b/.exec(task)?.[0];
}

/** The same issue: by its key when the task names one, else by the very same words. */
function sameTask(a: string, b: string): boolean {
  const key = issueKeyOf(a);
  return key ? issueKeyOf(b) === key : a.trim() === b.trim();
}

/** The files the run's agents read (`repo.read`), repository-relative. */
export function filesReadIn(runtime: Runtime, runId: string): Set<string> {
  const paths = new Set<string>();
  for (const e of runtime.events.list({ runId, kind: "tool.call", limit: 100_000 })) {
    const p = (e.payload ?? {}) as { capability?: string; ok?: boolean; args?: string };
    if (p.capability !== "repo.read" || p.ok === false || typeof p.args !== "string") continue;
    try {
      const path = (JSON.parse(p.args) as { path?: unknown }).path;
      if (typeof path === "string" && path.length > 0) paths.add(path.replace(/^\.\//, ""));
    } catch {
      // cut by the journal's limit: not a path to go by
    }
  }
  return paths;
}

export interface StartPoint {
  readonly run: Run;
  readonly continuation: Continuation;
  readonly contradictions: number;
  /** What changed in the repository since the run's base; undefined when it can't be told. */
  readonly since?: {
    readonly commits: number;
    /** Changed files the run read: its findings about them may be out of date. */
    readonly touched: readonly string[];
  };
}

/** Out of date: the code it read changed since. Such a run is offered, not picked. */
export const isStale = (p: StartPoint): boolean => (p.since?.touched.length ?? 0) > 0;

/**
 * The finished run of the same issue in the same repository that a new `workflow` run can start
 * from — the newest one not gone on yet — with what changed in the code since it looked.
 */
export async function startPointOf(
  runtime: Runtime,
  engine: LocalWorkflowEngine,
  input: { readonly task: string; readonly workflow: string; readonly repoRoot: string },
): Promise<StartPoint | undefined> {
  const task = input.task.trim();
  if (!task) return undefined;
  const run = runtime.runs
    .list({ state: "COMPLETED", limit: 200 })
    .filter((r) => r.workspace.repoRoot === input.repoRoot && sameTask(task, r.task))
    .filter((r) => nextWorkflowOf(engine, r) === input.workflow)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .find((r) => continuationOf(runtime, engine, r));
  const continuation = run ? continuationOf(runtime, engine, run) : undefined;
  if (!run || !continuation) return undefined;
  const since = await changedSince(run, filesReadIn(runtime, run.id));
  return {
    run,
    continuation,
    contradictions: contradictionsOf(runtime, run.id),
    ...(since ? { since } : {}),
  };
}

/** Commits on the repository's HEAD since the run's base, and which of the files it read they change. */
async function changedSince(run: Run, read: ReadonlySet<string>): Promise<StartPoint["since"] | undefined> {
  const base = run.workspace.baseCommit;
  if (!base) return undefined;
  const root = run.workspace.repoRoot;
  const log = await git(["log", "--format=%x00%H", "--name-only", `${base}..HEAD`], root, {
    timeoutMs: 10_000,
  });
  if (log.code !== 0) return undefined;
  const commits = log.stdout.split("\0").filter((c) => c.trim().length > 0);
  const changed = new Set(
    commits.flatMap((c) =>
      c
        .split("\n")
        .slice(1)
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  );
  return { commits: commits.length, touched: [...read].filter((p) => changed.has(p)).sort() };
}

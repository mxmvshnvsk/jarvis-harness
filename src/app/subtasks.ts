import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject } from "../core/config/merge.ts";
import { knowledgeConfigOf } from "../core/config/meta.ts";
import { isTerminal, type Run, type RunState } from "../core/domain/run.ts";
import { libraryVersionOf } from "../onboarding/library.ts";
import { shortRunId } from "../storage/runStore.ts";
import { runShell } from "../tools/local/exec.ts";
import { resumeLibraryWaiters } from "./contractChange.ts";
import type { Runtime } from "./runtime.ts";

/**
 * A task across services (ADR-0025 §6): a master run in the knowledge repository splits it into a
 * subtask per service; each subtask is a plain sdd run in that service's repository, with
 * `options.parent` naming the master and its key. The master's `wait` step parks until they are done;
 * whichever process sees a subtask stop starts the next one in the queue and, when all are done,
 * resumes the master. Subtasks are processes of their own (`jarvis subtask run <master> <key>` in the
 * service's repository): each loads its service's configuration.
 */
export interface Subtask {
  readonly key: string;
  readonly service: string;
  readonly task: string;
  readonly requirements: readonly string[];
  readonly deliverAfter: readonly string[];
  /** The Jira task of the Story this subtask is (src/app/storyTasks.ts). */
  readonly issue?: string;
}

export interface ContractItem {
  readonly kind: "endpoint" | "topic" | "dto";
  readonly id: string;
  readonly change: string;
  readonly producer: string;
  readonly consumers: readonly string[];
}

export interface Split {
  readonly subtasks: readonly Subtask[];
  readonly contract: readonly ContractItem[];
  readonly notInScope: ReadonlyArray<{ readonly service: string; readonly why: string }>;
}

export const SPLIT_TYPE = "split";
export const MASTER_WORKFLOW = "sdd-cross";

/**
 * Workflows of a knowledge repository (ADR-0025): they read the map and the services' knowledge and
 * change no code there — they run in its working copy, not a worktree of their own.
 */
export const CROSS_WORKFLOWS: ReadonlySet<string> = new Set([
  MASTER_WORKFLOW,
  "research-cross",
  "spec-cross",
]);

/** In a knowledge repository, what `jarvis research` and `jarvis spec` run as. */
export const IN_KNOWLEDGE_REPO: Readonly<Record<string, string>> = {
  research: "research-cross",
  spec: "spec-cross",
};

/**
 * The workflow a run in this repository goes as: research and spec of a knowledge repository as their
 * cross-service kind; a workflow that changes code there is refused, as is a cross one outside it.
 */
export function workflowHere(
  name: string,
  meta: { readonly root: string; readonly service?: string } | undefined,
): { workflow: string } | { refused: string } {
  const knowledgeRepo = meta !== undefined && meta.service === undefined;
  if (knowledgeRepo) {
    const cross = IN_KNOWLEDGE_REPO[name];
    if (cross) return { workflow: cross };
    if (name === "sdd" || name === "fix")
      return {
        refused: `the knowledge repository has no code to change: a task across services is \`jarvis work "<task>" --workflow ${MASTER_WORKFLOW}\` here; a task in one service — run it in that service's repository`,
      };
    return { workflow: name };
  }
  if (CROSS_WORKFLOWS.has(name))
    return {
      refused: `${name} runs in the knowledge repository of the services${meta?.service ? ` (this is the service ${meta.service}; run it in ${meta.root})` : ""}`,
    };
  return { workflow: name };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The master's approved split (the latest version, approved at its gate). */
export function splitOf(runtime: Runtime, master: Run): Split | undefined {
  const a = runtime.artifacts.listLatest(master.id, SPLIT_TYPE)[0];
  return a ? parseSplit(runtime.artifacts.text(a)) : undefined;
}

/** A split document's subtasks, contract and what is not in scope. */
export function parseSplit(text: string): Split | undefined {
  try {
    const doc = JSON.parse(text) as Record<string, unknown>;
    const subtasks = (Array.isArray(doc.subtasks) ? doc.subtasks : []).flatMap((x): Subtask[] => {
      const o = x as Record<string, unknown>;
      return typeof o.key === "string" && typeof o.service === "string" && typeof o.task === "string"
        ? [
            {
              key: o.key,
              service: o.service,
              task: o.task,
              requirements: strings(o.requirements),
              deliverAfter: strings(o.deliverAfter),
              ...(typeof o.issue === "string" && /^[A-Z][A-Z0-9]+-\d+$/.test(o.issue.trim())
                ? { issue: o.issue.trim() }
                : {}),
            },
          ]
        : [];
    });
    const contract = (Array.isArray(doc.contract) ? doc.contract : []).flatMap((x): ContractItem[] => {
      const o = x as Record<string, unknown>;
      return (o.kind === "endpoint" || o.kind === "topic" || o.kind === "dto") &&
        typeof o.id === "string" &&
        typeof o.producer === "string"
        ? [
            {
              kind: o.kind,
              id: o.id,
              change: typeof o.change === "string" ? o.change : "",
              producer: o.producer,
              consumers: strings(o.consumers),
            },
          ]
        : [];
    });
    const notInScope = (Array.isArray(doc.notInScope) ? doc.notInScope : []).flatMap((x) => {
      const o = x as Record<string, unknown>;
      return typeof o.service === "string"
        ? [{ service: o.service, why: typeof o.why === "string" ? o.why : "" }]
        : [];
    });
    return { subtasks, contract, notInScope };
  } catch {
    return undefined;
  }
}

/** The subtask runs of a master: the newest run per key (a retry after a cancel makes a new one). */
export function childrenOf(runtime: Runtime, masterId: string): Map<string, Run> {
  const out = new Map<string, Run>();
  const runs = runtime.runs
    .list({ includeTerminal: true, limit: 1000 })
    .filter((r) => r.options?.parent?.runId === masterId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const r of runs) out.set(r.options?.parent?.key as string, r);
  return out;
}

/** The master a subtask belongs to, and its subtask. */
export function masterOf(runtime: Runtime, run: Run): { master: Run; subtask?: Subtask } | undefined {
  const parent = run.options?.parent;
  const master = parent ? runtime.runs.get(parent.runId) : undefined;
  if (!parent || !master) return undefined;
  const subtask = splitOf(runtime, master)?.subtasks.find((s) => s.key === parent.key);
  return subtask ? { master, subtask } : { master };
}

const keysOf = (runtime: Runtime, masterId: string, kind: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const e of runtime.events.list({ runId: masterId, kind, limit: 1000 }))
    if (typeof e.payload?.key === "string") out.set(e.payload.key, e.ts);
  return out;
};

/**
 * A subtask's state for the master: queued, blocked (it waits for a library of the task to be accepted
 * and published), starting (its process prepares the checkout), its run's state, dropped.
 */
export type SubtaskState = "queued" | "blocked" | "starting" | "dropped" | RunState;

/** A library subtask's `publish-local` after its change was accepted. */
export interface Publication {
  readonly ok: boolean;
  readonly command?: string;
  /** The version its checkout builds, as the services' builds will find it. */
  readonly version?: string;
  /** Published nothing: the library has no `publish-local` (the services build against what they have). */
  readonly skipped?: string;
  /** The command's last lines. */
  readonly tail?: string;
  /** Where it ran: the library subtask's checkout. */
  readonly at?: string;
  readonly ts: string;
}

export interface SubtaskView {
  readonly subtask: Subtask;
  readonly state: SubtaskState;
  readonly run?: Run;
  /** Blocked: the keys of the library subtasks it waits for. */
  readonly waitsFor?: readonly string[];
  /** A library's subtask: its publish-local, once run. */
  readonly published?: Publication;
}

export const PUBLISH_LOCAL = "publish-local";

/** The map's kinds and `uses` (ADR-0025): which services are libraries, which use which. */
export function libraryMapOf(runtime: Runtime): {
  libraries: Set<string>;
  uses: Map<string, string[]>;
  publishes: Map<string, string[]>;
} {
  const meta = runtime.loaded.meta;
  const config = meta ? knowledgeConfigOf(meta.root) : undefined;
  const services = config && isPlainObject(config.services) ? config.services : {};
  const libraries = new Set<string>();
  const uses = new Map<string, string[]>();
  const publishes = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(services)) {
    if (!isPlainObject(entry)) continue;
    if (entry.kind === "library") libraries.add(name);
    uses.set(name, strings(entry.uses));
    publishes.set(name, strings(entry.publishes));
  }
  return { libraries, uses, publishes };
}

/** The keys of the split's library subtasks this one waits for: libraries its service uses. */
export function libraryBlockers(
  sub: Subtask,
  split: Split,
  map: { libraries: ReadonlySet<string>; uses: ReadonlyMap<string, readonly string[]> },
): string[] {
  const used = map.uses.get(sub.service) ?? [];
  return split.subtasks
    .filter((s) => s.key !== sub.key && map.libraries.has(s.service) && used.includes(s.service))
    .map((s) => s.key);
}

/** The latest publish-local of each library subtask of a master. */
export function publicationsOf(runtime: Runtime, masterId: string): Map<string, Publication> {
  const out = new Map<string, Publication>();
  for (const e of runtime.events.list({ runId: masterId, kind: "subtask.published", limit: 1000 })) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (typeof p.key !== "string") continue;
    const str = (k: string) => (typeof p[k] === "string" ? { [k]: p[k] as string } : {});
    out.set(p.key, {
      ok: p.ok === true,
      ...str("command"),
      ...str("version"),
      ...str("skipped"),
      ...str("tail"),
      ...str("at"),
      ts: e.ts,
    });
  }
  return out;
}

/** A started subtask whose run does not exist yet counts as starting this long (the checkout's setup). */
const STARTING_MS = 30 * 60_000;

export function subtasksOf(runtime: Runtime, master: Run, now = new Date()): SubtaskView[] {
  const split = splitOf(runtime, master);
  if (!split) return [];
  const children = childrenOf(runtime, master.id);
  const dropped = keysOf(runtime, master.id, "subtask.dropped");
  const started = keysOf(runtime, master.id, "subtask.started");
  const startNow = keysOf(runtime, master.id, "subtask.startNow");
  const published = publicationsOf(runtime, master.id);
  const map = libraryMapOf(runtime);
  const base = split.subtasks.map((subtask) => {
    const run = children.get(subtask.key);
    if (dropped.has(subtask.key)) return { subtask, state: "dropped" as const, ...(run ? { run } : {}) };
    if (run) {
      // a retry after a cancel: started again after the cancelled run was made
      const again = started.get(subtask.key);
      if (
        run.state === "CANCELLED" &&
        again &&
        again > run.updatedAt &&
        now.getTime() - Date.parse(again) < STARTING_MS
      )
        return { subtask, state: "starting" as const, run };
      return { subtask, state: run.state, run };
    }
    const at = started.get(subtask.key);
    return at && now.getTime() - Date.parse(at) < STARTING_MS
      ? { subtask, state: "starting" as const }
      : { subtask, state: "queued" as const };
  });
  // a library's change goes first: who uses it waits until it is accepted and published (or dropped)
  const ready = (key: string) => {
    const v = base.find((x) => x.subtask.key === key);
    return v?.state === "dropped" || (v?.state === "COMPLETED" && published.get(key)?.ok === true);
  };
  return base.map((v): SubtaskView => {
    const pub = published.get(v.subtask.key);
    const withPub = pub ? { ...v, published: pub } : v;
    if (v.state !== "queued" || startNow.has(v.subtask.key)) return withPub;
    const waitsFor = libraryBlockers(v.subtask, split, map).filter((k) => !ready(k));
    return waitsFor.length > 0 ? { ...withPub, state: "blocked", waitsFor } : withPub;
  });
}

/** Done for the master: completed, or dropped by a person. */
export const isDone = (v: SubtaskView): boolean => v.state === "COMPLETED" || v.state === "dropped";
/** Holds one of the parallel slots: a model works or will (not a run waiting for a person). */
const holdsSlot = (v: SubtaskView): boolean =>
  v.state === "starting" || v.state === "CREATED" || v.state === "RUNNING" || v.state === "WAITING_BUDGET";

/** Starts a CLI process of Jarvis in the background; tests replace it. */
export type CliLauncher = (input: {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly log: string;
  readonly env?: NodeJS.ProcessEnv;
}) => void;

const spawnCli: CliLauncher = ({ args, cwd, log, env }) => {
  mkdirSync(join(log, ".."), { recursive: true });
  const fd = openSync(log, "a");
  try {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1] as string, ...args], {
      cwd,
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
      env: { ...process.env, ...env, JARVIS_INTERACTIVE: "off", JARVIS_PROGRESS: "plain", NO_COLOR: "1" },
    });
    child.on("error", () => {});
    child.unref();
  } finally {
    closeSync(fd);
  }
};

let launcher: CliLauncher = spawnCli;

/** Tests: record the launches instead of starting processes. */
export function setCliLauncher(next: CliLauncher | undefined): void {
  launcher = next ?? spawnCli;
}

function launchLog(runtime: Runtime, name: string): string {
  return join(runtime.loaded.home.cacheDir, "launches", `${name}.log`);
}

/** Starts one subtask's process in its service's repository. */
export function startSubtask(
  runtime: Runtime,
  master: Run,
  key: string,
): { ok: true } | { ok: false; why: string } {
  const sub = splitOf(runtime, master)?.subtasks.find((s) => s.key === key);
  if (!sub) return { ok: false, why: `no subtask ${key} in the split` };
  const repo = runtime.loaded.meta?.repos[sub.service];
  if (!repo) return { ok: false, why: `${sub.service} is not a service of the knowledge repository's map` };
  launcher({
    args: ["subtask", "run", master.id, key],
    cwd: repo,
    log: launchLog(runtime, `subtask-${shortRunId(master.id)}-${key}`),
  });
  runtime.events.emit({ kind: "subtask.started", runId: master.id, payload: { key, service: sub.service } });
  return { ok: true };
}

/** Starts queued subtasks while slots are free (`crossRepos.maxParallel`); returns their keys. */
export function scheduleSubtasks(runtime: Runtime, master: Run, now = new Date()): string[] {
  const views = subtasksOf(runtime, master, now);
  const free = runtime.loaded.config.crossRepos.maxParallel - views.filter(holdsSlot).length;
  const started: string[] = [];
  for (const v of views.filter((x) => x.state === "queued").slice(0, Math.max(0, free)))
    if (startSubtask(runtime, master, v.subtask.key).ok) started.push(v.subtask.key);
  return started;
}

/** The master goes on (its `wait` step sees every subtask done): `jarvis resume <master>` in the background. */
export function resumeMaster(runtime: Runtime, master: Run): void {
  launcher({
    args: ["resume", master.id],
    cwd: master.workspace.repoRoot,
    log: launchLog(runtime, `master-${shortRunId(master.id)}`),
  });
  runtime.events.emit({ kind: "run.resumedBy", runId: master.id, payload: { by: "subtasks" } });
}

/** A parked subtask goes on: `jarvis resume <run>` in the background, in its service's repository. */
export function resumeSubtask(runtime: Runtime, run: Run): void {
  launcher({
    args: ["resume", run.id],
    cwd: run.workspace.repoRoot,
    log: launchLog(runtime, `subtask-run-${shortRunId(run.id)}`),
  });
}

/**
 * After a run stopped (any process): a subtask that ended frees its slot for the next one; when every
 * subtask is done, the waiting master goes on. Never throws: the run's own report comes first.
 */
export async function afterRunStops(runtime: Runtime, run: Run): Promise<void> {
  try {
    const of = masterOf(runtime, run);
    if (!of || isTerminal(of.master.state)) return;
    const master = of.master;
    // a library's change accepted: published for the services that wait for it, then they start
    if (run.state === "COMPLETED" && of.subtask && libraryMapOf(runtime).libraries.has(of.subtask.service))
      await publishLibrary(runtime, master, of.subtask, run);
    scheduleSubtasks(runtime, master);
    // a subtask whose contract change was the library's goes on against its new version
    resumeLibraryWaiters(runtime, master);
    const views = subtasksOf(runtime, master);
    if (views.length > 0 && views.every(isDone) && master.waitingFor?.kind === "children")
      resumeMaster(runtime, master);
  } catch (error) {
    runtime.log.error("subtasks.after", {
      runId: run.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * `publish-local` of a library subtask, in its checkout, with the library service's configuration (the
 * process runs in its repository): its version as the services' builds will find it. Recorded on the
 * master; a failure keeps the services waiting, with the command's output to see.
 */
export async function publishLibrary(
  runtime: Runtime,
  master: Run,
  sub: Subtask,
  run: Run,
): Promise<Publication> {
  const command = runtime.loaded.config.tools.local[PUBLISH_LOCAL];
  const at = run.workspace.path;
  const emit = (p: Omit<Publication, "ts">) => {
    runtime.events.emit({
      kind: "subtask.published",
      runId: master.id,
      payload: { key: sub.key, service: sub.service, run: run.id, ...p },
    });
    return { ...p, ts: new Date().toISOString() };
  };
  if (!command)
    return emit({
      ok: true,
      skipped: `${sub.service} has no tools.local.${PUBLISH_LOCAL}: the services build against the version they have`,
      at,
    });
  const r = await runShell(command, { cwd: at, timeoutMs: runtime.loaded.config.tools.commandTimeoutMs });
  const tail = `${r.stdout}\n${r.stderr}`
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(-20)
    .join("\n");
  const version = libraryVersionOf(at);
  return emit({
    ok: r.code === 0 && !r.timedOut,
    command,
    ...(version ? { version } : {}),
    ...(tail ? { tail: tail.slice(-4000) } : {}),
    at,
  });
}

/** `jarvis subtask publish <master> <key>` in the library's repository: publish-local again. */
export function republishSubtask(
  runtime: Runtime,
  master: Run,
  key: string,
): { ok: true } | { ok: false; why: string } {
  const sub = splitOf(runtime, master)?.subtasks.find((s) => s.key === key);
  if (!sub) return { ok: false, why: `no subtask ${key} in the split` };
  const repo = runtime.loaded.meta?.repos[sub.service];
  if (!repo) return { ok: false, why: `${sub.service} is not a service of the knowledge repository's map` };
  launcher({
    args: ["subtask", "publish", master.id, key],
    cwd: repo,
    log: launchLog(runtime, `publish-${shortRunId(master.id)}-${key}`),
  });
  return { ok: true };
}

/** Delivery order: a subtask after the keys it is delivered after (a cycle keeps the split's order). */
export function deliveryOrder(subtasks: readonly Subtask[]): Subtask[] {
  const out: Subtask[] = [];
  const placed = new Set<string>();
  const visit = (s: Subtask, path: Set<string>) => {
    if (placed.has(s.key) || path.has(s.key)) return;
    path.add(s.key);
    for (const k of s.deliverAfter) {
      const before = subtasks.find((x) => x.key === k);
      if (before) visit(before, path);
    }
    placed.add(s.key);
    out.push(s);
  };
  for (const s of subtasks) visit(s, new Set());
  return out;
}

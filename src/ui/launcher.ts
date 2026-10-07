import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { waitingCard } from "../app/decide.ts";
import type { Runtime } from "../app/runtime.ts";
import type { Run } from "../core/domain/run.ts";
import { moduleOfRun } from "../onboarding/moduleRun.ts";

/**
 * Runs started from the page (ADR-0023 §6): the server does not execute workflows itself — it
 * starts the same CLI a person would type (`jarvis fix "<task>"`), detached, without a terminal,
 * its output in a log file. Such a run is *driven by the page*: when it stops for a person, the page
 * decides, and the launcher starts `jarvis resume <run>` again; when it waits for a model or a quota
 * window, the launcher resumes it once the wait is over. Runs started in a terminal stay the
 * terminal's (a card there picks the decision up).
 *
 * Module research (the Modules page) is started the same way — `jarvis onboard --module <path>` —
 * one at a time per server: the rest wait in a queue and start as the one before them ends.
 */
export type Workflow = "fix" | "sdd" | "research" | "spec";

export const WORKFLOWS: ReadonlyArray<{
  readonly id: Workflow;
  readonly label: string;
  readonly about: string;
}> = [
  // first and selected: find out before changing anything
  { id: "research", label: "research", about: "find out and write it down, nothing changed" },
  { id: "fix", label: "fix", about: "a short way for a bug: spec, implementation, checks, review" },
  {
    id: "sdd",
    label: "sdd",
    about: "the full way: requirements, spec to approve, impact, plan, implementation",
  },
  { id: "spec", label: "spec", about: "up to an approved spec, nothing implemented" },
];

const COMMAND: Record<Workflow, string> = { fix: "fix", sdd: "work", spec: "spec", research: "research" };

export interface Launch {
  readonly id: string;
  readonly task: string;
  readonly workflow: Workflow | "onboard-module";
  /** Module research: the folder it maps, and what matters to the person who asked. */
  readonly module?: string;
  readonly note?: string;
  /** Waits for the research in front of it; no process yet. */
  queued?: boolean;
  readonly repoRoot: string;
  readonly startedAt: string;
  readonly log: string;
  runId?: string;
  /** null while the process lives; its exit code after. */
  exitCode: number | null;
}

export interface Launcher {
  start(input: { task: string; workflow: Workflow; repoRoot: string }): Launch;
  /** Research one module (or a folder): now, or after the research in front of it. */
  startModule(input: { module: string; note?: string; repoRoot: string }): Launch;
  /** Takes a research out of the queue; false when it has started already. */
  unqueue(id: string): boolean;
  /** Launches of this server, newest first. */
  list(): readonly Launch[];
  get(id: string): Launch | undefined;
  /** The page drives this run: it was started here (also by an earlier `jarvis ui`). */
  drives(runId: string): boolean;
  /** Go on with a run the page drives (after a decision, a wait): `jarvis resume <run>` in the background. */
  resume(run: Run): boolean;
  /** "Resume now" on the page: the page drives the run from now on (if no one did) and resumes it. */
  adopt(run: Run): boolean;
  /** Called on every tick: match launches to their runs, resume runs whose wait is over. */
  tend(now?: Date): void;
  /** The last lines of a launch's log. */
  tail(launch: Launch, lines?: number): string;
}

export interface LauncherOptions {
  readonly runtime: Runtime;
  /** How to start the CLI: `[node, …execArgv, main]` of this very process. */
  readonly cli: readonly string[];
  readonly logDir: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function createLauncher(options: LauncherOptions): Launcher {
  const { runtime } = options;
  const launches: Launch[] = [];
  /** Live child processes per run, so a run is never resumed twice at once. */
  const busy = new Map<string, number>();
  mkdirSync(options.logDir, { recursive: true });

  const spawnCli = (
    args: string[],
    cwd: string,
    log: string,
    onExit: (code: number | null) => void,
  ): number => {
    const fd = openSync(log, "a");
    try {
      const [command, ...pre] = options.cli;
      const child = spawn(command as string, [...pre, ...args], {
        cwd,
        detached: true,
        stdio: ["ignore", fd, fd],
        env: {
          ...process.env,
          ...options.env,
          JARVIS_INTERACTIVE: "off",
          JARVIS_PROGRESS: "plain",
          NO_COLOR: "1",
        },
      });
      child.on("exit", (code) => onExit(code));
      child.on("error", () => onExit(127));
      child.unref();
      return child.pid ?? 0;
    } finally {
      closeSync(fd);
    }
  };

  const drives = (runId: string): boolean =>
    launches.some((l) => l.runId === runId) ||
    runtime.events.list({ runId, kind: "run.driver", limit: 1 }).length > 0;

  const resume = (run: Run): boolean => {
    if (busy.has(run.id) || !drives(run.id) || waitingCard(runtime, run.id)) return false;
    const log = join(options.logDir, `${run.id}.log`);
    const pid = spawnCli(["resume", run.id], run.workspace.repoRoot, log, () => busy.delete(run.id));
    if (pid > 0) busy.set(run.id, pid);
    runtime.events.emit({ kind: "run.resumedBy", runId: run.id, payload: { by: "ui", pid } });
    return pid > 0;
  };

  /** A research in progress: its process lives, or its run goes on (or waits for a model). */
  const researching = (): boolean =>
    launches.some((l) => {
      if (l.workflow !== "onboard-module" || l.queued) return false;
      if (l.exitCode === null) return true;
      const run = l.runId ? runtime.runs.get(l.runId) : undefined;
      return run?.state === "RUNNING" || run?.state === "WAITING_BUDGET" || (run ? busy.has(run.id) : false);
    });

  const spawnModule = (launch: Launch): void => {
    launch.queued = false;
    (launch as { startedAt: string }).startedAt = new Date().toISOString();
    const args = [
      "onboard",
      "--module",
      launch.module as string,
      ...(launch.note ? ["--note", launch.note] : []),
    ];
    spawnCli(args, launch.repoRoot, launch.log, (code) => {
      launch.exitCode = code ?? 1;
      if (launch.runId) busy.delete(launch.runId);
    });
  };

  /** The queue moves: the oldest waiting research starts when none is in progress. */
  const nextInQueue = (): void => {
    if (researching()) return;
    const next = [...launches].reverse().find((l) => l.queued);
    if (next) spawnModule(next);
  };

  return {
    startModule(input) {
      const id = randomBytes(6).toString("hex");
      const launch: Launch = {
        id,
        task: `module ${input.module}`,
        workflow: "onboard-module",
        module: input.module,
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
        repoRoot: input.repoRoot,
        startedAt: new Date().toISOString(),
        log: join(options.logDir, `launch-${id}.log`),
        exitCode: null,
        queued: true,
      };
      launches.unshift(launch);
      nextInQueue();
      return launch;
    },
    unqueue(id) {
      const at = launches.findIndex((l) => l.id === id && l.queued);
      if (at < 0) return false;
      launches.splice(at, 1);
      return true;
    },
    start(input) {
      const id = randomBytes(6).toString("hex");
      const log = join(options.logDir, `launch-${id}.log`);
      const launch: Launch = {
        id,
        task: input.task,
        workflow: input.workflow,
        repoRoot: input.repoRoot,
        startedAt: new Date().toISOString(),
        log,
        exitCode: null,
      };
      launches.unshift(launch);
      spawnCli([COMMAND[input.workflow], input.task], input.repoRoot, log, (code) => {
        launch.exitCode = code ?? 1;
        if (launch.runId) busy.delete(launch.runId);
      });
      return launch;
    },
    list: () => launches,
    get: (id) => launches.find((l) => l.id === id),
    drives,
    resume,
    adopt(run) {
      if (!drives(run.id))
        runtime.events.emit({ kind: "run.driver", runId: run.id, payload: { by: "ui", adopted: true } });
      return resume(run);
    },
    tend(now = new Date()) {
      // a launch's run: the newest one with its task (or its module) created since it started
      for (const l of launches) {
        if (l.runId || l.queued) continue;
        const run = runtime.runs
          .list({ includeTerminal: true, limit: 50 })
          .find(
            (r) =>
              r.createdAt >= l.startedAt.slice(0, 19) &&
              (l.module
                ? r.workflow === "onboard-module" && moduleOfRun(runtime, r.id)?.module === l.module
                : r.task === l.task),
          );
        if (!run) continue;
        l.runId = run.id;
        if (l.exitCode === null) busy.set(run.id, -1);
        runtime.events.emit({ kind: "run.driver", runId: run.id, payload: { by: "ui", launch: l.id } });
      }
      for (const l of launches)
        if (l.runId && l.exitCode !== null && busy.get(l.runId) === -1) busy.delete(l.runId);
      nextInQueue();
      // runs the page drives that wait for a model or a quota window: go on once the wait is over
      for (const run of runtime.runs.list({ state: ["WAITING_BUDGET"], limit: 100 })) {
        if (busy.has(run.id) || !drives(run.id)) continue;
        const after = runtime.checkpoints.latest(run.id)?.state.resumeAfter;
        if (typeof after === "string" && Date.parse(after) > now.getTime()) continue;
        resume(run);
      }
    },
    tail(launch, lines = 20) {
      if (!existsSync(launch.log) || statSync(launch.log).size === 0) return "";
      // colour codes, should a command print them anyway
      const text = readFileSync(launch.log, "utf8").replace(
        new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g"),
        "",
      );
      return text
        .split("\n")
        .slice(-lines - 1)
        .join("\n")
        .trim();
    },
  };
}

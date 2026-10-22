import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runShell } from "../../tools/local/exec.ts";
import { WorktreeWorkspace } from "../worktree.ts";
import { testClassArgs } from "./relatedTests.ts";

/**
 * Tests that fail before the run changed anything are not the run's defects. When a Gradle or Maven
 * test check fails, the failing test classes (from the JUnit XML reports the runner writes) run once
 * more on the base commit, in a checkout of their own; those failing there too are pre-existing and
 * do not send the implementation back. What the base says is kept per base commit and command, so a
 * later round asks only about classes not checked yet. Pilot: six date tests of a Spring service
 * failed on any machine outside the time zone they were written in, with no change at all.
 */

const REPORT_DIRS = /(^|\/)(build\/test-results|target\/(surefire|failsafe)-reports)(\/|$)/;
const SKIP = new Set(["node_modules", ".git", ".gradle", "src"]);

/** The JUnit XML reports written since `since` (ms): each test class and whether it failed. */
export function junitReports(root: string, since: number): Array<{ name: string; failed: boolean }> {
  const out = new Map<string, boolean>();
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 6) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP.has(name)) continue;
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      try {
        const st = statSync(abs);
        if (st.isDirectory()) walk(abs, r, depth + 1);
        else if (REPORT_DIRS.test(r) && /^TEST-.+\.xml$/.test(name) && st.mtimeMs >= since) {
          const suite = /<testsuite\b[^>]*>/.exec(readFileSync(abs, "utf8").slice(0, 4000))?.[0] ?? "";
          const count = (a: string) => Number(new RegExp(`\\b${a}="(\\d+)"`).exec(suite)?.[1] ?? 0);
          const cls = /\bname="([^"]+)"/.exec(suite)?.[1];
          if (cls) out.set(cls, (out.get(cls) ?? false) || count("failures") + count("errors") > 0);
        }
      } catch {
        // gone while reading: not reported
      }
    }
  };
  walk(root, "", 0);
  return [...out].map(([name, failed]) => ({ name, failed })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Test classes with a failure or an error in the reports written since `since`. */
export function junitFailures(root: string, since: number): string[] {
  return junitReports(root, since)
    .filter((r) => r.failed)
    .map((r) => r.name);
}

interface BaselineFile {
  /** command → class → fails on the base. */
  readonly checked: Record<string, Record<string, boolean>>;
}

export interface BaselineOptions {
  readonly repoRoot: string;
  readonly baseCommit: string;
  readonly runner: "gradle" | "maven";
  /** The check's command as configured (`cd <dir> && …` included). */
  readonly command: string;
  readonly classes: readonly string[];
  readonly worktreesDir: string;
  readonly cacheDir: string;
  readonly repoId: string;
  readonly setup?: string | undefined;
  readonly checkout?: "worktree" | "clone";
  readonly depsCache?: { readonly dir: string; readonly key: string[]; readonly paths: string[] } | undefined;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Which of `classes` fail on the base commit: answered from the cache, or by running them there.
 * Undefined when the base could not be checked (no checkout, setup failed): then nothing is excused.
 */
export async function failingOnBase(o: BaselineOptions): Promise<Set<string> | undefined> {
  const file = join(o.cacheDir, "baseline", o.repoId, `${o.baseCommit}.json`);
  let known: BaselineFile = { checked: {} };
  try {
    if (existsSync(file)) known = JSON.parse(readFileSync(file, "utf8")) as BaselineFile;
  } catch {
    known = { checked: {} };
  }
  const byClass = { ...(known.checked[o.command] ?? {}) };
  const ask = o.classes.filter((c) => byClass[c] === undefined);
  if (ask.length > 0) {
    let wt: WorktreeWorkspace | undefined;
    try {
      wt = await WorktreeWorkspace.create({
        repoRoot: o.repoRoot,
        worktreesDir: o.worktreesDir,
        runId: `base-${o.baseCommit.slice(0, 8)}-${Date.now().toString(36)}`,
        task: "baseline",
        baseRef: o.baseCommit,
        ...(o.setup ? { setup: o.setup } : {}),
        ...(o.checkout ? { checkout: o.checkout } : {}),
        setupTimeoutMs: o.timeoutMs,
        env: o.env,
        ...(o.depsCache ? { cache: o.depsCache } : {}),
      });
      const started = Date.now() - 1000;
      await runShell(`${o.command} ${testClassArgs(o.runner, ask)}`, {
        cwd: wt.ref.path,
        timeoutMs: o.timeoutMs,
        env: o.env,
      });
      // a class with no report did not run there (absent on the base): it cannot excuse anything
      const reports = new Map(junitReports(wt.ref.path, started).map((r) => [r.name, r.failed]));
      for (const c of ask) byClass[c] = reports.get(c) === true;
    } catch {
      return undefined;
    } finally {
      if (wt) {
        await wt.remove({ pruneBranch: true });
        if (existsSync(wt.ref.path)) rmSync(wt.ref.path, { recursive: true, force: true });
      }
    }
    try {
      mkdirSync(join(o.cacheDir, "baseline", o.repoId), { recursive: true });
      // read again before writing: checks run side by side, and another command's answers written
      // meanwhile were lost to the last writer (the next round ran their baseline again)
      let now: BaselineFile = { checked: {} };
      try {
        if (existsSync(file)) now = JSON.parse(readFileSync(file, "utf8")) as BaselineFile;
      } catch {
        now = { checked: {} };
      }
      const merged = { ...(now.checked[o.command] ?? {}), ...byClass };
      writeFileSync(file, JSON.stringify({ checked: { ...now.checked, [o.command]: merged } }, null, 2));
    } catch {
      // the answer still holds for this round
    }
  }
  return new Set(o.classes.filter((c) => byClass[c] === true));
}

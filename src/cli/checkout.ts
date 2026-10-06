import { spawnSync } from "node:child_process";
import type { Run } from "../core/domain/run.ts";
import { shortRunId } from "../storage/runStore.ts";
import type { CliContext } from "./context.ts";
import { CliExit, EXIT } from "./output.ts";
import type { Style } from "./style.ts";

/**
 * The run's checkout for a person: a short path that opens on click, a shell in it, what changed
 * there. Pilot: `checkout: /Users/…/.jarvis/worktrees/5e6f7a8b9c0d/run_1a2b3c4d5e6f7a8b9c0d` with
 * "fix it there yourself" — copying a path of hashes to get to the files.
 */

/** `~/…` for a path under the home directory. */
export function homePath(path: string, homeDir: string): string {
  return homeDir && (path === homeDir || path.startsWith(`${homeDir}/`))
    ? `~${path.slice(homeDir.length)}`
    : path;
}

/** The checkout as `~/…`, a link that opens the folder where the terminal knows OSC 8. */
export function checkoutLink(st: Style, path: string, homeDir: string): string {
  return st.link(`file://${encodeURI(path)}`, homePath(path, homeDir));
}

/** Opens a shell in `dir` and waits until the person leaves it; false when it could not start. */
export type ShellIn = (dir: string, run: Run) => boolean;

/**
 * `$SHELL` (or `sh`), interactive, with `JARVIS_RUN` and `JARVIS_SHELL` set to the run's short id, so
 * a `jarvis continue` typed in it says to go back instead of starting the run a second time.
 */
export function systemShell(ctx: CliContext): ShellIn {
  return (dir, run) => {
    const env = ctx.env ?? {};
    const shell = env.SHELL || "/bin/sh";
    const r = spawnSync(`${shell} -i`, {
      cwd: dir,
      stdio: "inherit",
      shell: true,
      env: { ...process.env, ...env, JARVIS_RUN: shortRunId(run.id), JARVIS_SHELL: shortRunId(run.id) },
    });
    return !r.error;
  };
}

export interface Change {
  /** git's two-letter status, trimmed: `M`, `D`, `??`, `A`, `R`. */
  readonly code: string;
  readonly file: string;
}

/** Uncommitted changes in a checkout; undefined when it is not a git checkout. */
export function changesIn(dir: string): Change[] | undefined {
  const r = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (r.status !== 0) return undefined;
  return r.stdout
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => ({ code: l.slice(0, 2).trim(), file: l.slice(3).trim() }));
}

/** `D tmp-a.txt  M src/x.ts  +3` — the first few, deletions and additions coloured. */
export function formatChanges(changes: readonly Change[], st: Style, shown = 5): string {
  const label = (c: Change) => {
    const code = c.code === "??" ? "+" : c.code;
    const paint = code === "D" ? st.del : code === "+" || code === "A" ? st.add : st.warn;
    return `${paint(code)} ${c.file}`;
  };
  const more = changes.length > shown ? `  ${st.muted(`+${changes.length - shown}`)}` : "";
  return `${changes.slice(0, shown).map(label).join("  ")}${more}`;
}

/**
 * In the shell a run's card opened (`s`), `jarvis continue` would run the step under the card that is
 * still waiting: say how to get back instead. Pilot: typed there out of habit.
 */
export function refuseInsideRunShell(ctx: CliContext): void {
  const id = ctx.env?.JARVIS_SHELL;
  if (!id) return;
  ctx.out.error(
    `this is the shell jarvis opened for run ${id}: \`exit\` (Ctrl-D) goes back to its card, then r runs the step again`,
  );
  throw new CliExit(EXIT.error);
}

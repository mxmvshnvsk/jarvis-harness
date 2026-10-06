import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import type { Run } from "../core/domain/run.ts";
import { shortRunId } from "../storage/runStore.ts";
import type { CliContext } from "./context.ts";
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

/**
 * How a shell opened from a card ended: `go-on` — the person typed `jarvis continue` in it (the card
 * closed the shell and goes on); `left` — they left it themselves (`exit`, Ctrl-D); `failed` — it did
 * not start.
 */
export type ShellEnd = "go-on" | "left" | "failed";

/** Opens a shell in `dir` and waits until the person goes on or leaves it. */
export type ShellIn = (dir: string, run: Run) => Promise<ShellEnd>;

/** What the shell's `jarvis continue` asks the card for (src/cli/commands/run.ts). */
export const GO_ON = "go-on";

/**
 * `$SHELL` (or `sh`), interactive, in the run's checkout. The card stays in charge: `JARVIS_SHELL_REQUEST`
 * names a file where `jarvis continue` typed in the shell asks to go on; the card then closes the
 * shell (SIGHUP, as closing a terminal tab) and runs the step again. Pilot: the way back was `exit`,
 * which nobody guessed, and `jarvis c` in the shell failed.
 */
export function systemShell(ctx: CliContext): ShellIn {
  return (dir, run) =>
    new Promise((resolve) => {
      const env = ctx.env ?? {};
      const [command, ...args] = (env.SHELL || "/bin/sh").split(/\s+/).filter(Boolean);
      const box = mkdtempSync(join(tmpdir(), "jarvis-shell-"));
      const request = join(box, "request");
      const done = (end: ShellEnd) => {
        clearInterval(poll);
        rmSync(box, { recursive: true, force: true });
        resolve(end);
      };
      const child = spawn(command ?? "/bin/sh", [...args, "-i"], {
        cwd: dir,
        stdio: "inherit",
        env: {
          ...process.env,
          ...env,
          JARVIS_RUN: shortRunId(run.id),
          JARVIS_SHELL: shortRunId(run.id),
          JARVIS_SHELL_REQUEST: request,
          JARVIS_SHELL_PARENT: String(process.pid),
        },
      });
      let asked = false;
      const poll = setInterval(() => {
        if (!asked && existsSync(request)) {
          asked = true;
          child.kill("SIGHUP");
        }
      }, 200);
      child.on("error", () => done("failed"));
      child.on("exit", () => {
        // a shell closed by a signal may leave the terminal as its line editor had it
        if (asked && (process.stdin as { isTTY?: boolean }).isTTY)
          spawnSync("stty", ["sane"], { stdio: "inherit" });
        done(asked || existsSync(request) ? "go-on" : "left");
      });
    });
}

/**
 * `jarvis continue` typed in the shell a card opened: asks the card to go on and returns true; false
 * when this is no such shell or its card is gone (then the command does its usual work).
 */
export function askCardToGoOn(ctx: CliContext): boolean {
  const request = ctx.env?.JARVIS_SHELL_REQUEST;
  const parent = Number(ctx.env?.JARVIS_SHELL_PARENT);
  if (!request || !Number.isInteger(parent) || parent <= 0) return false;
  try {
    process.kill(parent, 0); // the card's process is still there
    writeFileSync(request, GO_ON);
  } catch {
    return false;
  }
  ctx.out.line(
    `${ctx.out.style.warn("↩")} back to the card of run ${ctx.env?.JARVIS_SHELL ?? "?"} — it goes on`,
  );
  return true;
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

/** Opens the run's checkout in the person's editor without waiting; the editor's name, or undefined. */
export type OpenIn = (dir: string) => string | undefined;

const EDITORS: ReadonlyArray<readonly [string, string]> = [
  ["code", "VS Code"],
  ["cursor", "Cursor"],
  ["webstorm", "WebStorm"],
  ["idea", "IntelliJ IDEA"],
  ["zed", "Zed"],
  ["subl", "Sublime Text"],
];

/** macOS apps that open a folder with `open -a`, when their command is not on PATH. */
const MAC_APPS: ReadonlyArray<readonly [string, string]> = [
  ["Visual Studio Code", "VS Code"],
  ["Cursor", "Cursor"],
  ["WebStorm", "WebStorm"],
  ["IntelliJ IDEA", "IntelliJ IDEA"],
  ["IntelliJ IDEA Ultimate", "IntelliJ IDEA"],
  ["IntelliJ IDEA CE", "IntelliJ IDEA"],
  ["Zed", "Zed"],
];

function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
  if (command.includes("/")) return existsSync(command);
  return (env.PATH ?? "").split(delimiter).some((dir) => dir.length > 0 && existsSync(join(dir, command)));
}

/**
 * The editor a checkout opens in: `JARVIS_EDITOR` (a command, may carry arguments: `idea`,
 * `code -n`), else the first known editor command on PATH, else (macOS) an installed editor app,
 * else the system's file opener. Pilot: "fix it there yourself" sent people to copy a path.
 */
export function editorFor(
  env: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform; home?: string } = {},
): { readonly command: readonly string[]; readonly label: string } | undefined {
  const own = env.JARVIS_EDITOR?.trim();
  if (own) {
    const command = own.split(/\s+/);
    const name = basename(command[0] as string);
    return { command, label: EDITORS.find(([c]) => c === name)?.[1] ?? name };
  }
  for (const [command, label] of EDITORS) if (onPath(command, env)) return { command: [command], label };
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    const home = options.home ?? homedir();
    for (const [app, label] of MAC_APPS)
      if ([`/Applications/${app}.app`, join(home, "Applications", `${app}.app`)].some((p) => existsSync(p)))
        return { command: ["open", "-a", app], label };
    return { command: ["open"], label: "Finder" };
  }
  if (platform !== "win32" && onPath("xdg-open", env))
    return { command: ["xdg-open"], label: "the file manager" };
  return undefined;
}

export function systemOpener(ctx: CliContext): OpenIn {
  return (dir) => {
    const env = ctx.env ?? {};
    const editor = editorFor(env, { home: ctx.homeDir });
    if (!editor) return undefined;
    const [command, ...args] = editor.command;
    try {
      const child = spawn(command as string, [...args, dir], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, ...env },
      });
      child.on("error", () => {});
      child.unref();
    } catch {
      return undefined;
    }
    return editor.label;
  };
}

/**
 * Calls `onChange` whenever the checkout's uncommitted changes differ from the last ones seen: the
 * card shows what the person did in the editor without being asked. Returns the stop function.
 */
export function watchCheckout(
  dir: string,
  onChange: (changes: readonly Change[]) => void,
  options: { everyMs?: number; read?: (dir: string) => Change[] | undefined } = {},
): () => void {
  const read = options.read ?? changesIn;
  const signature = (c: readonly Change[] | undefined) =>
    c
      ? c
          .map((x) => `${x.code} ${x.file}`)
          .sort()
          .join("\n")
      : undefined;
  let last = signature(read(dir));
  const timer = setInterval(() => {
    const now = read(dir);
    const sig = signature(now);
    if (now === undefined || sig === last) return;
    last = sig;
    onChange(now);
  }, options.everyMs ?? 1500);
  timer.unref?.();
  return () => clearInterval(timer);
}

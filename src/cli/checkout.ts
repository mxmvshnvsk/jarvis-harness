import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import type { Run } from "../core/domain/run.ts";
import { shortRunId } from "../storage/runStore.ts";
import { isScratchFile } from "../tools/local/scratch.ts";
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

/** A file to open for review, absolute, at the line worth looking at. */
export interface FileToOpen {
  readonly path: string;
  readonly line?: number;
}

/**
 * Opens the run's checkout in the person's editor, with the files to look at, without waiting;
 * returns the editor's name, or undefined when there is none.
 */
export type OpenIn = (dir: string, files?: readonly FileToOpen[]) => string | undefined;

/**
 * How an editor takes a folder and files at lines: `vscode` — `code <dir> -g a.ts:113 b.ts`;
 * `jetbrains` — `webstorm <dir> --line 113 a.ts b.ts` (the files open in that project, not in
 * LightEdit); `colon` — `zed <dir> a.ts:113`; `paths` — folder and files, no lines; `folder` — the
 * folder only (Finder, a file manager).
 */
export type EditorKind = "vscode" | "jetbrains" | "colon" | "paths" | "folder";

export interface Editor {
  readonly command: readonly string[];
  readonly label: string;
  readonly kind: EditorKind;
}

const EDITORS: ReadonlyArray<readonly [string, string, EditorKind]> = [
  ["code", "VS Code", "vscode"],
  ["cursor", "Cursor", "vscode"],
  ["webstorm", "WebStorm", "jetbrains"],
  ["idea", "IntelliJ IDEA", "jetbrains"],
  ["zed", "Zed", "colon"],
  ["subl", "Sublime Text", "colon"],
];

/** Other names a person may give in JARVIS_EDITOR. */
const KINDS: Readonly<Record<string, EditorKind>> = {
  codium: "vscode",
  "code-insiders": "vscode",
  windsurf: "vscode",
  pycharm: "jetbrains",
  goland: "jetbrains",
  phpstorm: "jetbrains",
  rider: "jetbrains",
  clion: "jetbrains",
  rubymine: "jetbrains",
  fleet: "paths",
};

/** macOS apps and the command-line launcher inside each, for when it is not on PATH. */
const MAC_APPS: ReadonlyArray<readonly [string, string, string, EditorKind]> = [
  ["Visual Studio Code", "VS Code", "Contents/Resources/app/bin/code", "vscode"],
  ["Cursor", "Cursor", "Contents/Resources/app/bin/cursor", "vscode"],
  ["WebStorm", "WebStorm", "Contents/MacOS/webstorm", "jetbrains"],
  ["IntelliJ IDEA", "IntelliJ IDEA", "Contents/MacOS/idea", "jetbrains"],
  ["IntelliJ IDEA Ultimate", "IntelliJ IDEA", "Contents/MacOS/idea", "jetbrains"],
  ["IntelliJ IDEA CE", "IntelliJ IDEA", "Contents/MacOS/idea", "jetbrains"],
  ["Zed", "Zed", "Contents/MacOS/cli", "colon"],
];

function onPath(command: string, env: NodeJS.ProcessEnv, extra: readonly string[] = []): string | undefined {
  if (command.includes("/")) return existsSync(command) ? command : undefined;
  for (const dir of [...(env.PATH ?? "").split(delimiter), ...extra]) {
    if (dir.length > 0 && existsSync(join(dir, command))) return join(dir, command);
  }
  return undefined;
}

/**
 * The editor a checkout opens in: `JARVIS_EDITOR` (a command, may carry arguments: `idea`,
 * `code -n`), else the first known editor command on PATH (and JetBrains Toolbox scripts), else
 * (macOS) the launcher inside an installed editor app, else the system's file opener. Pilot: "fix it
 * there yourself" sent people to copy a path; then `o` opened the folder without the files.
 */
export function editorFor(
  env: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform; home?: string } = {},
): Editor | undefined {
  const own = env.JARVIS_EDITOR?.trim();
  if (own) {
    const command = own.split(/\s+/);
    const name = basename(command[0] as string).replace(/\.(sh|cmd|exe)$/, "");
    const known = EDITORS.find(([c]) => c === name);
    return { command, label: known?.[1] ?? name, kind: known?.[2] ?? KINDS[name] ?? "paths" };
  }
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const toolbox =
    platform === "darwin" ? [join(home, "Library/Application Support/JetBrains/Toolbox/scripts")] : [];
  for (const [command, label, kind] of EDITORS) {
    const found = onPath(command, env, toolbox);
    if (found) return { command: [found], label, kind };
  }
  if (platform === "darwin") {
    for (const [app, label, launcher, kind] of MAC_APPS) {
      const bundle = [`/Applications/${app}.app`, join(home, "Applications", `${app}.app`)].find((p) =>
        existsSync(p),
      );
      if (!bundle) continue;
      const cli = join(bundle, launcher);
      return existsSync(cli)
        ? { command: [cli], label, kind }
        : { command: ["open", "-a", app], label, kind: "paths" };
    }
    return { command: ["open"], label: "Finder", kind: "folder" };
  }
  if (platform !== "win32" && onPath("xdg-open", env))
    return { command: ["xdg-open"], label: "the file manager", kind: "folder" };
  return undefined;
}

/** The command line that opens `dir` with `files` in `editor`. */
export function openCommand(editor: Editor, dir: string, files: readonly FileToOpen[] = []): string[] {
  const at = (f: FileToOpen) => (f.line ? `${f.path}:${f.line}` : f.path);
  const base = [...editor.command, dir];
  switch (editor.kind) {
    case "vscode":
      return files.length > 0 ? [...base, "-g", ...files.map(at)] : base;
    case "jetbrains":
      return [...base, ...files.flatMap((f) => (f.line ? ["--line", String(f.line), f.path] : [f.path]))];
    case "colon":
      return [...base, ...files.map(at)];
    case "paths":
      return [...base, ...files.map((f) => f.path)];
    case "folder":
      return base;
  }
}

export function systemOpener(ctx: CliContext): OpenIn {
  return (dir, files = []) => {
    const env = ctx.env ?? {};
    const editor = editorFor(env, { home: ctx.homeDir });
    if (!editor) return undefined;
    const [command, ...args] = openCommand(editor, dir, files);
    try {
      const child = spawn(command as string, args, {
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
 * What to open for review, in order: the files the reasons name (`…/a.test.tsx:113` — at that
 * line; a path cut with `…/` is matched against the changed files), then the files the run changed
 * against its base, most changed first, each at its first changed line; no deleted or scratch
 * files; at most `max`.
 */
export function reviewFiles(dir: string, base: string | undefined, reasons = "", max = 8): FileToOpen[] {
  const git = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  const changed: Array<{ file: string; size: number }> = [];
  const firstLine = new Map<string, number>();
  if (base) {
    const numstat = git(["diff", "--numstat", base]);
    if (numstat.status === 0)
      for (const l of numstat.stdout.split("\n").filter(Boolean)) {
        const [added, removed, file] = l.split("\t");
        if (file) changed.push({ file, size: (Number(added) || 0) + (Number(removed) || 0) });
      }
    changed.sort((a, b) => b.size - a.size);
    const hunks = git(["diff", "-U0", "--no-color", base]);
    let current: string | undefined;
    if (hunks.status === 0)
      for (const l of hunks.stdout.split("\n")) {
        if (l.startsWith("+++ ")) current = l.startsWith("+++ b/") ? l.slice(6) : undefined;
        const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
        if (current && m && !firstLine.has(current)) firstLine.set(current, Math.max(1, Number(m[1])));
      }
  }
  const out: FileToOpen[] = [];
  const seen = new Set<string>();
  const add = (file: string, line?: number) => {
    if (seen.has(file) || out.length >= max || isScratchFile(file)) return;
    const path = join(dir, file);
    if (!existsSync(path)) return;
    seen.add(file);
    out.push(line ? { path, line } : { path });
  };
  for (const m of reasons.matchAll(
    /(?:…\/|\.\.\.\/)?((?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z0-9]+)(?::(\d+))?/g,
  )) {
    const named = m[1] as string;
    const line = m[2] ? Number(m[2]) : undefined;
    const file = existsSync(join(dir, named))
      ? named
      : changed.find((c) => c.file === named || c.file.endsWith(`/${named}`))?.file;
    if (file) add(file, line);
  }
  for (const c of changed) add(c.file, firstLine.get(c.file));
  return out;
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

/** `upload-toggle.test.tsx:113, UploadToggle.tsx +1` — what an editor was asked to open, in a few words. */
export function describeFiles(files: readonly FileToOpen[], shown = 2): string {
  const name = (f: FileToOpen) => `${basename(f.path)}${f.line ? `:${f.line}` : ""}`;
  const more = files.length > shown ? ` +${files.length - shown}` : "";
  return `${files.slice(0, shown).map(name).join(", ")}${more}`;
}

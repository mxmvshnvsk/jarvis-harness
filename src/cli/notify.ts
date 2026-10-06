import type { CliContext } from "./context.ts";

/**
 * The terminal's own signals for a long run (src/cli/progress.ts): the tab title says where the run
 * is (`▶ 6/14 implementation`, `⏸ jarvis needs you`), and a desktop notification (or the bell) says
 * when it stopped for a person, finished or failed — a run of tens of minutes is not watched.
 *
 *   JARVIS_NOTIFY=auto|osc9|osc777|bel|off   how to notify; auto: OSC 9 in iTerm2, WezTerm and
 *                                            Ghostty, the bell elsewhere
 *   JARVIS_NOTIFY_AFTER=30                   seconds a run must have taken to be worth a notification
 *   JARVIS_TITLE=off                         leave the tab title alone
 *
 * Only on a terminal (not in a pipe, CI or `--json`); inside tmux notifications pass through
 * (`set -g allow-passthrough on`).
 */
export type NotifyMode = "osc9" | "osc777" | "bel" | "off";

/** Which terminal this is, from its environment: it decides which escape sequences it understands. */
export interface TerminalKind {
  readonly program:
    | "iterm"
    | "wezterm"
    | "ghostty"
    | "kitty"
    | "vscode"
    | "windows-terminal"
    | "conemu"
    | "apple-terminal"
    | "vte"
    | "other";
  /** `3.6.1` for iTerm2, when the terminal says. */
  readonly version?: string;
  readonly tmux: boolean;
}

export function terminalOf(env: NodeJS.ProcessEnv): TerminalKind {
  const program = `${env.TERM_PROGRAM ?? ""} ${env.LC_TERMINAL ?? ""}`;
  const tmux = Boolean(env.TMUX);
  const version = env.TERM_PROGRAM_VERSION ?? env.LC_TERMINAL_VERSION;
  const kind = (p: TerminalKind["program"]): TerminalKind => ({
    program: p,
    tmux,
    ...(version ? { version } : {}),
  });
  if (/iTerm/i.test(program)) return kind("iterm");
  if (/WezTerm/i.test(program)) return kind("wezterm");
  if (/ghostty/i.test(program) || /ghostty/.test(env.TERM ?? "")) return kind("ghostty");
  if (env.KITTY_WINDOW_ID || /kitty/.test(env.TERM ?? "")) return kind("kitty");
  if (/vscode/i.test(program)) return kind("vscode");
  if (env.WT_SESSION) return kind("windows-terminal");
  if (env.ConEmuANSI === "ON") return kind("conemu");
  if (/Apple_Terminal/.test(program)) return kind("apple-terminal");
  if (Number(env.VTE_VERSION ?? 0) >= 5000) return kind("vte");
  return kind("other");
}

const atLeast = (version: string | undefined, min: number[]) => {
  const v = (version ?? "").split(".").map(Number);
  for (let i = 0; i < min.length; i += 1) {
    const a = v[i] ?? 0;
    const b = min[i] as number;
    if (Number.isNaN(a)) return false;
    if (a !== b) return a > b;
  }
  return true;
};

const flag = (value: string | undefined): boolean | undefined =>
  value === undefined ? undefined : !/^(0|off|false|no)$/i.test(value);

/**
 * Progress in the tab or taskbar (OSC 9;4). Only where it is known to work: a terminal that shows
 * OSC 9 as a notification but does not know 9;4 would pop "4;1;50" up as one.
 */
export function supportsTabProgress(t: TerminalKind, env: NodeJS.ProcessEnv): boolean {
  return (
    flag(env.JARVIS_TAB_PROGRESS) ??
    (t.program === "windows-terminal" ||
      t.program === "conemu" ||
      t.program === "ghostty" ||
      (t.program === "iterm" && atLeast(t.version, [3, 6])))
  );
}

/** Clickable links (OSC 8); `FORCE_HYPERLINK=1|0` decides first, as in other tools. */
export function supportsHyperlinks(t: TerminalKind, env: NodeJS.ProcessEnv): boolean {
  return (
    flag(env.FORCE_HYPERLINK) ??
    (["wezterm", "ghostty", "kitty", "vscode", "windows-terminal", "vte"].includes(t.program) ||
      (t.program === "iterm" && atLeast(t.version, [3, 1])))
  );
}

/** Marks a jump-to-previous-mark key moves between (OSC 133); not through tmux. */
export function supportsMarks(t: TerminalKind, env: NodeJS.ProcessEnv): boolean {
  return (
    flag(env.JARVIS_MARKS) ??
    (!t.tmux && ["iterm", "wezterm", "ghostty", "kitty", "vscode", "windows-terminal"].includes(t.program))
  );
}

export type TabProgress = "hide" | "normal" | "error" | "indeterminate" | "warning";
const TAB_STATE: Record<TabProgress, number> = { hide: 0, normal: 1, error: 2, indeterminate: 3, warning: 4 };

export function tabProgressSequence(state: TabProgress, percent = 0): string {
  return `\u001b]9;4;${TAB_STATE[state]};${Math.max(0, Math.min(100, Math.round(percent)))}\u0007`;
}

/** A link the terminal opens on click; plain text where it cannot. */
export function hyperlink(url: string, text: string): string {
  return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
}

/** The start of a section of output, as shell integration marks a prompt. */
export const MARK = "\u001b]133;A\u0007";

export function notifyModeOf(env: NodeJS.ProcessEnv): NotifyMode {
  const set = env.JARVIS_NOTIFY?.toLowerCase();
  if (set === "osc9" || set === "osc777" || set === "bel" || set === "off") return set;
  const program = `${env.TERM_PROGRAM ?? ""} ${env.LC_TERMINAL ?? ""} ${env.TERM ?? ""}`;
  if (/iTerm|WezTerm|ghostty/i.test(program)) return "osc9";
  return "bel";
}

/** Text safe inside an OSC string: no control characters, no `;` (a field separator for OSC 777). */
const clean = (text: string) =>
  [...text]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f || ch === ";" ? " " : ch;
    })
    .join("")
    .slice(0, 200);

export function notifySequence(mode: NotifyMode, title: string, body: string): string {
  switch (mode) {
    case "osc9":
      return `\u001b]9;${clean(title)}: ${clean(body)}\u0007`;
    case "osc777":
      return `\u001b]777;notify;${clean(title)};${clean(body)}\u0007`;
    case "bel":
      return "\u0007";
    default:
      return "";
  }
}

export const titleSequence = (text: string) => `\u001b]2;${clean(text)}\u0007`;

/** tmux swallows OSC sequences unless they are wrapped for passthrough. */
export function passthrough(sequence: string, env: NodeJS.ProcessEnv): string {
  if (!env.TMUX || !sequence.startsWith("\u001b")) return sequence;
  return `\u001bPtmux;${sequence.replaceAll("\u001b", "\u001b\u001b")}\u001b\\`;
}

export interface TerminalSignals {
  title(text: string): void;
  notify(title: string, body: string): void;
  /** Progress in the tab: `normal` with the share of steps done, `warning` waiting, `error` failed. */
  progress(state: TabProgress, percent?: number): void;
  /** A mark before a step line or a gate (OSC 133), where the terminal moves between marks. */
  mark(): void;
}

let clearOnExit = false;

export function terminalSignals(ctx: CliContext, now: () => number = Date.now): TerminalSignals {
  const started = now();
  const env = ctx.env ?? {};
  const mode = notifyModeOf(env);
  const after = Number(env.JARVIS_NOTIFY_AFTER ?? 30) * 1000;
  const titles = env.JARVIS_TITLE?.toLowerCase() !== "off";
  const terminal = terminalOf(env);
  const tabProgress = supportsTabProgress(terminal, env);
  const marks = supportsMarks(terminal, env);
  return {
    progress(state, percent) {
      if (!tabProgress) return;
      ctx.out.terminal?.(passthrough(tabProgressSequence(state, percent), env));
      // a bar left in the tab after jarvis exits would claim a run is still going
      if (state !== "hide" && !clearOnExit) {
        clearOnExit = true;
        process.once("exit", () => ctx.out.terminal?.(passthrough(tabProgressSequence("hide"), env)));
      }
    },
    mark() {
      if (marks) ctx.out.terminal?.(MARK);
    },
    title(text) {
      if (titles) ctx.out.terminal?.(titleSequence(text));
    },
    notify(title, body) {
      if (mode === "off" || now() - started < after) return;
      ctx.out.terminal?.(passthrough(notifySequence(mode, title, body), env));
    },
  };
}

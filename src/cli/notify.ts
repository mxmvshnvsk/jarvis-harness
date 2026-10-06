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
}

export function terminalSignals(ctx: CliContext, now: () => number = Date.now): TerminalSignals {
  const started = now();
  const env = ctx.env ?? {};
  const mode = notifyModeOf(env);
  const after = Number(env.JARVIS_NOTIFY_AFTER ?? 30) * 1000;
  const titles = env.JARVIS_TITLE?.toLowerCase() !== "off";
  return {
    title(text) {
      if (titles) ctx.out.terminal?.(titleSequence(text));
    },
    notify(title, body) {
      if (mode === "off" || now() - started < after) return;
      ctx.out.terminal?.(passthrough(notifySequence(mode, title, body), env));
    },
  };
}

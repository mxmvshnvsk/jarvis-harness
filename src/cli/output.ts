import { supportsHyperlinks, terminalOf } from "./notify.ts";
import { colorEnabled, createStyle, cutStyled, type Style } from "./style.ts";

/** Exit codes (ADR-0009 §3). */
export const EXIT = {
  ok: 0,
  error: 1,
  waitingHuman: 10,
  waitingBudget: 11,
  policyDenied: 12,
  leaseLost: 13,
} as const;

export interface Output {
  readonly json: boolean;
  /** Styling for stdout (a no-op unless stdout is a colour terminal, see style.ts). */
  readonly style: Style;
  /** Styling for stderr: notices, the course of a run, the progress line. */
  readonly errStyle: Style;
  /** A line of the result on stdout; `backticked` spans render as commands. */
  line(text?: string): void;
  /** Text written as is (a diff, a document already rendered): no backtick handling. */
  raw(text: string): void;
  /** A prompt: written without a line break, the answer is typed after it. */
  ask(text: string): void;
  /** A failure on stderr, `error: …` (the prefix red when coloured). */
  error(text: string): void;
  /** Informational stderr: progress notices (⚠ retry, ✗ gave up), "skipped", "written to". */
  note(text: string): void;
  /** Prints the JSON document in `--json` mode, otherwise calls `render`. */
  result(value: unknown, render: () => void): void;
  /** Whether `progress` draws anything (a terminal on stderr, not `--json`, not JARVIS_PROGRESS=off). */
  readonly live: boolean;
  /**
   * How the course of a run is shown on stderr (`--progress`, JARVIS_PROGRESS): `live` — lines that
   * stay and a redrawn region (a terminal); `plain` — only lines, with a heartbeat (pipes, CI, nohup);
   * `json` — the run's events as JSON lines, nothing for people.
   */
  readonly progressMode: ProgressMode;
  /** One event as a JSON line on stderr (`progressMode` json). */
  event(value: unknown): void;
  /**
   * Redraws the live region on stderr — one line, or a few (`string[]`); `undefined` clears it. Other
   * output clears it first. Each line is cut to the terminal's width (read on every draw, so a
   * resize is followed); the redraw is one synchronized update, so it does not flicker.
   */
  progress(text?: string | readonly string[]): void;
  /** A control sequence for the terminal itself (title, notification), on stderr when it is one. */
  terminal(sequence: string): void;
}

export type ProgressMode = "live" | "plain" | "json";

/** `--progress auto|tty|plain|json` (or JARVIS_PROGRESS; `off` is the old spelling of `plain`). */
export function progressModeOf(setting: string | undefined, json: boolean, tty: boolean): ProgressMode {
  const s = (setting ?? "auto").toLowerCase();
  if (s === "json") return "json";
  if (s === "plain" || s === "off") return "plain";
  if (s === "tty") return "live";
  return !json && tty ? "live" : "plain";
}

export function createOutput(
  json: boolean,
  streams: { out: NodeJS.WritableStream; err: NodeJS.WritableStream },
  options: {
    progress?: boolean;
    /** `auto` (default), `tty`, `plain`, `json`. */
    progressSetting?: string;
    color?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Output {
  const err = streams.err as NodeJS.WritableStream & { isTTY?: boolean; columns?: number };
  const env = options.env ?? {};
  const linksHere = supportsHyperlinks(terminalOf(env), env);
  const colors = (stream: { isTTY?: boolean }) =>
    createStyle(
      colorEnabled({
        json,
        stream,
        ...(options.color !== undefined ? { flag: options.color } : {}),
        ...(options.env ? { env: options.env } : {}),
      }),
      // a link is an escape sequence: only for a terminal that opens it, never in a pipe or --json
      { links: !json && stream.isTTY === true && linksHere },
    );
  const style = colors(streams.out as { isTTY?: boolean });
  const errStyle = colors(err);
  const glyph = (text: string) =>
    text.replace(/^(⚠|⏸|✗)/, (g) => (g === "✗" ? errStyle.bad(g) : errStyle.warn(g)));
  const progressMode =
    options.progress === false ? "plain" : progressModeOf(options.progressSetting, json, err.isTTY === true);
  const live = progressMode === "live";
  let shown = 0;
  /** Erases the live region: the current line, then each line above it that belongs to it. */
  const erase = () => `\r\u001b[2K${"\u001b[1A\u001b[2K".repeat(Math.max(0, shown - 1))}`;
  const clear = () => {
    if (!shown) return;
    streams.err.write(erase());
    shown = 0;
  };
  return {
    json,
    live,
    progressMode,
    event(value) {
      if (progressMode === "json") streams.err.write(`${JSON.stringify(value)}\n`);
    },
    style,
    errStyle,
    line(text = "") {
      clear();
      streams.out.write(`${style.inline(text)}\n`);
    },
    raw(text) {
      clear();
      streams.out.write(`${text}\n`);
    },
    ask(text) {
      clear();
      streams.out.write(text);
    },
    error(text) {
      clear();
      const prefix = errStyle.enabled ? `\u001b[1m${errStyle.bad("error:")}\u001b[22m` : "error:";
      streams.err.write(`${prefix} ${errStyle.inline(text)}\n`);
    },
    note(text) {
      clear();
      streams.err.write(`${glyph(errStyle.inline(text))}\n`);
    },
    result(value, render) {
      clear();
      if (json) streams.out.write(`${JSON.stringify(value, null, 2)}\n`);
      else render();
    },
    progress(text) {
      if (!live) return;
      if (text === undefined) return clear();
      const lines = typeof text === "string" ? [text] : [...text];
      const columns = Math.max(20, (err.columns ?? 120) - 1);
      const body = lines.map((l) => cutStyled(l, columns)).join("\n");
      // DEC 2026 synchronized output: terminals that know it paint the frame at once; others ignore it
      streams.err.write(`\u001b[?2026h${erase()}${body}\u001b[?2026l`);
      shown = lines.length;
    },
    terminal(sequence) {
      if (live) streams.err.write(sequence);
    },
  };
}

export class CliExit extends Error {
  readonly code: number;

  constructor(code: number, message?: string) {
    super(message ?? `exit ${code}`);
    this.name = "CliExit";
    this.code = code;
  }
}

export function formatValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

export function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

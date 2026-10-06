import type { ArtifactVersion } from "../core/domain/artifact.ts";

/**
 * Terminal styling of human-readable output, one small palette for every command (the
 * conventions of git, gh and cargo): headings bold, the thing a line is about bold cyan,
 * metadata and ids dim, commands to type cyan, success / additions green, warnings yellow,
 * failures / removals red. Content stays in the default colour.
 *
 * Colour is on only for a terminal and never in `--json`; `--no-color` / `--color`, then
 * `NO_COLOR` (https://no-color.org), `FORCE_COLOR` and `TERM=dumb` decide before that.
 */
export interface Style {
  readonly enabled: boolean;
  /** Whether `link` makes clickable links (a terminal that knows OSC 8). */
  readonly links: boolean;
  /** Section and document headings. */
  heading(text: string): string;
  /** The handle a line is about: a candidate, a run, a module. */
  name(text: string): string;
  /** Metadata: ids, times, field labels, separators, footnotes. */
  muted(text: string): string;
  /** A command to type. */
  cmd(text: string): string;
  ok(text: string): string;
  warn(text: string): string;
  bad(text: string): string;
  /** Diff and count semantics. */
  add(text: string): string;
  del(text: string): string;
  /** A run or step state coloured by what it means. */
  state(state: string): string;
  /** `text` (e.g. a padded cell) in the colour of `state`. */
  byState(state: string, text: string): string;
  /** Backticked spans of a message rendered as commands (backticks dropped when coloured). */
  inline(text: string): string;
  /** `text` the terminal opens `url` on click (OSC 8), where it can; the text alone elsewhere. */
  link(url: string, text: string): string;
}

export interface ColorOptions {
  /** `--color` (true) / `--no-color` (false); undefined = decide from the environment. */
  readonly flag?: boolean;
  readonly json?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly stream?: { isTTY?: boolean };
}

export function colorEnabled(options: ColorOptions): boolean {
  if (options.json) return false;
  if (options.flag !== undefined) return options.flag;
  const env = options.env ?? {};
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force !== "false";
  if (env.TERM === "dumb") return false;
  return options.stream?.isTTY === true;
}

const sgr = (open: number, close: number) => (text: string) =>
  text === "" ? text : `\u001b[${open}m${text}\u001b[${close}m`;

const bold = sgr(1, 22);
const dim = sgr(2, 22);
const red = sgr(31, 39);
const green = sgr(32, 39);
const yellow = sgr(33, 39);
const cyan = sgr(36, 39);

const STATE_TONE: Record<string, "ok" | "warn" | "bad" | "muted" | "active"> = {
  COMPLETED: "ok",
  DONE: "ok",
  SUCCEEDED: "ok",
  approve: "ok",
  FAILED: "bad",
  ERROR: "bad",
  reject: "bad",
  CANCELLED: "muted",
  SKIPPED: "muted",
  RUNNING: "active",
  CREATED: "active",
  PENDING: "active",
  success: "ok",
  failure: "bad",
  suspended: "warn",
};

function byState(state: string, text: string): string {
  const tone = STATE_TONE[state] ?? (state.startsWith("WAITING") ? "warn" : undefined);
  if (tone === "ok") return green(text);
  if (tone === "bad") return red(text);
  if (tone === "warn") return yellow(text);
  if (tone === "muted") return dim(text);
  if (tone === "active") return cyan(text);
  return text;
}

export function createStyle(enabled: boolean, options: { links?: boolean } = {}): Style {
  const id = (text: string) => text;
  const link = options.links
    ? (url: string, text: string) => `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`
    : (_url: string, text: string) => text;
  if (!enabled) {
    return {
      links: options.links === true,
      link,
      enabled,
      heading: id,
      name: id,
      muted: id,
      cmd: id,
      ok: id,
      warn: id,
      bad: id,
      add: id,
      del: id,
      state: id,
      byState: (_state, text) => text,
      inline: id,
    };
  }
  return {
    enabled,
    links: options.links === true,
    heading: bold,
    name: (text) => bold(cyan(text)),
    muted: dim,
    cmd: cyan,
    ok: green,
    warn: yellow,
    bad: red,
    add: green,
    del: red,
    state: (state) => byState(state, state),
    byState,
    inline: (text) => text.replace(/`([^`\n]+)`/g, (_m, code: string) => cyan(code)),
    link,
  };
}

/** `research (tool limit)` for an artifact whose agent stopped on a limit; undefined otherwise. */
export function incompleteOf(
  a: Pick<ArtifactVersion, "provenance">,
): { agentId: string; limit: string } | undefined {
  const p = a.provenance;
  return p.kind === "agent" && p.budgetExhausted
    ? { agentId: p.agentId, limit: p.budgetExhausted === "model" ? "model call" : "tool call" }
    : undefined;
}

export const PLAIN: Style = createStyle(false);

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI = /\u001b\[[0-9;]*m|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Length as the terminal shows it (escapes do not take columns). */
export function visibleLength(text: string): number {
  return [...text.replace(ANSI, "")].length;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** `padEnd` that ignores escapes, for columns of styled cells. */
export function padStyled(text: string, width: number): string {
  const n = visibleLength(text);
  return n >= width ? text : text + " ".repeat(width - n);
}

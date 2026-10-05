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
  line(text?: string): void;
  error(text: string): void;
  /** Prints the JSON document in `--json` mode, otherwise calls `render`. */
  result(value: unknown, render: () => void): void;
  /** Whether `progress` draws anything (a terminal on stderr, not `--json`, not JARVIS_PROGRESS=off). */
  readonly live: boolean;
  /** Redraws the one-line progress on stderr; `undefined` clears it. Other output clears it first. */
  progress(text?: string): void;
}

export function createOutput(
  json: boolean,
  streams: { out: NodeJS.WritableStream; err: NodeJS.WritableStream },
  options: { progress?: boolean } = {},
): Output {
  const err = streams.err as NodeJS.WritableStream & { isTTY?: boolean; columns?: number };
  const live = !json && options.progress !== false && err.isTTY === true;
  let shown = false;
  const clear = () => {
    if (!shown) return;
    streams.err.write("\r\u001b[2K");
    shown = false;
  };
  return {
    json,
    live,
    line(text = "") {
      clear();
      streams.out.write(`${text}\n`);
    },
    error(text) {
      clear();
      streams.err.write(`${text}\n`);
    },
    result(value, render) {
      clear();
      if (json) streams.out.write(`${JSON.stringify(value, null, 2)}\n`);
      else render();
    },
    progress(text) {
      if (!live) return;
      if (text === undefined) return clear();
      const width = Math.max(20, (err.columns ?? 120) - 1);
      const line = [...text].length > width ? `${[...text].slice(0, width - 1).join("")}…` : text;
      streams.err.write(`\r\u001b[2K${line}`);
      shown = true;
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

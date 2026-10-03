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
}

export function createOutput(
  json: boolean,
  streams: { out: NodeJS.WritableStream; err: NodeJS.WritableStream },
): Output {
  return {
    json,
    line(text = "") {
      streams.out.write(`${text}\n`);
    },
    error(text) {
      streams.err.write(`${text}\n`);
    },
    result(value, render) {
      if (json) streams.out.write(`${JSON.stringify(value, null, 2)}\n`);
      else render();
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

import { createInterface } from "node:readline";
import type { Output } from "./output.ts";

/**
 * Questions in the terminal (ADR-0019 §4 live mode): one reader per command over stdin, so a run
 * that stops for a person asks there and goes on, instead of exiting with a command to type.
 * Only for a person at a terminal: stdin and stdout are TTYs, not `--json`, `interactive` is on,
 * JARVIS_INTERACTIVE is not `off` (`on` forces it, for tests and screen recordings).
 */
export interface Prompt {
  /** The answer, trimmed; undefined when input ended (Ctrl-D, closed pipe). */
  ask(question: string): Promise<string | undefined>;
  close(): void;
}

export function isInteractive(options: {
  readonly json: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin?: { isTTY?: boolean };
  readonly stdout?: { isTTY?: boolean };
  readonly configInteractive: boolean;
}): boolean {
  const flag = options.env.JARVIS_INTERACTIVE;
  if (options.json || flag === "off" || !options.configInteractive) return false;
  if (flag === "on") return true;
  return options.stdin?.isTTY === true && options.stdout?.isTTY === true;
}

export function createPrompt(input: NodeJS.ReadableStream, out: Output): Prompt {
  const rl = createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  let closed = false;
  return {
    async ask(question) {
      if (closed) return undefined;
      out.ask(question);
      const next = await lines.next();
      if (next.done) {
        closed = true;
        out.line();
        return undefined;
      }
      return String(next.value).trim();
    },
    close() {
      if (closed) return;
      closed = true;
      rl.close();
    },
  };
}

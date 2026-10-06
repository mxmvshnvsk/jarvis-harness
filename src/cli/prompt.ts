import { createInterface } from "node:readline";
import type { Output } from "./output.ts";

/**
 * Questions in the terminal (ADR-0019 §4 live mode): one reader per command over stdin, so a run
 * that stops for a person asks there and goes on, instead of exiting with a command to type.
 * Only for a person at a terminal: stdin and stdout are TTYs, not `--json`, `interactive` is on,
 * JARVIS_INTERACTIVE is not `off` (`on` forces it, for tests and screen recordings).
 */
export interface Prompt {
  /**
   * The answer, trimmed; undefined when input ended (Ctrl-D, closed pipe) or `signal` was aborted —
   * a card that saw a decision made elsewhere stops asking (ADR-0023 §4). No read leaks from an
   * abandoned question: a line typed after it is dropped, the next question reads its own.
   */
  ask(question: string, options?: { readonly signal?: AbortSignal }): Promise<string | undefined>;
  /** Stops reading stdin while another program owns the terminal (a shell from the card), and back. */
  pause?(): void;
  resume?(): void;
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
  /** The read in flight, and whether a question waits on it now. */
  let pending: Promise<IteratorResult<string>> | undefined;
  let asking = false;
  return {
    async ask(question, options = {}) {
      const signal = options.signal;
      if (closed || signal?.aborted) return undefined;
      out.ask(question);
      if (!pending) {
        const fresh = lines.next();
        pending = fresh;
        // a line that comes after its question was abandoned answers nothing: it is dropped, so a
        // key meant for a card that went on never decides the next one
        fresh.then(
          (r) => {
            if (pending !== fresh || asking) return;
            pending = undefined;
            if (r.done) closed = true;
          },
          () => {},
        );
      }
      const read = pending;
      asking = true;
      let next: IteratorResult<string> | undefined;
      try {
        next = signal
          ? await new Promise<IteratorResult<string> | undefined>((resolve) => {
              const onAbort = () => resolve(undefined);
              signal.addEventListener("abort", onAbort, { once: true });
              read.then(
                (r) => {
                  signal.removeEventListener("abort", onAbort);
                  resolve(r);
                },
                () => resolve({ done: true, value: undefined }),
              );
            })
          : await read;
      } finally {
        asking = false;
      }
      if (next === undefined) return undefined; // abandoned
      pending = undefined;
      if (next.done) {
        closed = true;
        out.line();
        return undefined;
      }
      return String(next.value).trim();
    },
    pause() {
      rl.pause();
    },
    resume() {
      rl.resume();
    },
    close() {
      if (closed) return;
      closed = true;
      rl.close();
    },
  };
}

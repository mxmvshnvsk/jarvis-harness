/**
 * Ctrl-C in two stages (clig.dev): the first asks the run in this process to stop where it can keep
 * its place — the model call in flight is cancelled, the agent's conversation is kept in a
 * checkpoint, the run parks (SUSPENDED) and `jarvis continue` goes on from there; the second quits at
 * once. One per process: a CLI command follows one run at a time.
 */
export class InterruptedError extends Error {
  constructor(message = "interrupted (Ctrl-C)") {
    super(message);
    this.name = "InterruptedError";
  }
}

let controller = new AbortController();

export const interruption = {
  get requested(): boolean {
    return controller.signal.aborted;
  },
  /** Aborts what listens to it (a model call in flight) and makes the next safe point stop. */
  get signal(): AbortSignal {
    return controller.signal;
  },
  request(): void {
    if (!controller.signal.aborted) controller.abort(new InterruptedError());
  },
  /** A new run (or a test) starts without the last request. */
  reset(): void {
    controller = new AbortController();
  },
  throwIfRequested(): void {
    if (controller.signal.aborted) throw new InterruptedError();
  },
};

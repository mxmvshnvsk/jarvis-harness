import { isTerminal, type Run } from "../core/domain/run.ts";
import { budgetGranted } from "./budgetStop.ts";
import { awaitedArtifact, decisionOn, rerunRequested, waitingCard } from "./decide.ts";
import type { Runtime } from "./runtime.ts";

/**
 * A run that nobody moves on and that `jarvis resume` would take further (ADR-0023 §6): what the
 * page's "Resume" offers. Pilot: a research started in a terminal stopped on its agent's tool calls,
 * the terminal's card was left with `q`, more was granted on the page — and nothing went on: the
 * page resumed only the runs it had started itself.
 *
 * - `decided` — it waits for a person, the decision is there (more budget, run again, an approval),
 *   and no terminal waits at its card to go on with it;
 * - `interrupted` — RUNNING, but its process is gone (Ctrl-C before the state was saved, a crash);
 * - `suspended` — stopped with Ctrl-C;
 * - `quota` — parked on a quota window or a model: it tries at once and parks again if still full.
 *
 * A FAILED run is not offered: what failed is for a person to read first (`jarvis continue`).
 */
export type Resumable = "decided" | "interrupted" | "suspended" | "quota";

export function resumableOf(runtime: Runtime, run: Run, now = Date.now()): Resumable | undefined {
  if (isTerminal(run.state) || waitingCard(runtime, run.id)) return undefined;
  switch (run.state) {
    case "WAITING_BUDGET":
      return "quota";
    case "SUSPENDED":
      return "suspended";
    case "RUNNING":
      return run.lease && Date.parse(run.lease.until) >= now ? undefined : "interrupted";
    case "WAITING_HUMAN":
      return decidedOn(runtime, run) ? "decided" : undefined;
    default:
      return undefined;
  }
}

/** The person's decision for the stop the run waits at, made on the page or in a terminal. */
function decidedOn(runtime: Runtime, run: Run): boolean {
  const kind = run.waitingFor?.kind;
  if (kind === "budget") return budgetGranted(runtime, run.id) !== undefined;
  if (kind === "loop") return rerunRequested(runtime, run.id) !== undefined;
  const awaited = kind === "approval" || !kind ? awaitedArtifact(runtime, run) : undefined;
  return awaited ? decisionOn(runtime, awaited.artifact) !== undefined : false;
}

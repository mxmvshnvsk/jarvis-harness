import type { Runtime } from "./runtime.ts";

/**
 * How a step that stopped on a limit was going, from its journal — no model: whether its last calls
 * were new work or the same again. The judge of an autonomous run reads it first (a clear loop is a
 * no, clear progress a yes); a person asked for more sees it on the stop's card, with the calls.
 */
export type StallVerdict = "loop" | "progress" | "unclear";

export interface StallCall {
  readonly capability: string;
  readonly args: string;
  readonly ok: boolean;
  /** This call, with these arguments, was made before in the step. */
  readonly repeat: boolean;
}

export interface StallSignals {
  readonly verdict: StallVerdict;
  readonly calls: number;
  /** Calls made again with the same arguments, in the whole step. */
  readonly repeats: number;
  /** Reads of a file the agent already had (the runtime answered with a pointer). */
  readonly rereads: number;
  readonly errors: number;
  /** The share of new calls among the last ones (WINDOW), 0..1. */
  readonly novelty: number;
  /** The calls made most often, with how many times: the loop's evidence. */
  readonly top: ReadonlyArray<{ readonly call: string; readonly times: number }>;
  /** The last calls, newest last: the log a person reads. */
  readonly recent: readonly StallCall[];
  /** For people, one line: what the journal shows. */
  readonly summary: string;
}

/** The last calls the verdict weighs. */
export const WINDOW = 12;

const short = (args: string, n = 120) => {
  const one = args.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** The step's calls and their repeats, from its `tool.call` and `tool.reread` events. */
export function stallSignalsOf(
  runtime: Runtime,
  runId: string,
  stepId: string,
  iteration: number,
): StallSignals {
  const events = runtime.events
    .list({ runId, kinds: ["tool.call", "tool.reread"], limit: 100_000 })
    .filter((e) => e.stepId === stepId && (e.iteration ?? 1) === iteration);
  const seen = new Map<string, number>();
  const calls: StallCall[] = [];
  let rereads = 0;
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.kind === "tool.reread") {
      rereads += 1;
      continue;
    }
    const capability = typeof p.capability === "string" ? p.capability : "?";
    const args = typeof p.args === "string" ? p.args : "";
    const key = `${capability} ${args}`;
    const times = (seen.get(key) ?? 0) + 1;
    seen.set(key, times);
    calls.push({ capability, args, ok: p.ok !== false, repeat: times > 1 });
  }
  const last = calls.slice(-WINDOW);
  const fresh = last.filter((c) => !c.repeat).length;
  const novelty = last.length > 0 ? fresh / last.length : 1;
  const repeats = calls.filter((c) => c.repeat).length;
  const errors = calls.filter((c) => !c.ok).length;
  const lastErrors = last.filter((c) => !c.ok).length;
  // the same call three times running, or half of the last calls repeats: going round
  const running = last.length >= 3 && last.slice(-3).every((c) => c.repeat && c.args === last.at(-1)?.args);
  // too few calls to tell (a step that spent its tokens thinking, not calling): the judge weighs it
  const verdict: StallVerdict =
    last.length < 4
      ? "unclear"
      : running || novelty <= 0.5 || lastErrors >= last.length * 0.75
        ? "loop"
        : novelty >= 0.8 && lastErrors <= 1 && rereads <= Math.max(2, calls.length * 0.1)
          ? "progress"
          : "unclear";
  const top = [...seen.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([call, times]) => ({ call: short(call), times }));
  const pct = Math.round(novelty * 100);
  const summary =
    verdict === "loop"
      ? `going round: ${last.length - fresh} of the last ${last.length} calls repeat earlier ones${top[0] ? ` (${top[0].call} ×${top[0].times})` : ""}${lastErrors > 0 ? `, ${lastErrors} failed` : ""}`
      : verdict === "progress"
        ? `still finding new things: ${pct}% of the last ${last.length} calls are new — the task needs more than the limit`
        : `mixed: ${pct}% of the last ${last.length} calls are new, ${repeats} repeats and ${rereads} re-reads in the step`;
  return {
    verdict,
    calls: calls.length,
    repeats,
    rereads,
    errors,
    novelty,
    top,
    recent: last.map((c) => ({ ...c, args: short(c.args) })),
    summary,
  };
}

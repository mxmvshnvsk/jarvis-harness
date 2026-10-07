import { activityOf } from "./activity.ts";
import type { Runtime } from "./runtime.ts";

/**
 * How many model requests run at once, over every run and process: what `limits.concurrency` of a pool
 * would cap. A model's `maxConcurrency` holds inside one process only, and every run is a process of its
 * own (the page's Ask too), so this is the number to watch before a pool needs a limit of its own.
 */
export interface ModelLoad {
  /** Steps waiting for a model's answer now, in runs that are alive. */
  readonly inFlight: ReadonlyArray<{
    readonly run: string;
    readonly step: string;
    readonly modelId?: string;
    readonly waitingMs: number;
  }>;
  /** The most requests at once today (from the answers' ends and latencies), and when. */
  readonly peak?: { readonly count: number; readonly at: string };
}

const short = (id: string) => id.replace(/^run_/, "").slice(0, 8);

export function modelLoadOf(runtime: Runtime, now: Date = new Date()): ModelLoad {
  const inFlight: Array<ModelLoad["inFlight"][number]> = [];
  for (const run of runtime.runs.list({ state: ["RUNNING"], limit: 200 })) {
    if (!run.lease || Date.parse(run.lease.until) < now.getTime()) continue;
    const a = activityOf(runtime.events.list({ runId: run.id, limit: 1_000_000 }), now);
    // waiting for the model, not running the tools of its last answer
    if (!a?.step || a.finished || a.waitingMs === undefined || a.batch?.running) continue;
    inFlight.push({
      run: short(run.id),
      step: a.step.id,
      ...(a.step.modelId ? { modelId: a.step.modelId } : {}),
      waitingMs: a.waitingMs,
    });
  }
  // today's answers as intervals [end − latency, end]; the most of them over one another
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const edges: Array<[number, 1 | -1]> = [];
  for (const e of runtime.events.list({ kind: "model.call", since: midnight.toISOString(), limit: 50_000 })) {
    const end = Date.parse(e.ts);
    const ms = Number((e.payload as Record<string, unknown> | undefined)?.latencyMs) || 0;
    if (ms <= 0) continue;
    edges.push([end - ms, 1], [end, -1]);
  }
  // an end before a start at the same moment: back-to-back calls are not at once
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let open = 0;
  let peak: { count: number; at: string } | undefined;
  for (const [t, d] of edges) {
    open += d;
    if (open > (peak?.count ?? 1)) peak = { count: open, at: new Date(t).toISOString() };
  }
  return { inFlight, ...(peak ? { peak } : {}) };
}

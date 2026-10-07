import type { Run } from "../core/domain/run.ts";
import type { StoredEvent } from "../telemetry/events.ts";
import { reasonOf } from "./activity.ts";
import { failureReason, type ModelStats, modelStats, type Percentiles, percentiles } from "./modelStats.ts";
import type { Runtime } from "./runtime.ts";

/**
 * How each configured model is doing right now, for the `models` indicator of `jarvis ui` (ADR-0023):
 * the quota window of its pool, what the last half hour of calls says, and the runs waiting for it.
 * One state per model and the worst of them overall — green, yellow, red — so a glance at the header
 * answers "is it the model or my run?". Pilot: a gateway down for an afternoon was found by reading
 * the terminal of each run.
 */
export type HealthState = "ok" | "busy" | "down" | "idle";

export interface ModelHealth {
  readonly id: string;
  readonly state: HealthState;
  /** Why it is not simply fine, most important first; empty when it is. */
  readonly reasons: readonly string[];
  readonly pool: string;
  readonly window?: {
    readonly outputTokens: number;
    readonly outputLimit?: number;
    readonly requests: number;
    readonly requestLimit?: number;
    /** The larger of the used shares; undefined without limits. */
    readonly share?: number;
    /** The pool's soft threshold (0..1). */
    readonly soft: number;
    readonly minutes: number;
  };
  readonly recent: {
    readonly minutes: number;
    readonly calls: number;
    readonly failed: number;
    readonly retries: number;
    readonly latencyP50Ms?: number;
    readonly lastCallAt?: string;
    readonly lastFailure?: { readonly at: string; readonly reason: string };
  };
  /**
   * How it answers over the same half hour (src/app/modelStats.ts): latency, first token, speed,
   * throughput, tokens per call, cache. Pilot: "is it slow, or is my prompt huge?" was a question for
   * `jarvis models stats` in another terminal.
   */
  readonly perf?: ModelPerf;
  /** Requests being answered now (a progress event in the last 20 s and no answer since). */
  readonly inFlight: { readonly calls: number; readonly longestMs?: number };
  /** Short ids of the runs waiting for this model to answer again, and for its quota window. */
  readonly waiting: { readonly model: readonly string[]; readonly quota: readonly string[] };
}

export interface ModelPerf {
  readonly latencyMs?: Percentiles;
  readonly firstTokenMs?: Percentiles;
  readonly streamed: number;
  /** Output tokens per second of answering, per call. */
  readonly outputPerSecond?: Percentiles;
  /** Tokens moved per minute over the window: what the model actually got through. */
  readonly outputPerMinute: number;
  readonly promptPerMinute: number;
  readonly prompt: { readonly avg: number; readonly max: number; readonly total: number };
  readonly output: { readonly avg: number; readonly max: number; readonly total: number };
  readonly cachedShare: number;
  readonly prefixReuseP50?: number;
  /** Answers cut at maxOutput (`finish_reason: length`). */
  readonly cut: number;
  readonly successRate: number;
  readonly retriedCalls: number;
}

export interface ModelsHealth {
  readonly state: HealthState;
  readonly models: readonly ModelHealth[];
  readonly at: string;
}

const RANK: Record<HealthState, number> = { idle: 0, ok: 1, busy: 2, down: 3 };
const RECENT_MINUTES = 30;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const short = (id: string) => id.replace(/^run_/, "").slice(0, 8);

export interface HealthInput {
  readonly models: ReadonlyArray<{ readonly id: string; readonly pool: string }>;
  readonly pool: (name: string) =>
    | {
        readonly soft: number;
        readonly minutes: number;
        readonly outputLimit?: number;
        readonly requestLimit?: number;
        readonly outputTokens: number;
        readonly requests: number;
      }
    | undefined;
  /** `model.call`, `model.retry`, `model.error`, `model.progress` of the last half hour. */
  readonly events: readonly StoredEvent[];
  /** Runs parked in WAITING_BUDGET, with the model they wait on. */
  readonly parked: ReadonlyArray<{ readonly run: Run; readonly modelId?: string }>;
  readonly now: Date;
}

export function modelsHealth(input: HealthInput): ModelsHealth {
  const stats = new Map(
    modelStats(input.events.filter((e) => e.kind !== "model.progress")).map((s) => [s.modelId, s]),
  );
  const models = input.models.map((m) => healthOf(m, input, stats.get(m.id)));
  const state = models.reduce<HealthState>(
    (worst, m) => (RANK[m.state] > RANK[worst] ? m.state : worst),
    "idle",
  );
  return { state, models, at: input.now.toISOString() };
}

function perfOf(s: ModelStats): ModelPerf {
  return {
    ...(s.latencyMs ? { latencyMs: s.latencyMs } : {}),
    ...(s.streamed?.firstTokenMs ? { firstTokenMs: s.streamed.firstTokenMs } : {}),
    streamed: s.streamed?.calls ?? 0,
    ...(s.outputPerSecond ? { outputPerSecond: s.outputPerSecond } : {}),
    outputPerMinute: Math.round(s.outputTokens.total / RECENT_MINUTES),
    promptPerMinute: Math.round(s.promptTokens.total / RECENT_MINUTES),
    prompt: s.promptTokens,
    output: s.outputTokens,
    cachedShare: s.cachedShare,
    ...(s.prefixReuse ? { prefixReuseP50: s.prefixReuse.p50 } : {}),
    // finish_reason "length": the answer hit maxOutput
    cut: s.finishReasons.length ?? 0,
    successRate: s.successRate,
    retriedCalls: s.retriedCalls,
  };
}

/** Streams of this model that reported progress lately and have not been answered since. */
function inFlightOf(
  modelId: string,
  events: readonly StoredEvent[],
  now: Date,
): { calls: number; longestMs?: number } {
  const key = (e: StoredEvent) => `${e.runId ?? "-"}/${e.stepId ?? "-"}`;
  const last = new Map<string, StoredEvent>();
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (
      p.modelId !== modelId ||
      (e.kind !== "model.progress" && e.kind !== "model.call" && e.kind !== "model.error")
    )
      continue;
    const k = key(e);
    const seen = last.get(k);
    if (!seen || e.seq > seen.seq) last.set(k, e);
  }
  const live = [...last.values()].filter(
    (e) => e.kind === "model.progress" && now.getTime() - Date.parse(e.ts) < 20_000,
  );
  const longest = Math.max(0, ...live.map((e) => num((e.payload as Record<string, unknown>).elapsedMs)));
  return { calls: live.length, ...(live.length > 0 ? { longestMs: longest } : {}) };
}

function healthOf(m: { id: string; pool: string }, input: HealthInput, stats?: ModelStats): ModelHealth {
  const pay = (e: StoredEvent) => (e.payload ?? {}) as Record<string, unknown>;
  const mine = input.events.filter((e) => str(pay(e).modelId) === m.id);
  const calls = mine.filter((e) => e.kind === "model.call");
  const errors = mine.filter((e) => e.kind === "model.error");
  const retries = mine.filter((e) => e.kind === "model.retry").length;
  const lastCallAt = calls
    .map((e) => e.ts)
    .sort()
    .at(-1);
  const lastError = [...errors].sort((a, b) => a.ts.localeCompare(b.ts)).at(-1);
  const latency = percentiles(calls.map((e) => num(pay(e).latencyMs)).filter((v) => v > 0));
  const recent = {
    minutes: RECENT_MINUTES,
    calls: calls.length,
    failed: errors.length,
    retries,
    ...(latency ? { latencyP50Ms: latency.p50 } : {}),
    ...(lastCallAt ? { lastCallAt } : {}),
    ...(lastError ? { lastFailure: { at: lastError.ts, reason: failureReason(pay(lastError)) } } : {}),
  };

  const usage = input.pool(m.pool);
  const shares = usage
    ? [
        usage.outputLimit ? usage.outputTokens / usage.outputLimit : undefined,
        usage.requestLimit ? usage.requests / usage.requestLimit : undefined,
      ].filter((v): v is number => v !== undefined)
    : [];
  const share = shares.length > 0 ? Math.max(...shares) : undefined;
  const window = usage
    ? {
        outputTokens: usage.outputTokens,
        ...(usage.outputLimit ? { outputLimit: usage.outputLimit } : {}),
        requests: usage.requests,
        ...(usage.requestLimit ? { requestLimit: usage.requestLimit } : {}),
        ...(share !== undefined ? { share } : {}),
        soft: usage.soft,
        minutes: usage.minutes,
      }
    : undefined;

  const waitingModel = input.parked
    .filter((p) => p.run.waitingFor?.kind === "model" && p.run.waitingFor.detail === m.id)
    .map((p) => short(p.run.id));
  const waitingQuota = input.parked
    .filter((p) => p.run.waitingFor?.kind !== "model" && p.modelId === m.id)
    .map((p) => short(p.run.id));

  const reasons: string[] = [];
  let state: HealthState = calls.length > 0 || (usage?.requests ?? 0) > 0 ? "ok" : "idle";
  const worse = (s: HealthState) => {
    if (RANK[s] > RANK[state]) state = s;
  };
  // down: it gave up and has not answered since, runs wait for it, or the window is used up
  const unanswered = lastError && (!lastCallAt || lastError.ts > lastCallAt);
  if (waitingModel.length > 0 || unanswered) {
    worse("down");
    const run = input.parked.find(
      (p) => p.run.waitingFor?.kind === "model" && p.run.waitingFor.detail === m.id,
    );
    const why =
      unanswered && lastError ? failureReason(pay(lastError)) : reasonOf(run?.run.stateReason ?? "");
    reasons.push(`unavailable${why ? `: ${why}` : ""}`);
  }
  if (share !== undefined && share >= 1) {
    worse("down");
    reasons.push(`quota window used up (${Math.round(share * 100)}%)`);
  } else if (share !== undefined && usage && share >= usage.soft) {
    worse("busy");
    reasons.push(
      `quota window at ${Math.round(share * 100)}% — calls slow down from ${Math.round(usage.soft * 100)}%`,
    );
  }
  if (waitingModel.length > 0)
    reasons.push(
      `${waitingModel.length} run${waitingModel.length === 1 ? "" : "s"} wait for it to answer again`,
    );
  if (waitingQuota.length > 0) {
    worse("busy");
    reasons.push(
      `${waitingQuota.length} run${waitingQuota.length === 1 ? "" : "s"} wait for its quota window`,
    );
  }
  const answered = calls.length + errors.length;
  if (!unanswered && errors.length > 0 && answered > 0 && errors.length / answered > 0.1) {
    worse("busy");
    reasons.push(`${errors.length} of ${answered} requests failed in ${RECENT_MINUTES}m`);
  }
  if (retries >= 3) {
    worse("busy");
    reasons.push(`${retries} retries in ${RECENT_MINUTES}m`);
  }
  return {
    id: m.id,
    state,
    reasons,
    pool: m.pool,
    ...(window ? { window } : {}),
    recent,
    ...(stats ? { perf: perfOf(stats) } : {}),
    inFlight: inFlightOf(m.id, input.events, input.now),
    waiting: { model: waitingModel, quota: waitingQuota },
  };
}

/** The same, read from a runtime: its configured models, their pools, the journal and the parked runs. */
export function modelsHealthOf(runtime: Runtime, now: Date = new Date()): ModelsHealth {
  const config = runtime.loaded.config;
  const since = new Date(now.getTime() - RECENT_MINUTES * 60_000).toISOString();
  const events = ["model.call", "model.retry", "model.error", "model.progress"]
    .flatMap((kind) => runtime.events.list({ kind, since, limit: 20_000 }))
    .sort((a, b) => a.seq - b.seq);
  const parked = runtime.runs.list({ state: ["WAITING_BUDGET"], limit: 200 }).map((run) => {
    const modelId =
      run.waitingFor?.kind === "model"
        ? run.waitingFor.detail
        : str(runtime.checkpoints.latest(run.id)?.state.modelId);
    return modelId ? { run, modelId } : { run };
  });
  return modelsHealth({
    models: Object.entries(config.models).map(([id, model]) => ({
      id,
      pool: model.quotaPool ?? `model:${id}`,
    })),
    pool: (name) => {
      const definition = runtime.budget.pool(name);
      const usage = runtime.budget.windowUsage(name);
      if (!definition || !usage) return undefined;
      return {
        soft: definition.soft,
        minutes: definition.window.minutes,
        ...(definition.limits.outputTokens !== undefined
          ? { outputLimit: definition.limits.outputTokens }
          : {}),
        ...(definition.limits.requests !== undefined ? { requestLimit: definition.limits.requests } : {}),
        outputTokens: usage.outputTokens,
        requests: usage.requests,
      };
    },
    events,
    parked,
    now,
  });
}

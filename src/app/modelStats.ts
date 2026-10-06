import type { StoredEvent } from "../telemetry/events.ts";
import { reasonOf } from "./activity.ts";

/**
 * How a model behaves, from the event journal (`model.call`, `model.retry`, `model.error`): how fast
 * it answers, how many tokens it moves, how often and why requests fail. Pilot: "the gateway cuts
 * at 5:00" was read off single runs by hand; the same `attemptMs` across failures says it at once.
 */
export interface Percentiles {
  readonly p50: number;
  readonly p90: number;
  readonly max: number;
}

export interface FailureGroup {
  /** `network error · UND_ERR_HEADERS_TIMEOUT`, `provider error · HTTP 500` */
  readonly reason: string;
  readonly retries: number;
  /** Requests that gave up after their retries. */
  readonly failed: number;
  /** How long the failed attempts ran: the same value every time points at a cut-off, not the model. */
  readonly attemptMs?: Percentiles;
  readonly last: string;
}

export interface ModelStats {
  readonly modelId: string;
  /** Requests answered, and those that gave up after retries. */
  readonly calls: number;
  readonly failed: number;
  /** answered / (answered + failed) */
  readonly successRate: number;
  readonly retries: number;
  /** Answered requests that needed at least one retry. */
  readonly retriedCalls: number;
  readonly latencyMs?: Percentiles;
  /** Output tokens per second of answering time, per call. */
  readonly outputPerSecond?: Percentiles;
  readonly promptTokens: { readonly total: number; readonly avg: number; readonly max: number };
  readonly outputTokens: { readonly total: number; readonly avg: number; readonly max: number };
  readonly cachedShare: number;
  /** `length` = the answer was cut at maxOutput. */
  readonly finishReasons: Record<string, number>;
  readonly failures: readonly FailureGroup[];
  readonly byAgent: ReadonlyArray<{ agent: string; calls: number; latencyP50: number; promptAvg: number }>;
  readonly first?: string;
  readonly last?: string;
  readonly lastFailure?: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export function percentiles(values: readonly number[]): Percentiles | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number;
  return { p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] as number };
}

/** What failed, in words a person compares: the reason, the HTTP status, the low-level code. */
export function failureReason(payload: Record<string, unknown>): string {
  const message = str(payload.message) ?? "";
  const parts = [reasonOf(message)];
  const status = num(payload.status);
  if (status > 0 && !parts[0]?.includes(String(status))) parts.push(`HTTP ${status}`);
  const code = /\b((?:UND_ERR|E[A-Z]{3,})[A-Z0-9_]*)\b/.exec(message)?.[1];
  if (code) parts.push(code);
  return parts.join(" · ");
}

export function modelStats(events: readonly StoredEvent[]): ModelStats[] {
  interface Acc {
    calls: StoredEvent[];
    retries: StoredEvent[];
    errors: StoredEvent[];
  }
  const by = new Map<string, Acc>();
  const acc = (modelId: string) => {
    let a = by.get(modelId);
    if (!a) {
      a = { calls: [], retries: [], errors: [] };
      by.set(modelId, a);
    }
    return a;
  };
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const modelId = str(p.modelId);
    if (!modelId) continue;
    if (e.kind === "model.call") acc(modelId).calls.push(e);
    else if (e.kind === "model.retry") acc(modelId).retries.push(e);
    else if (e.kind === "model.error") acc(modelId).errors.push(e);
  }
  const out: ModelStats[] = [];
  for (const [modelId, a] of by) {
    const pay = (e: StoredEvent) => (e.payload ?? {}) as Record<string, unknown>;
    const latencies = a.calls.map((e) => num(pay(e).latencyMs)).filter((v) => v > 0);
    const speeds = a.calls
      .map((e) => (num(pay(e).latencyMs) > 0 ? num(pay(e).outputTokens) / (num(pay(e).latencyMs) / 1000) : 0))
      .filter((v) => v > 0);
    const prompts = a.calls.map((e) => num(pay(e).promptTokens));
    const outputs = a.calls.map((e) => num(pay(e).outputTokens));
    const cached = a.calls.reduce((n, e) => n + num(pay(e).cachedTokens), 0);
    const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
    const stat = (xs: number[]) => ({
      total: sum(xs),
      avg: xs.length > 0 ? Math.round(sum(xs) / xs.length) : 0,
      max: xs.length > 0 ? Math.max(...xs) : 0,
    });
    const finishReasons: Record<string, number> = {};
    for (const e of a.calls) {
      const r = str(pay(e).finishReason) ?? "?";
      finishReasons[r] = (finishReasons[r] ?? 0) + 1;
    }
    const groups = new Map<string, { retries: number; failed: number; attempts: number[]; last: string }>();
    const group = (e: StoredEvent, kind: "retry" | "error") => {
      const reason = failureReason(pay(e));
      const g = groups.get(reason) ?? { retries: 0, failed: 0, attempts: [], last: e.ts };
      if (kind === "retry") g.retries += 1;
      else g.failed += 1;
      if (num(pay(e).attemptMs) > 0) g.attempts.push(num(pay(e).attemptMs));
      if (e.ts > g.last) g.last = e.ts;
      groups.set(reason, g);
    };
    for (const e of a.retries) group(e, "retry");
    for (const e of a.errors) group(e, "error");
    const agents = new Map<string, StoredEvent[]>();
    for (const e of a.calls) {
      const agent = str(pay(e).agentId) ?? str(pay(e).role) ?? "-";
      agents.set(agent, [...(agents.get(agent) ?? []), e]);
    }
    const all = [...a.calls, ...a.retries, ...a.errors].map((e) => e.ts).sort();
    const failuresTs = [...a.retries, ...a.errors].map((e) => e.ts).sort();
    const answered = a.calls.length;
    const failed = a.errors.length;
    const latency = percentiles(latencies);
    const speed = percentiles(speeds);
    out.push({
      modelId,
      calls: answered,
      failed,
      successRate: answered + failed > 0 ? answered / (answered + failed) : 1,
      retries: a.retries.length,
      retriedCalls: a.calls.filter((e) => num(pay(e).retries) > 0).length,
      ...(latency ? { latencyMs: latency } : {}),
      ...(speed ? { outputPerSecond: speed } : {}),
      promptTokens: stat(prompts),
      outputTokens: stat(outputs),
      cachedShare: sum(prompts) > 0 ? cached / sum(prompts) : 0,
      finishReasons,
      failures: [...groups.entries()]
        .map(([reason, g]) => {
          const attempts = percentiles(g.attempts);
          return {
            reason,
            retries: g.retries,
            failed: g.failed,
            ...(attempts ? { attemptMs: attempts } : {}),
            last: g.last,
          };
        })
        .sort((x, y) => y.retries + y.failed - (x.retries + x.failed)),
      byAgent: [...agents.entries()]
        .map(([agent, es]) => ({
          agent,
          calls: es.length,
          latencyP50: percentiles(es.map((e) => num(pay(e).latencyMs)))?.p50 ?? 0,
          promptAvg: Math.round(sum(es.map((e) => num(pay(e).promptTokens))) / es.length),
        }))
        .sort((x, y) => y.calls - x.calls),
      ...(all[0] ? { first: all[0] } : {}),
      ...(all.at(-1) ? { last: all.at(-1) as string } : {}),
      ...(failuresTs.at(-1) ? { lastFailure: failuresTs.at(-1) as string } : {}),
    });
  }
  return out.sort((x, y) => y.calls - x.calls);
}

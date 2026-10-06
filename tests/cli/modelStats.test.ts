import { describe, expect, it } from "vitest";
import { failureReason, modelStats, percentiles } from "../../src/app/modelStats.ts";
import type { StoredEvent } from "../../src/telemetry/events.ts";

let seq = 0;
const ev = (kind: string, payload: Record<string, unknown>, ts = "2026-10-06T07:00:00.000Z"): StoredEvent =>
  ({ seq: ++seq, ts, kind, runId: "run_1", payload }) as StoredEvent;

describe("model stats", () => {
  it("counts streamed answers and the time to their first token", () => {
    const call = (extra: Record<string, unknown>) =>
      ev("model.call", { modelId: "flash", latencyMs: 60_000, promptTokens: 1, outputTokens: 1, ...extra });
    const [flash] = modelStats([
      call({ streamed: true, firstTokenMs: 4_000 }),
      call({ streamed: true, firstTokenMs: 9_000 }),
      call({}),
    ]);
    expect(flash?.streamed).toEqual({ calls: 2, firstTokenMs: { p50: 4_000, p90: 9_000, max: 9_000 } });
    expect(modelStats([call({})])[0]?.streamed).toBeUndefined();
  });

  it("answers, failures, retries, latency, speed, tokens and why requests failed", () => {
    const call = (latencyMs: number, promptTokens: number, outputTokens: number, extra = {}) =>
      ev("model.call", {
        modelId: "flash",
        agentId: "research",
        latencyMs,
        promptTokens,
        outputTokens,
        cachedTokens: 0,
        finishReason: "stop",
        retries: 0,
        ...extra,
      });
    const cut = (attemptMs: number) =>
      ev("model.retry", {
        modelId: "flash",
        attemptMs,
        kind: "transient",
        message: "model flash: network error: fetch failed (UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error)",
      });
    const events = [
      call(10_000, 30_000, 500),
      call(20_000, 40_000, 1_000, { finishReason: "length", retries: 2 }),
      call(40_000, 150_000, 2_000, { agentId: "requirements" }),
      cut(300_972),
      cut(300_983),
      ev("model.error", {
        modelId: "flash",
        status: 500,
        retries: 2,
        attemptMs: 1_200,
        message: "model flash: provider error (500): upstream",
      }),
      ev("model.call", { modelId: "other", latencyMs: 1_000, promptTokens: 10, outputTokens: 10 }),
    ];
    const [flash, other] = modelStats(events);
    expect(other?.modelId).toBe("other");
    expect(flash).toMatchObject({
      modelId: "flash",
      calls: 3,
      failed: 1,
      successRate: 0.75,
      retries: 2,
      retriedCalls: 1,
      latencyMs: { p50: 20_000, p90: 40_000, max: 40_000 },
      outputPerSecond: { p50: 50, p90: 50, max: 50 },
      promptTokens: { total: 220_000, max: 150_000 },
      finishReasons: { stop: 2, length: 1 },
    });
    expect(flash?.failures).toEqual([
      {
        reason: "network error · UND_ERR_HEADERS_TIMEOUT",
        retries: 2,
        failed: 0,
        attemptMs: { p50: 300_972, p90: 300_983, max: 300_983 },
        last: "2026-10-06T07:00:00.000Z",
      },
      expect.objectContaining({ reason: "provider error (500)", retries: 0, failed: 1 }),
    ]);
    expect(flash?.byAgent.map((a) => [a.agent, a.calls])).toEqual([
      ["research", 2],
      ["requirements", 1],
    ]);
  });

  it("names a failure by its reason, status and low-level code", () => {
    expect(failureReason({ status: 429, message: "model m: rate limited: slow down" })).toBe(
      "rate limited · HTTP 429",
    );
    expect(failureReason({ message: "model m: network error: fetch failed (ECONNRESET)" })).toBe(
      "network error · ECONNRESET",
    );
    expect(percentiles([])).toBeUndefined();
  });
});

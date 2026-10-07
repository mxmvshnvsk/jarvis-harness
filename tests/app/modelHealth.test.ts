import { describe, expect, it } from "vitest";
import { type HealthInput, modelsHealth } from "../../src/app/modelHealth.ts";
import type { Run } from "../../src/core/domain/run.ts";
import type { StoredEvent } from "../../src/telemetry/events.ts";

let seq = 0;
const ev = (kind: string, ts: string, payload: Record<string, unknown>): StoredEvent =>
  ({ seq: ++seq, ts, kind, payload }) as unknown as StoredEvent;
const call = (modelId: string, ts: string, latencyMs = 6000) => ev("model.call", ts, { modelId, latencyMs });
const error = (modelId: string, ts: string) =>
  ev("model.error", ts, { modelId, kind: "provider", status: 500, message: "provider error (500)" });
const retry = (modelId: string, ts: string) =>
  ev("model.retry", ts, { modelId, kind: "provider", status: 500 });
const parkedRun = (id: string, waitingFor?: Run["waitingFor"]) =>
  ({
    id,
    state: "WAITING_BUDGET",
    stateReason: "model flash is unavailable: provider error (500)",
    waitingFor,
  }) as Run;

const base = (over: Partial<HealthInput> = {}): HealthInput => ({
  models: [
    { id: "flash", pool: "corp" },
    { id: "pro", pool: "model:pro" },
  ],
  pool: (name) =>
    name === "corp"
      ? { soft: 0.8, minutes: 20, outputLimit: 60_000, requests: 40, requestLimit: 300, outputTokens: 12_000 }
      : undefined,
  events: [],
  parked: [],
  now: new Date("2026-10-07T08:00:00Z"),
  ...over,
});

describe("how the models are doing", () => {
  it("ok with recent answers, idle without any; the worst one is the overall state", () => {
    const h = modelsHealth(base({ events: [call("flash", "2026-10-07T07:58:00Z")] }));
    expect(h.models.map((m) => [m.id, m.state])).toEqual([
      ["flash", "ok"],
      ["pro", "idle"],
    ]);
    expect(h.state).toBe("ok");
    expect(h.models[0]?.window).toMatchObject({ share: 0.2, soft: 0.8, minutes: 20 });
    expect(h.models[0]?.recent).toMatchObject({ calls: 1, failed: 0, latencyP50Ms: 6000 });
  });

  it("busy: the quota window past its soft threshold, retries, runs waiting for the quota", () => {
    const h = modelsHealth(
      base({
        pool: () => ({ soft: 0.8, minutes: 20, outputLimit: 60_000, outputTokens: 51_000, requests: 3 }),
        events: [
          call("flash", "2026-10-07T07:58:00Z"),
          ...[1, 2, 3].map((i) => retry("flash", `2026-10-07T07:5${i}:00Z`)),
        ],
        parked: [{ run: parkedRun("run_aaaabbbbcccc"), modelId: "flash" }],
      }),
    );
    const flash = h.models[0];
    expect(flash?.state).toBe("busy");
    expect(flash?.reasons).toEqual([
      "quota window at 85% — calls slow down from 80%",
      "1 run wait for its quota window",
      "3 retries in 30m",
    ]);
    expect(flash?.waiting.quota).toEqual(["aaaabbbb"]);
  });

  it("down: it gave up and has not answered since, or runs wait for it; it recovers with an answer", () => {
    const down = modelsHealth(
      base({
        events: [call("flash", "2026-10-07T07:50:00Z"), error("flash", "2026-10-07T07:55:00Z")],
        parked: [
          { run: parkedRun("run_1a2b3c4d5e6f", { kind: "model", detail: "flash" }), modelId: "flash" },
        ],
      }),
    );
    expect(down.state).toBe("down");
    expect(down.models[0]?.reasons[0]).toMatch(/^unavailable: /);
    expect(down.models[0]?.reasons).toContain("1 run wait for it to answer again");
    expect(down.models[0]?.waiting.model).toEqual(["1a2b3c4d"]);
    const back = modelsHealth(
      base({ events: [error("flash", "2026-10-07T07:55:00Z"), call("flash", "2026-10-07T07:57:00Z")] }),
    );
    expect(back.models[0]?.state).toBe("busy"); // 1 of 2 failed in the half hour, but answering again
    expect(
      modelsHealth(
        base({ pool: () => ({ soft: 0.8, minutes: 20, outputLimit: 100, outputTokens: 100, requests: 1 }) }),
      ).models[0]?.state,
    ).toBe("down");
  });
});

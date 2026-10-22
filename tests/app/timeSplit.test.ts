import { describe, expect, it } from "vitest";
import { timeSplitOf } from "../../src/app/timeSplit.ts";
import type { StoredEvent } from "../../src/telemetry/events.ts";
import { timeHtml } from "../../src/ui/pages.ts";

/** Where a run's time went: working, waiting for a person, on budget and the model, stopped. */
const T0 = Date.parse("2026-10-09T09:00:00.000Z");
const min = (m: number): string => new Date(T0 + m * 60_000).toISOString();
let seq = 0;
const ev = (
  m: number,
  kind: string,
  payload: Record<string, unknown> = {},
  stepId?: string,
): StoredEvent => ({
  seq: ++seq,
  ts: min(m),
  kind,
  runId: "r1",
  ...(stepId ? { stepId } : {}),
  payload,
});
const state = (m: number, s: string, extra: Record<string, unknown> = {}, stepId?: string): StoredEvent =>
  ev(m, "run.state", { state: s, ...extra }, stepId);
const start = (m: number, stepId: string, iteration = 1): StoredEvent =>
  ev(m, "step.start", { stepId, iteration }, stepId);
const M = 60_000;

describe("timeSplitOf", () => {
  it("cuts the run into working, waiting for you, budget and model, stopped", () => {
    const events = [
      state(0, "RUNNING", { reason: "started" }),
      start(0, "spec"),
      ev(5, "model.call"),
      start(10, "approve-spec"),
      state(11, "WAITING_HUMAN", { waitingFor: { kind: "approval", detail: "spec" } }, "approve-spec"),
      state(60, "RUNNING", { reason: "resumed from WAITING_HUMAN" }, "approve-spec"),
      start(60, "implementation"),
      ev(62, "model.call"),
      state(70, "WAITING_BUDGET", { reason: 'quota window of pool "corp" is full' }, "implementation"),
      state(81, "RUNNING", {}, "implementation"),
      start(81, "implementation"),
      ev(82, "model.call"),
      state(90, "WAITING_HUMAN", { reason: "budget.perStep promptTokens", waitingFor: { kind: "budget" } }),
      state(92, "RUNNING", {}, "implementation"),
      state(100, "SUSPENDED", { reason: "paused by dev; Resume goes on from here" }),
      state(102, "RUNNING", {}, "implementation"),
      state(120, "COMPLETED"),
    ];
    const t = timeSplitOf(events, new Date(T0 + 500 * M));
    expect(t?.totalMs).toBe(120 * M);
    expect(t?.endedAt).toBe(min(120));
    expect(t?.parts.working.ms).toBe((10 + 1 + 10 + 9 + 8 + 18) * M);
    expect(t?.parts.working.items[0]).toMatchObject({ label: "implementation", ms: (10 + 9 + 8 + 18) * M });
    expect(t?.parts.human.items).toEqual([
      { label: "approve-spec", ms: 49 * M, times: 1 },
      { label: "budget grant", ms: 2 * M, times: 1 },
    ]);
    expect(t?.parts.waiting.items).toEqual([{ label: "quota window", ms: 11 * M, times: 1 }]);
    expect(t?.parts.stopped.items).toEqual([{ label: "Pause", ms: 2 * M, times: 1 }]);
  });

  it("a task across services parked for its subtasks waits for them; it is not stopped (pilot: «Ctrl-C»)", () => {
    const events = [
      state(0, "RUNNING"),
      start(0, "split"),
      state(5, "SUSPENDED", {
        reason: "waits for its subtasks: 0 of 2 done",
        waitingFor: { kind: "children", detail: "1 orders-api: starting" },
      }),
      state(35, "RUNNING", {}, "wait"),
      state(36, "COMPLETED"),
    ];
    const t = timeSplitOf(events, new Date(T0 + 100 * M));
    expect(t?.parts.subtasks.ms).toBe(30 * M);
    expect(t?.parts.stopped.ms).toBe(0);
  });

  it("a model re-checked every few minutes is one outage; a new one after an answer is another", () => {
    const events = [
      state(0, "RUNNING"),
      start(0, "verify"),
      state(1, "WAITING_BUDGET", { reason: "model m is unavailable: 403", waitingFor: { kind: "model" } }),
      state(6, "RUNNING"),
      state(6.5, "WAITING_BUDGET", { reason: "model m is unavailable: 403", waitingFor: { kind: "model" } }),
      state(11, "RUNNING"),
      ev(12, "model.call"),
      state(13, "WAITING_BUDGET", { reason: "model m is unavailable: 403", waitingFor: { kind: "model" } }),
      state(16, "RUNNING"),
    ];
    const t = timeSplitOf(events, new Date(T0 + 20 * M));
    expect(t?.endedAt).toBeUndefined();
    expect(t?.totalMs).toBe(20 * M);
    expect(t?.parts.waiting.items).toEqual([{ label: "model unavailable", ms: 12.5 * M, times: 2 }]);
  });

  it("a RUNNING run nobody holds stands still since its last event; a recovery counts the gap", () => {
    const events = [
      state(0, "RUNNING"),
      start(0, "research"),
      ev(4, "model.call"),
      ev(30, "run.recovered", { stepId: "research" }),
      ev(35, "model.call"),
    ];
    const t = timeSplitOf(events, new Date(T0 + 50 * M), false);
    expect(t?.parts.working.ms).toBe((4 + 5) * M);
    expect(t?.parts.stopped.items).toEqual([{ label: "no process ran it", ms: (26 + 15) * M, times: 2 }]);
    expect(timeSplitOf(events, new Date(T0 + 50 * M), true)?.parts.working.ms).toBe((4 + 20) * M);
  });

  it("a failed run stops its clock until Try again, then the wait counts as stopped", () => {
    const failed = [state(0, "RUNNING"), start(0, "verify"), state(10, "FAILED", { reason: "403" })];
    const over = timeSplitOf(failed, new Date(T0 + 90 * M));
    expect(over?.endedAt).toBe(min(10));
    expect(over?.totalMs).toBe(10 * M);
    const retried = timeSplitOf(
      [...failed, state(40, "RUNNING", { reason: "resumed from FAILED" })],
      new Date(T0 + 45 * M),
    );
    expect(retried?.endedAt).toBeUndefined();
    expect(retried?.parts.stopped.items).toEqual([
      { label: "failed, until Try again", ms: 30 * M, times: 1 },
    ]);
    expect(retried?.parts.working.ms).toBe(15 * M);
  });

  it("no events, no split", () => {
    expect(timeSplitOf([], new Date())).toBeUndefined();
  });
});

describe("timeHtml", () => {
  it("shows the total and the working time in the head, and the four rows on hover", () => {
    const events = [
      state(0, "RUNNING"),
      start(0, "spec"),
      state(10, "WAITING_HUMAN", { waitingFor: { kind: "approval" } }, "approve-spec"),
      state(70, "RUNNING"),
      start(70, "implementation"),
      state(80, "WAITING_BUDGET", { reason: "quota window" }),
    ];
    const time = timeSplitOf(events, new Date(T0 + 90 * M));
    const out = String(time ? timeHtml(time) : "");
    expect(out).toContain('1h 30m <span class="work">· 20m 00s working</span>');
    expect(out).toContain("approve-spec 1h 00m");
    expect(out).toContain("quota window 10m 00s (×1)");
    expect(out).toContain("not over yet");
    expect(out.match(/<td class="k">/g)).toHaveLength(4);
  });
});

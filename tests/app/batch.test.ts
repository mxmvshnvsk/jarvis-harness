import { describe, expect, it } from "vitest";
import { activityOf, formatRecent } from "../../src/app/activity.ts";
import type { StoredEvent } from "../../src/telemetry/events.ts";
import { feedOf } from "../../src/ui/model.ts";

let seq = 0;
const ev = (kind: string, ts: string, payload: Record<string, unknown> = {}): StoredEvent =>
  ({
    seq: ++seq,
    ts,
    kind,
    runId: "run_1",
    stepId: "research",
    iteration: 1,
    payload,
  }) as unknown as StoredEvent;

describe("the tools of one answer, shown as one batch", () => {
  const events = [
    ev("step.start", "2026-10-07T10:00:00.000Z", { stepId: "research", iteration: 1 }),
    ev("agent.start", "2026-10-07T10:00:01.000Z", { agent: "research", maxToolCalls: 50 }),
    ev("model.call", "2026-10-07T10:00:05.000Z", { promptTokens: 1000, outputTokens: 50 }),
    ev("tool.batch", "2026-10-07T10:00:05.000Z", {
      modelCall: 1,
      size: 3,
      parallel: true,
      calls: [
        { capability: "repo.read", args: '{"path":"src/orders/card.tsx"}' },
        { capability: "confluence.get", args: '{"id":"77770077"}' },
        { capability: "repo.search", args: '{"pattern":"deliveryDate"}' },
      ],
    }),
    ev("tool.call", "2026-10-07T10:00:05.100Z", {
      capability: "repo.read",
      ok: true,
      durationMs: 100,
      batch: 1,
      slot: 0,
      args: '{"path":"src/orders/card.tsx"}',
    }),
    ev("tool.call", "2026-10-07T10:00:05.200Z", {
      capability: "repo.search",
      ok: false,
      durationMs: 200,
      batch: 1,
      slot: 2,
      args: '{"pattern":"deliveryDate"}',
    }),
  ];

  it("in flight: each call on one clock from the batch's start, the slow one still running", () => {
    const a = activityOf(events, new Date("2026-10-07T10:00:05.400Z"));
    expect(a?.batch).toMatchObject({ modelCall: 1, size: 3, parallel: true, running: true, ms: 400 });
    expect(a?.batch?.calls).toEqual([
      { capability: "repo.read", detail: "src/orders/card.tsx", ok: true, startMs: 0, ms: 100 },
      { capability: "confluence.get", detail: "77770077", startMs: 0, ms: 400 },
      { capability: "repo.search", detail: "deliveryDate", ok: false, startMs: 0, ms: 200 },
    ]);
    expect(formatRecent(a as NonNullable<typeof a>)).toContain("⇉3 ");
  });

  it("done: the batch from its start to its last end; the feed has it as one line with its calls", () => {
    const all = [
      ...events,
      ev("tool.call", "2026-10-07T10:00:05.900Z", {
        capability: "confluence.get",
        ok: true,
        durationMs: 900,
        batch: 1,
        slot: 1,
        args: '{"id":"77770077"}',
      }),
    ];
    const a = activityOf(all, new Date("2026-10-07T10:00:09.000Z"));
    expect(a?.batch).toMatchObject({ running: false, ms: 900 });
    const feed = feedOf(all);
    expect(feed).toEqual([
      {
        ts: "2026-10-07T10:00:05.000Z",
        text: "model call 1 · ⇉ 3 tools in parallel · 0.9s",
        sub: [
          { text: "read src/orders/card.tsx · 0.1s" },
          { text: "confluence.get 77770077 · 0.9s" },
          { text: "search deliveryDate · 0.2s ✗", tone: "bad" },
        ],
      },
    ]);
  });
});

describe("a re-read of a trimmed result", () => {
  it("is named by the call it answered, not by its hash", () => {
    const events = [
      ev("step.start", "2026-10-07T11:00:00.000Z", { stepId: "research", iteration: 1 }),
      ev("agent.start", "2026-10-07T11:00:01.000Z", { agent: "research" }),
      ev("context.trimmed", "2026-10-07T11:00:02.000Z", {
        messages: 1,
        savedChars: 9000,
        originals: [{ ref: "52e04ec9f91e", call: "repo.read src/orders/card.tsx" }],
      }),
      ev("tool.batch", "2026-10-07T11:00:03.000Z", {
        modelCall: 2,
        size: 2,
        parallel: true,
        calls: [
          { capability: "knowledge.read", args: '{"ref":"blob:52e04ec9f91e"}' },
          { capability: "knowledge.read", args: '{"ref":"blob:ffff0000"}' },
        ],
      }),
      ev("tool.call", "2026-10-07T11:00:03.010Z", {
        capability: "knowledge.read",
        ok: true,
        durationMs: 3,
        batch: 2,
        slot: 0,
        args: '{"ref":"blob:52e04ec9f91e"}',
      }),
    ];
    const a = activityOf(events, new Date("2026-10-07T11:00:04.000Z"));
    expect(a?.batch?.calls.map((c) => c.detail)).toEqual([
      "original of repo.read src/orders/card.tsx",
      "blob:ffff0000",
    ]);
    expect(a?.lastTool?.detail).toBe("original of repo.read src/orders/card.tsx");
  });
});

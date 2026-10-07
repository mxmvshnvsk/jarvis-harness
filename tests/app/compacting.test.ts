import { describe, expect, it } from "vitest";
import { activityOf, formatActivity, noticeOf } from "../../src/app/activity.ts";
import type { StoredEvent } from "../../src/telemetry/events.ts";

let seq = 0;
const ev = (kind: string, ts: string, payload: Record<string, unknown> = {}): StoredEvent =>
  ({ seq: ++seq, ts, kind, runId: "run_1", stepId: "research", payload }) as unknown as StoredEvent;

describe("compaction is shown while it runs (pilot: 49 s that looked like the agent thinking)", () => {
  const start = [
    ev("step.start", "2026-10-07T10:00:00.000Z", { stepId: "research", iteration: 1 }),
    ev("agent.start", "2026-10-07T10:00:01.000Z", { agent: "research", maxToolCalls: 50 }),
    ev("context.compacting", "2026-10-07T10:01:00.000Z", { kind: "compact", tokens: 57_000, blocks: 6 }),
  ];

  it("the live line says compacting, with how long; the result is a line that stays", () => {
    const now = new Date("2026-10-07T10:01:32.000Z");
    const a = activityOf(start, now);
    expect(a?.compacting).toEqual({ kind: "compact", tokens: 57_000, blocks: 6, ms: 32_000 });
    expect(formatActivity(a as NonNullable<typeof a>)).toContain(
      "compacting the conversation (57k tok, 6 blocks into a summary)",
    );
    const done = ev("context.compacted", "2026-10-07T10:01:49.000Z", {
      before: 57_000,
      after: 48_000,
      blocks: 6,
    });
    expect(activityOf([...start, done], now)?.compacting).toBeUndefined();
    expect(noticeOf(done)).toMatch(
      /^⇣ \d\d:\d\d:\d\d conversation compacted: 57k → 48k tok, 6 blocks into a summary$/,
    );
    const empty = ev("context.compacted", "2026-10-07T10:01:49.000Z", {
      before: 57_000,
      after: 56_000,
      blocks: 6,
      fallback: "empty",
    });
    expect(noticeOf(empty)).toContain("the summary came back empty");
  });
});

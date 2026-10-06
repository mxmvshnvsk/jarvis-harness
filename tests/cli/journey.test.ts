import { describe, expect, it } from "vitest";
import { duration, Journey } from "../../src/app/journey.ts";
import { formatLoop, formatStepReport } from "../../src/cli/progress.ts";
import { createStyle, stripAnsi } from "../../src/cli/style.ts";
import type { StoredEvent } from "../../src/telemetry/events.ts";

let seq = 0;
const ev = (kind: string, ts: string, payload: Record<string, unknown> = {}): StoredEvent =>
  ({ seq: ++seq, ts: `2026-10-06T10:${ts}Z`, kind, runId: "run_1", payload }) as StoredEvent;

describe("journey", () => {
  it("reports a finished step with its position, time, model and tool use", () => {
    const j = new Journey(["discover", "research", "spec"]);
    expect(j.push(ev("step.start", "00:00", { stepId: "research", iteration: 1, kind: "agentic" }))).toEqual(
      [],
    );
    j.push(ev("agent.start", "00:01", { agent: "research", maxToolCalls: 60 }));
    j.push(ev("model.call", "00:30", { promptTokens: 12_000, outputTokens: 800 }));
    j.push(ev("tool.call", "00:31", { capability: "fs.read" }));
    j.push(ev("model.call", "01:10", { promptTokens: 15_500, outputTokens: 1_200, retries: 1 }));
    const [line] = j.push(
      ev("step.finish", "03:12", { stepId: "research", iteration: 1, status: "success" }),
    );
    expect(line).toEqual({
      kind: "step",
      report: {
        stepId: "research",
        iteration: 1,
        index: 2,
        total: 3,
        kind: "agentic",
        status: "success",
        durationMs: 192_000,
        agent: "research",
        modelCalls: 2,
        promptTokens: 27_500,
        outputTokens: 2_000,
        retries: 1,
        toolCalls: 1,
        maxToolCalls: 60,
      },
    });
    if (line?.kind !== "step") throw new Error("step");
    const plain = createStyle(false);
    const artifact = { name: "research.md", version: 1 } as never;
    expect(formatStepReport(line.report, [artifact], plain, 8)).toEqual([
      "✓ [2/3] research  3m 12s  research · 2 calls · 28k→2.0k tok · 1/60 tools · 1 retry  → research.md",
    ]);
    // coloured: the same text
    const coloured = formatStepReport(line.report, [artifact], createStyle(true), 8)[0] as string;
    expect(stripAnsi(coloured)).toBe(
      "✓ [2/3] research  3m 12s  research · 2 calls · 28k→2.0k tok · 1/60 tools · 1 retry  → research.md",
    );
  });

  it("reports an exception and a loop back", () => {
    const j = new Journey();
    j.push(ev("step.start", "00:00", { stepId: "spec", iteration: 2 }));
    const [err] = j.push(ev("step.error", "00:05", { message: "boom\nstack" }));
    if (err?.kind !== "step") throw new Error("step");
    expect(formatStepReport(err.report, [], createStyle(false))).toEqual(["✗ spec#2  5.0s", "  error: boom"]);
    const [loop] = j.push(
      ev("workflow.loop", "00:06", {
        edge: "approve-spec->spec#request_changes",
        iteration: 1,
        max: 3,
        reasons: "too vague",
      }),
    );
    if (loop?.kind !== "loop") throw new Error("loop");
    expect(formatLoop(loop.report, createStyle(false))).toBe(
      "↻ approve-spec → spec request_changes, round 1/3 — too vague",
    );
  });

  it("says when an agent stopped on its limit", () => {
    const j = new Journey();
    j.push(ev("step.start", "00:00", { stepId: "research", iteration: 1 }));
    j.push(ev("agent.start", "00:00", { agent: "research", maxToolCalls: 2 }));
    j.push(ev("tool.call", "00:01"));
    j.push(ev("tool.call", "00:02"));
    j.push(ev("agent.finish", "00:03", { status: "success", budgetExhausted: "tools" }));
    const [line] = j.push(ev("step.finish", "00:04", { status: "success" }));
    if (line?.kind !== "step") throw new Error("step");
    expect(formatStepReport(line.report, [], createStyle(false))).toEqual([
      "✓ research  4.0s    research · 2/2 tools · tool limit reached, result may be incomplete",
    ]);
  });

  it("formats durations for people", () => {
    expect([400, 42_000, 192_000, 3_840_000].map(duration)).toEqual(["0.4s", "42s", "3m 12s", "1h 04m"]);
  });
});

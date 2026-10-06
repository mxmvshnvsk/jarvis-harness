import { describe, expect, it } from "vitest";
import { duration, Journey } from "../../src/app/journey.ts";
import { formatLoop, formatStepReport, toolMix } from "../../src/cli/progress.ts";
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
        tools: { "fs.read": 1 },
        maxToolCalls: 60,
      },
    });
    if (line?.kind !== "step") throw new Error("step");
    const plain = createStyle(false);
    const artifact = { name: "research.md", version: 1 } as never;
    expect(formatStepReport(line.report, [artifact], plain, 8)).toEqual([
      "✓ [2/3] research  3m 12s  research · 2 calls · 28k→2.0k tok · read (1/60) · 1 retry  → research.md",
    ]);
    // coloured: the same text
    const coloured = formatStepReport(line.report, [artifact], createStyle(true), 8)[0] as string;
    expect(stripAnsi(coloured)).toBe(
      "✓ [2/3] research  3m 12s  research · 2 calls · 28k→2.0k tok · read (1/60) · 1 retry  → research.md",
    );
  });

  it("names the tools an agent used, most used first", () => {
    expect(toolMix({ "repo.read": 12, "repo.search": 4, "repo.edit": 2 })).toBe("read×12 search×4 edit×2");
    expect(toolMix({ "repo.read": 3, "knowledge.read": 1 })).toBe("repo.read×3 knowledge.read");
    expect(toolMix({ a: 5, b: 4, c: 3, d: 2, e: 1, f: 1 })).toBe("a×5 b×4 c×3 d×2 +2");
  });

  it("says when a quick tool answered for the agent", () => {
    const j = new Journey(["impact"]);
    j.push(ev("step.start", "00:00", { stepId: "impact", iteration: 1, kind: "agentic" }));
    j.push(ev("step.quick", "00:01", { tool: "impact.quick", used: true }));
    const [line] = j.push(ev("step.finish", "00:02", { stepId: "impact", iteration: 1, status: "success" }));
    if (line?.kind !== "step") throw new Error("step");
    expect(
      formatStepReport(line.report, [{ name: "impact.json", version: 1 } as never], createStyle(false)),
    ).toEqual(["✓ [1/1] impact  2.0s    impact.quick, no model call  → impact.json"]);
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

  it("counts the tool calls a resumed step made before it was interrupted (pilot: 5/20 · limit reached)", () => {
    const j = new Journey();
    j.push(ev("step.start", "00:00", { stepId: "spec", iteration: 2 }));
    j.push(ev("agent.start", "00:00", { agent: "specification", maxToolCalls: 20, restoredToolCalls: 15 }));
    for (const t of ["00:01", "00:02", "00:03", "00:04", "00:05"]) j.push(ev("tool.call", t));
    j.push(ev("agent.finish", "00:06", { budgetExhausted: "tools" }));
    const [line] = j.push(ev("step.finish", "00:07", { status: "success" }));
    if (line?.kind !== "step") throw new Error("step");
    expect(line.report.toolCalls).toBe(20);
  });

  it("formats durations for people", () => {
    expect([400, 42_000, 192_000, 3_840_000].map(duration)).toEqual(["0.4s", "42s", "3m 12s", "1h 04m"]);
  });
});

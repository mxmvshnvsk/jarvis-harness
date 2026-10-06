import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { activityOf, formatActivity, formatRecent } from "../../src/app/activity.ts";
import type { StepReport } from "../../src/app/journey.ts";
import { asciiOnly, createOutput, toAscii } from "../../src/cli/output.ts";
import { formatParked, formatStepReport } from "../../src/cli/progress.ts";
import { createStyle, stripAnsi, visibleLength } from "../../src/cli/style.ts";
import type { Run } from "../../src/core/domain/run.ts";
import type { StoredEvent } from "../../src/telemetry/events.ts";

/**
 * What people read, pinned: a step line, a loop of the live region, a parked run — plain, coloured
 * (stripped to the same text), at 60 and 120 columns and in ASCII. A change in the output shows up
 * here as a diff to look at, not as a surprise in someone's terminal.
 */
const report: StepReport = {
  stepId: "research",
  iteration: 1,
  index: 2,
  total: 9,
  kind: "agentic",
  status: "success",
  durationMs: 192_000,
  agent: "research",
  modelCalls: 6,
  promptTokens: 98_000,
  outputTokens: 4_100,
  retries: 1,
  toolCalls: 21,
  tools: { "repo.read": 12, "repo.search": 6, "knowledge.read": 3 },
  maxToolCalls: 40,
};
const artifact = { name: "research.json", version: 1 } as never;

let seq = 0;
const ev = (kind: string, payload: Record<string, unknown>, at: number): StoredEvent =>
  ({
    seq: ++seq,
    ts: new Date(Date.parse("2026-10-06T10:00:00Z") + at * 1000).toISOString(),
    runId: "run_1",
    stepId: "spec",
    kind,
    payload,
  }) as StoredEvent;
const events = [
  ev("run.created", { task: "T" }, 0),
  ev("step.start", { stepId: "spec", iteration: 1 }, 1),
  ev("agent.start", { agent: "specification", modelId: "flash", maxToolCalls: 20 }, 2),
  ev("tool.call", { capability: "repo.read", ok: true, args: '{"path":"src/shared/delivery-fields.ts"}' }, 30),
  ev("model.call", { promptTokens: 9000, outputTokens: 300, latencyMs: 40_000 }, 70),
  ev("tool.call", { capability: "repo.search", ok: true, args: '{"pattern":"compact"}' }, 71),
  ev("model.progress", { outputChars: 0, reasoningChars: 8000 }, 100),
];

function frame(columns: number, env: NodeJS.ProcessEnv = {}): string {
  let written = "";
  const err = Object.assign(
    new Writable({
      write(c, _e, cb) {
        written += String(c);
        cb();
      },
    }),
    { isTTY: true, columns },
  );
  const out = createOutput(false, { out: err, err }, { color: false, env });
  const a = activityOf(events, new Date(Date.parse("2026-10-06T10:02:10Z"))) as NonNullable<
    ReturnType<typeof activityOf>
  >;
  out.progress([`⠋ ${formatActivity(a, { lastTool: false })}`, formatRecent(a) as string]);
  // the frame without the synchronized-update and erase sequences
  for (const seq of ["\u001b[?2026h", "\u001b[?2026l", "\r\u001b[2K", "\u001b]8;;\u0007"])
    written = written.split(seq).join("");
  return written;
}

describe("output snapshots", () => {
  it("a step line, plain and coloured", () => {
    const plain = formatStepReport(report, [artifact], createStyle(false), 8);
    expect(plain).toMatchInlineSnapshot(`
      [
        "✓ [2/9] research  3m 12s  research · 6 calls · 98k→4.1k tok · repo.read×12 search×6 knowledge.read×3 (21/40) · 1 retry  → research.json",
      ]
    `);
    expect(formatStepReport(report, [artifact], createStyle(true), 8).map(stripAnsi)).toEqual(plain);
  });

  it("the live region at 120 and at 60 columns", () => {
    expect(frame(120)).toMatchInlineSnapshot(`
      "⠋ 2:10 · spec#1 specification · model call 2, avg 0:40, waiting 0:59, thinking ~2.0k tok · tools 2/20 [█░░░░░░░░░] · t…
        ↳ read src/shared/delivery-fields.ts · search compact"
    `);
    const narrow = frame(60);
    for (const line of narrow.split("\n")) expect(visibleLength(line)).toBeLessThanOrEqual(59);
    expect(narrow).toMatchInlineSnapshot(`
      "⠋ 2:10 · spec#1 specification · model call 2, avg 0:40, wa…
        ↳ read src/shared/delivery-fields.ts · search compact"
    `);
  });

  it("a parked run", () => {
    const run = {
      state: "WAITING_HUMAN",
      currentStep: "approve-spec",
      waitingFor: { kind: "approval" },
      stateReason: "approve spec (spec.json@1)",
    } as unknown as Run;
    expect(formatParked(run, createStyle(false), ["spec", "approve-spec"])).toMatchInlineSnapshot(
      `"⏸ [2/2] approve-spec  waiting for approval — approve spec (spec.json@1)"`,
    );
  });

  it("ASCII where the terminal has no Unicode", () => {
    expect(asciiOnly({ TERM: "linux" })).toBe(true);
    expect(asciiOnly({ LANG: "en_US.ISO-8859-1" })).toBe(true);
    expect(asciiOnly({ LANG: "en_US.UTF-8" })).toBe(false);
    expect(asciiOnly({ LANG: "C" })).toBe(false);
    expect(asciiOnly({ LANG: "en_US.UTF-8", JARVIS_ASCII: "1" })).toBe(true);
    expect(toAscii(formatStepReport(report, [artifact], createStyle(false), 8)[0] as string)).toMatchInlineSnapshot(
      `"v [2/9] research  3m 12s  research . 6 calls . 98k->4.1k tok . repo.readx12 searchx6 knowledge.readx3 (21/40) . 1 retry  -> research.json"`,
    );
    const ascii = frame(80, { JARVIS_ASCII: "1" });
    expect([...ascii].every((ch) => (ch.codePointAt(0) ?? 0) < 0x80)).toBe(true);
    for (const line of ascii.split("\n")) expect(visibleLength(line)).toBeLessThanOrEqual(79);
  });
});

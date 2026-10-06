import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { activityOf, formatActivity, noticeOf } from "../../src/app/activity.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import type { CliContext } from "../../src/cli/context.ts";
import { createOutput } from "../../src/cli/output.ts";
import { followRun } from "../../src/cli/progress.ts";
import type { StoredEvent } from "../../src/telemetry/events.ts";

const T0 = Date.parse("2026-10-05T09:00:00.000Z");
let seq = 0;
function ev(atSec: number, kind: string, payload: Record<string, unknown> = {}, stepId = "map"): StoredEvent {
  seq += 1;
  return {
    seq,
    ts: new Date(T0 + atSec * 1000).toISOString(),
    runId: "run_1",
    stepId,
    iteration: 1,
    kind,
    payload,
  };
}
const at = (sec: number) => new Date(T0 + sec * 1000);

// the shape of the pilot's onboarding run: slow model calls between fast tool calls
const RUN = [
  ev(0, "run.created", { task: "Map the module" }),
  ev(1, "step.start", { stepId: "map", iteration: 1, kind: "agentic" }),
  ev(1, "agent.start", { agent: "onboard-mapper", modelId: "flash", maxToolCalls: 40, maxModelCalls: 60 }),
  ev(61, "model.call", { promptTokens: 4228, outputTokens: 94, latencyMs: 60000, retries: 0 }),
  ev(62, "tool.call", {
    capability: "repo.read",
    ok: true,
    args: '{"path":"packages/lib/src/billing/senders/invoice-mailer.ts"}',
  }),
  ev(122, "model.call", { promptTokens: 4796, outputTokens: 250, latencyMs: 60000, retries: 0 }),
  ev(123, "tool.call", {
    capability: "repo.search",
    ok: true,
    args: '{"pattern":"defineInvoiceEvents"}',
  }),
];

describe("live activity of a run", () => {
  it("says what the agent waits for, how long, and how much of its tool budget is used", () => {
    const a = activityOf(RUN, at(200));
    expect(a).toMatchObject({
      runId: "run_1",
      elapsedMs: 200_000,
      finished: false,
      modelCalls: 2,
      promptTokens: 9024,
      outputTokens: 344,
      toolCalls: 2,
      avgLatencyMs: 60_000,
      waitingMs: 77_000,
      step: {
        id: "map",
        iteration: 1,
        agent: "onboard-mapper",
        maxToolCalls: 40,
        modelCalls: 2,
        toolCalls: 2,
      },
      lastTool: { capability: "repo.search", detail: "defineInvoiceEvents", ok: true },
    });
    const line = formatActivity(a as NonNullable<typeof a>, { stepOutputTokens: 60000 });
    expect(line).toBe(
      "3:20 · map#1 onboard-mapper · model call 3, avg 1:00, waiting 1:17 · tools 2/40 [█░░░░░░░░░] · tokens in 9.0k out 344/60k · last repo.search defineInvoiceEvents",
    );
  });

  it("names the first call while it is in flight", () => {
    const first = activityOf(RUN.slice(0, 3), at(122)) as NonNullable<ReturnType<typeof activityOf>>;
    expect(formatActivity(first)).toContain("model call 1, waiting 2:01");
  });

  it("keeps counting the wait across retries and says why the call is retried (pilot: HTTP 500 at 5:00)", () => {
    const events = [
      ...RUN.slice(0, 3),
      ev(301, "model.retry", {
        attempt: 1,
        kind: "transient",
        status: 500,
        message: 'model flash: provider error (500): {"error":"Error processing request, traceId:0f1e"}',
      }),
      ev(602, "model.retry", {
        attempt: 2,
        kind: "transient",
        status: 500,
        message: "model flash: provider error (500): {}",
      }),
    ];
    const a = activityOf(events, at(700)) as NonNullable<ReturnType<typeof activityOf>>;
    expect(a.retrying).toEqual({ attempt: 2, reason: "provider error (500)" });
    expect(formatActivity(a, { timeoutMs: 300_000 })).toContain(
      "model call 1, waiting 11:39, retry 2 after provider error (500) · tools",
    );
    // an answer clears it
    const answered = activityOf([...events, ev(650, "model.call", { latencyMs: 48000 })], at(700));
    expect(answered?.retrying).toBeUndefined();
  });

  it("shows a streamed answer coming instead of a bare wait", () => {
    const events = [
      ...RUN.slice(0, 3),
      ev(10, "model.progress", { modelId: "flash", outputChars: 0, reasoningChars: 12_000 }),
    ];
    const thinking = activityOf(events, at(200)) as NonNullable<ReturnType<typeof activityOf>>;
    expect(formatActivity(thinking, { timeoutMs: 120_000 })).toContain("waiting 3:19, thinking ~3.0k tok ·");
    const receiving = activityOf(
      [...events, ev(20, "model.progress", { outputChars: 4_800, reasoningChars: 12_000 })],
      at(200),
    ) as NonNullable<ReturnType<typeof activityOf>>;
    expect(formatActivity(receiving)).toContain("receiving ~1.2k tok");
    // the answer clears it
    const done = activityOf([...events, ev(30, "model.call", { latencyMs: 29_000 })], at(200));
    expect(done?.receiving).toBeUndefined();
  });

  it("tells a slow answer from one past the model timeout", () => {
    const slow = activityOf(RUN, at(123 + 200)) as NonNullable<ReturnType<typeof activityOf>>;
    expect(formatActivity(slow)).toContain("waiting 3:20 — slower than usual");
    const hung = activityOf(RUN, at(123 + 400)) as NonNullable<ReturnType<typeof activityOf>>;
    expect(formatActivity(hung, { timeoutMs: 300_000 })).toContain("past the model timeout");
  });

  it("stops waiting when the run parks or finishes, and shortens long paths", () => {
    const parked = activityOf([...RUN, ev(130, "run.state", { state: "WAITING_HUMAN" })], at(500));
    expect(parked?.waitingMs).toBeUndefined();
    expect(parked?.finished).toBe(false);
    const done = activityOf(
      [...RUN.slice(0, 5), ev(70, "agent.finish", {}), ev(71, "run.state", { state: "COMPLETED" })],
      at(500),
    );
    expect(done?.finished).toBe(true);
    expect(formatActivity(done as NonNullable<typeof done>)).toContain(
      "last repo.read …/src/billing/senders/invoice-mailer.ts",
    );
    expect(activityOf([])).toBeUndefined();
  });
});

function stream(tty: boolean, columns = 60) {
  let text = "";
  const s = new Writable({
    write(c, _e, cb) {
      text += String(c);
      cb();
    },
  }) as Writable & { isTTY?: boolean; columns?: number };
  s.isTTY = tty;
  s.columns = columns;
  return { s, text: () => text };
}

describe("the progress line", () => {
  it("redraws one line on a terminal, cuts it to the width and clears it before other output", () => {
    const out = stream(false);
    const err = stream(true, 30);
    const o = createOutput(false, { out: out.s, err: err.s });
    expect(o.live).toBe(true);
    o.progress("⠋ 0:01 · map#1 onboard-mapper · model 0 calls");
    o.progress("⠙ 0:02");
    o.line("run run_1: COMPLETED");
    expect(err.text()).toBe("\r\u001b[2K⠋ 0:01 · map#1 onboard-mappe…\r\u001b[2K⠙ 0:02\r\u001b[2K");
    expect(out.text()).toBe("run run_1: COMPLETED\n");
  });

  it("draws nothing into a pipe, in --json mode or with JARVIS_PROGRESS=off", () => {
    for (const o of [
      createOutput(false, { out: stream(false).s, err: stream(false).s }),
      createOutput(true, { out: stream(false).s, err: stream(true).s }),
      createOutput(false, { out: stream(false).s, err: stream(true).s }, { progress: false }),
    ]) {
      expect(o.live).toBe(false);
    }
    const err = stream(false);
    createOutput(false, { out: stream(false).s, err: err.s }).progress("x");
    expect(err.text()).toBe("");
  });
});

describe("notices that stay in the terminal", () => {
  const RETRY = ev(301, "model.retry", {
    modelId: "deepseek-flash",
    attempt: 1,
    maxRetries: 2,
    attemptMs: 300_000,
    delayMs: 500,
    kind: "transient",
    status: 500,
    message:
      'model deepseek-flash: provider error (500): {"error":"Error processing request, traceId:0f1e2d3c4b5a69788796a5b4c3d2e1f0"}',
  });

  it("says why a call is retried, how long the attempt took and the provider's trace id", () => {
    const line = noticeOf(RETRY) as string;
    expect(line).toMatch(
      /^⚠ \d\d:\d\d:\d\d deepseek-flash: provider error \(500\) after 5:00 — retry 1\/2 in 0\.5s; traceId 0f1e2d3c4b5a69788796a5b4c3d2e1f0$/,
    );
    const failed = noticeOf(
      ev(902, "model.error", {
        modelId: "deepseek-flash",
        retries: 2,
        attemptMs: 300_000,
        kind: "transient",
        message: "model deepseek-flash: timeout: The operation was aborted due to timeout",
      }),
    );
    expect(failed).toMatch(/^✗ .* deepseek-flash: timeout after 5:00 — gave up after 3 attempts$/);
    expect(
      noticeOf(ev(903, "run.state", { state: "FAILED", reason: "model deepseek-flash: timeout" })),
    ).toMatch(/^✗ .* run FAILED: model deepseek-flash: timeout$/);
    expect(noticeOf(ev(904, "run.state", { state: "COMPLETED" }))).toBeUndefined();
    expect(noticeOf(RUN[3] as StoredEvent)).toBeUndefined();
  });

  it("prints them from a foreground run even without a terminal (a pipe, CI)", async () => {
    const journal: StoredEvent[] = [];
    const runtime = {
      events: {
        lastSeq: () => 0,
        list: ({ afterSeq }: { afterSeq: number }) => journal.filter((e) => e.seq > afterSeq),
      },
      runs: { get: () => undefined, releaseLease: () => false },
      loaded: { config: { models: {}, budget: { perStep: {} } } },
    } as unknown as Runtime;
    const err = stream(false);
    const ctx = {
      out: createOutput(false, { out: stream(false).s, err: err.s }),
    } as unknown as CliContext;
    const progress = followRun(ctx, runtime, { intervalMs: 5, signals: false });
    journal.push(RUN[0] as StoredEvent, RETRY);
    await new Promise((resolve) => setTimeout(resolve, 30));
    progress.stop();
    expect(err.text()).toContain("provider error (500) after 5:00 — retry 1/2");
    expect(err.text().match(/retry 1\/2/g)).toHaveLength(1);
  });
});

import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DecisionTakenError, recordDecision, requestRerun, waitingCard } from "../../src/app/decide.ts";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import { run } from "../../src/cli/main.ts";
import { createOutput } from "../../src/cli/output.ts";
import { createPrompt } from "../../src/cli/prompt.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/**
 * ADR-0023 §4: a card in the terminal picks up a decision made elsewhere — the page of `jarvis ui`,
 * `jarvis approve` in another tab — and goes on as after its own key, without racing for the lease.
 */
let sb: Sandbox;
const DEV = { kind: "user" as const, id: "dev@example.com", verified: false };

const GATED = `name: gated
entry: write
steps:
  - id: write
    kind: deterministic
    tool: artifact.write
    args: { type: spec, name: spec.md, content: "# Compact form: the upload toggle hides attached files" }
    outputs: [spec]
    transitions: { onSuccess: approve }
  - id: approve
    kind: approval
    artifactType: spec
    transitions: { onSuccess: DONE }
`;

beforeEach(() => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  sb.write("project/.jarvis/workflows/gated.yaml", GATED);
});
afterEach(() => sb.cleanup());

async function runtime(): Promise<Runtime> {
  const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
  return createRuntime(loaded, { env: {} });
}

async function waitFor(ok: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** `jarvis …` in this process; `stdin` stays open unless the test ends it — a person who has not typed. */
function jarvis(args: string[], env: NodeJS.ProcessEnv = {}, stdin?: NodeJS.ReadableStream) {
  let out = "";
  let err = "";
  const sink = (f: (s: string) => void) =>
    new Writable({
      write(c, _e, cb) {
        f(String(c));
        cb();
      },
    });
  const done = run(["node", "jarvis", ...args], {
    ...(stdin ? { stdin } : {}),
    streams: { out: sink((s) => (out += s)), err: sink((s) => (err += s)) },
    context: { cwd: sb.project, homeDir: sb.home, env: { PATH: process.env.PATH ?? "", ...env } },
  });
  return { done, out: () => out, err: () => err };
}

const ON = { JARVIS_INTERACTIVE: "on", JARVIS_CARD_POLL_MS: "40" };

/** The run and how many cards opened on it so far. */
function cards(rt: Runtime): { id?: string; open: number } {
  const id = rt.runs.list({ includeTerminal: true })[0]?.id;
  return { ...(id ? { id } : {}), open: id ? rt.events.list({ runId: id, kind: "card.open" }).length : 0 };
}

describe("the card picks up a decision made elsewhere", () => {
  it("accepted in the browser: the card says so and the run goes on in this terminal", async () => {
    const stdin = new PassThrough();
    const cmd = jarvis(["work", "Compact form", "--workflow", "gated"], ON, stdin);
    const rt = await runtime();
    await waitFor(() => cards(rt).open === 1);
    const id = cards(rt).id as string;
    // a terminal waits at the card: the page can say the decision goes on at once
    expect(waitingCard(rt, id)?.kind).toBe("approval");
    const r = rt.runs.require(id);
    const spec = rt.artifacts.listLatest(id, "spec")[0];
    if (!spec) throw new Error("no spec");
    recordDecision(rt, r, { actor: DEV, artifact: spec, type: "spec", decision: "approve", channel: "ui" });
    const code = await cmd.done;
    expect(code).toBe(0);
    expect(cmd.out()).toContain("✓ accepted in the browser by dev@example.com spec/spec.md@1");
    expect(cmd.out()).toContain("COMPLETED");
    // one decision, recorded once, with its channel; the card is closed
    expect(rt.artifacts.approvalsFor(spec.artifactId)).toHaveLength(1);
    const recorded = rt.events.list({ runId: id, kind: "approval.recorded" });
    expect(recorded.map((e) => e.payload?.channel)).toEqual(["ui"]);
    expect(waitingCard(rt, id)).toBeUndefined();
    // the key typed after the card went on is not read by anything
    stdin.end("a\n");
    await rt.close();
  });

  it("`approve --resume` in another terminal: the card follows that run instead of taking its lease", async () => {
    const stdin = new PassThrough();
    const card = jarvis(["work", "Billing: rounding in invoice totals", "--workflow", "gated"], ON, stdin);
    const rt = await runtime();
    await waitFor(() => cards(rt).open === 1);
    const id = cards(rt).id as string;
    const other = jarvis(["approve", id, "--resume"], { JARVIS_INTERACTIVE: "off" });
    expect(await other.done).toBe(0);
    expect(other.out()).toContain("COMPLETED");
    expect(await card.done).toBe(0);
    expect(card.out()).toContain("✓ accepted in another terminal by dev@example.com");
    expect(card.out()).toContain("COMPLETED");
    // what ran meanwhile shows up as if it ran here
    expect(card.err()).toContain("✓ [2/2] approve");
    // the run ran once: one lease, taken by the other command
    expect(rt.events.list({ runId: id, kind: "run.lease" })).toHaveLength(2);
    expect(rt.events.list({ runId: id, kind: "step.start" }).map((e) => e.payload?.stepId)).toEqual([
      "write",
      "approve",
      "approve",
    ]);
    stdin.end();
    await rt.close();
  });

  it("decided before the card opened: `jarvis continue` goes on with that decision", async () => {
    const parked = jarvis(["work", "Order form: phone number mask", "--workflow", "gated"], {
      JARVIS_INTERACTIVE: "off",
    });
    expect(await parked.done).toBe(10);
    const rt = await runtime();
    const id = cards(rt).id as string;
    const approved = jarvis(["approve", id]);
    expect(await approved.done).toBe(0);
    // a second decision on the same version is refused, with what was decided
    const again = jarvis(["approve", id, "--request-changes", "--comment", "late"]);
    expect(await again.done).toBe(1);
    expect(again.err()).toContain("spec/spec.md@1 is already decided: approve by dev@example.com");
    const stdin = new PassThrough();
    const c = jarvis(["c"], ON, stdin);
    expect(await c.done).toBe(0);
    expect(c.out()).toContain("✓ accepted in the terminal by dev@example.com");
    expect(c.out()).toContain("COMPLETED");
    stdin.end();
    await rt.close();
  });

  it("a used-up loop: “Run again” from the page goes on at the card", async () => {
    const rt = await runtime();
    const parked = rt.runs.create({
      task: "Compact form: the upload toggle hides attached files",
      workflow: "gated",
      owner: DEV,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
    });
    rt.runs.update(parked.id, { currentStep: "write", currentIteration: 3 });
    rt.runs.transition(parked.id, "RUNNING");
    rt.runs.transition(parked.id, "WAITING_HUMAN", {
      reason: "back edge write->write#defects_found exhausted after 2 iteration(s)",
      waitingFor: { kind: "loop", detail: "write->write#defects_found" },
    });
    rt.events.emit({ kind: "run.state", runId: parked.id, payload: { state: "WAITING_HUMAN" } });
    const stdin = new PassThrough();
    const cmd = jarvis(["c"], ON, stdin);
    await waitFor(() => cards(rt).open === 1);
    expect(waitingCard(rt, parked.id)?.kind).toBe("loop");
    requestRerun(rt, rt.runs.require(parked.id), DEV, "ui");
    // the step runs again and stops at the approval: a new card, answered here
    await waitFor(() => cards(rt).open === 2);
    stdin.write("a\n");
    expect(await cmd.done).toBe(0);
    expect(cmd.out()).toContain("↻ write runs again (asked in the browser by dev@example.com)");
    expect(cmd.out()).toContain("✓ accepted spec/spec.md@1");
    expect(cmd.out()).toContain("COMPLETED");
    stdin.end();
    await rt.close();
  });
});

describe("one decision per version", () => {
  it("recordDecision refuses a second decision on a decided version", async () => {
    const rt = await runtime();
    const r = rt.runs.create({
      task: "Billing: rounding in invoice totals",
      workflow: "gated",
      owner: DEV,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
    });
    const spec = rt.artifacts.put({
      runId: r.id,
      type: "spec",
      name: "spec.md",
      content: "# spec",
      mediaType: "text/markdown",
      provenance: { kind: "tool", capability: "artifact.write" },
    });
    recordDecision(rt, r, {
      actor: DEV,
      artifact: spec,
      type: "spec",
      decision: "request_changes",
      comment: "x",
    });
    expect(() =>
      recordDecision(rt, r, { actor: DEV, artifact: spec, type: "spec", decision: "approve", channel: "ui" }),
    ).toThrow(DecisionTakenError);
    expect(rt.artifacts.approvalsFor(spec.artifactId)).toHaveLength(1);
    expect(rt.events.list({ runId: r.id, kind: "approval.recorded" })[0]?.payload?.channel).toBe("cli");
    await rt.close();
  });
});

describe("a question abandoned by the card", () => {
  it("leaks no read: a line typed after it is dropped, the next question reads its own", async () => {
    const input = new PassThrough();
    const sink = new Writable({ write: (_c, _e, cb) => cb() });
    const prompt = createPrompt(input, createOutput(false, { out: sink, err: sink }));
    const abort = new AbortController();
    const first = prompt.ask("> ", { signal: abort.signal });
    abort.abort();
    expect(await first).toBeUndefined();
    input.write("a\n"); // meant for the card that went on
    await new Promise((r) => setTimeout(r, 20));
    const second = prompt.ask("> ");
    input.write("q\n");
    expect(await second).toBe("q");
    prompt.close();
  });
});

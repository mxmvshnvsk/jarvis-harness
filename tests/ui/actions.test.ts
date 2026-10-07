import { request } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../../src/app/engine.ts";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import type { FileToOpen } from "../../src/cli/checkout.ts";
import { run as cli } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { startUiServer, type UiServer } from "../../src/ui/server.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** ADR-0023 §3, §6 p.4: Accept / Send back / Run again / Open in editor from the page. */
let sb: Sandbox;
let rt: Runtime;
let ui: UiServer;
const DEV = { kind: "user" as const, id: "dev@example.com", verified: false };
const opened: Array<{ dir: string; files: readonly FileToOpen[] }> = [];

const GATED = `name: gated
entry: write
steps:
  - id: write
    kind: deterministic
    tool: artifact.write
    args: { type: spec, name: spec.md, content: "# Order form: phone number mask" }
    outputs: [spec]
    transitions: { onSuccess: approve }
  - id: approve
    kind: approval
    artifactType: spec
    transitions:
      onSuccess: DONE
      onOutcome:
        request_changes: { to: write, maxIterations: 2 }
`;

/** The same gate over a JSON spec with open questions. */
const QUESTIONS = JSON.stringify({
  title: "Delivery slots",
  summary: "Slots on the order form.",
  requirements: [{ id: "R1", text: "Slots come from logistics-api" }],
  openQuestions: [
    "What does GET /delivery-slots return for a closed zone?",
    "What does the form do when the slots service is down?",
    "The exact wording of the delivery terms?",
  ],
});
const GATED_QUESTIONS = GATED.replace("name: gated", "name: gatedq").replace(
  'args: { type: spec, name: spec.md, content: "# Order form: phone number mask" }',
  `args: { type: spec, name: spec.json, content: '${QUESTIONS}' }`,
);

beforeEach(async () => {
  sb = sandbox();
  sb.write("project/.jarvis/workflows/gatedq.yaml", GATED_QUESTIONS);
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  sb.write("project/.jarvis/workflows/gated.yaml", GATED);
  const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
  rt = createRuntime(loaded, { env: {} });
  opened.length = 0;
  ui = await startUiServer({
    runtime: rt,
    engine: createEngine(rt),
    port: 0,
    homeDir: sb.home,
    projectRoot: sb.project,
    pollMs: 30,
    actor: async () => DEV,
    open: (dir, files = []) => {
      opened.push({ dir, files });
      return "VS Code";
    },
  });
});
afterEach(async () => {
  await ui.close();
  await rt.close();
  sb.cleanup();
});

function post(
  path: string,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<{ status: number; location?: string }> {
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: ui.port,
        path,
        method: "POST",
        headers: {
          host: `127.0.0.1:${ui.port}`,
          origin: `http://127.0.0.1:${ui.port}`,
          cookie: `jarvis_ui_${ui.port}=${encodeURIComponent(ui.token)}`,
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            ...(res.headers.location ? { location: res.headers.location } : {}),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function getPage(path: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${ui.port}${path}`, {
    headers: { cookie: `jarvis_ui_${ui.port}=${encodeURIComponent(ui.token)}` },
  });
  return res.text();
}

/** `jarvis …` in this process, as a person at a terminal who has not typed yet. */
function jarvis(args: string[], stdin?: NodeJS.ReadableStream) {
  let out = "";
  const sink = new Writable({
    write(c, _e, cb) {
      out += String(c);
      cb();
    },
  });
  const done = cli(["node", "jarvis", ...args], {
    ...(stdin ? { stdin } : {}),
    streams: { out: sink, err: new Writable({ write: (_c, _e, cb) => cb() }) },
    context: {
      cwd: sb.project,
      homeDir: sb.home,
      env: {
        PATH: process.env.PATH ?? "",
        ...(stdin ? { JARVIS_INTERACTIVE: "on", JARVIS_CARD_POLL_MS: "40" } : { JARVIS_INTERACTIVE: "off" }),
      },
    },
  });
  return { done, out: () => out };
}

async function parked() {
  expect(await jarvis(["work", "Order form: phone number mask", "--workflow", "gated"]).done).toBe(10);
  const run = rt.runs.list({ includeTerminal: true })[0];
  if (!run) throw new Error("no run");
  const spec = rt.artifacts.listLatest(run.id, "spec")[0];
  if (!spec) throw new Error("no spec");
  return { run, spec, short: run.id.slice(4, 12) };
}

describe("deciding on the page", () => {
  it("Accept records the decision with the CLI's actor and channel ui; the run waits for `jarvis continue`", async () => {
    const { run, spec, short } = await parked();
    const page = await getPage(`/runs/${short}/artifacts/spec/spec.md`);
    expect(page).toContain(`name="t" value="${ui.token}"`);
    expect(page).toContain('value="approve"');

    const fields = { t: ui.token, artifact: spec.artifactId, version: "1", decision: "approve" };
    // a page of another origin, or without the token, records nothing
    expect((await post(`/runs/${short}/decide`, fields, { origin: "http://evil.example" })).status).toBe(403);
    expect((await post(`/runs/${short}/decide`, { ...fields, t: "nope" })).status).toBe(403);
    expect(rt.artifacts.approvalsFor(spec.artifactId)).toHaveLength(0);

    const res = await post(`/runs/${short}/decide`, fields);
    expect(res.status).toBe(303);
    expect(res.location).toBe(`/runs/${short}/artifacts/spec/spec.md?v=1`);
    const [approval] = rt.artifacts.approvalsFor(spec.artifactId);
    expect(approval?.decision).toBe("approve");
    expect(approval?.actor.id).toBe("dev@example.com");
    expect(rt.events.list({ runId: run.id, kind: "approval.recorded" })[0]?.payload?.channel).toBe("ui");
    const after = await getPage(`/runs/${short}/artifacts/spec/spec.md?v=1`);
    expect(after).toContain("accepted by dev@example.com in the browser");
    expect(after).toContain(`jarvis continue ${short}`);

    // a second decision on the same version is refused
    const again = await post(`/runs/${short}/decide`, {
      ...fields,
      decision: "request_changes",
      comment: "x",
    });
    expect(again.location).toContain("notice=taken");
    expect(rt.artifacts.approvalsFor(spec.artifactId)).toHaveLength(1);
    // and the terminal goes on with it
    const c = jarvis(["c"], new PassThrough());
    expect(await c.done).toBe(0);
    expect(c.out()).toContain("✓ accepted in the browser by dev@example.com");
  });

  it("Send back carries the comment and the line comments as `path:line — text`", async () => {
    const { spec, short } = await parked();
    const empty = await post(`/runs/${short}/decide`, {
      t: ui.token,
      artifact: spec.artifactId,
      version: "1",
      decision: "request_changes",
    });
    expect(empty.location).toContain("notice=empty");
    const res = await post(`/runs/${short}/decide`, {
      t: ui.token,
      artifact: spec.artifactId,
      version: "1",
      decision: "request_changes",
      comment: "Keep the mask optional.",
      lines: JSON.stringify([
        { where: "src/forms/order/PhoneInput.tsx:12", text: "use the country code here" },
        { where: "src/forms/order/PhoneInput.tsx:20", text: "  " },
      ]),
    });
    expect(res.status).toBe(303);
    const [approval] = rt.artifacts.approvalsFor(spec.artifactId);
    expect(approval?.decision).toBe("request_changes");
    expect(approval?.comment).toBe(
      "Keep the mask optional.\n\nComments on lines:\nsrc/forms/order/PhoneInput.tsx:12 — use the country code here",
    );
  });

  it("a terminal waiting at the card picks up the page's Accept and goes on", async () => {
    const stdin = new PassThrough();
    const card = jarvis(["work", "Billing: rounding in invoice totals", "--workflow", "gated"], stdin);
    const until = Date.now() + 5000;
    while (rt.events.list({ kind: "card.open" }).length === 0) {
      if (Date.now() > until) throw new Error("no card");
      await new Promise((r) => setTimeout(r, 20));
    }
    const run = rt.runs.list({ includeTerminal: true })[0];
    const spec = run ? rt.artifacts.listLatest(run.id, "spec")[0] : undefined;
    if (!run || !spec) throw new Error("no run");
    const short = run.id.slice(4, 12);
    expect(await getPage(`/runs/${short}/artifacts/spec/spec.md`)).toContain(
      "The terminal waiting there picks the decision up and goes on.",
    );
    await post(`/runs/${short}/decide`, {
      t: ui.token,
      artifact: spec.artifactId,
      version: "1",
      decision: "approve",
    });
    expect(await card.done).toBe(0);
    expect(card.out()).toContain("✓ accepted in the browser by dev@example.com");
    expect(card.out()).toContain("COMPLETED");
    stdin.end();
  });
});

describe("open questions answered on the page", () => {
  it("Jarvis's answers, the options and one's own answers go back with «Send back», and stay on record", async () => {
    expect(await jarvis(["work", "ABC-42 delivery slots", "--workflow", "gatedq"]).done).toBe(10);
    const run = rt.runs.list({ includeTerminal: true })[0];
    const spec = run ? rt.artifacts.listLatest(run.id, "spec")[0] : undefined;
    if (!run || !spec) throw new Error("no run");
    const short = run.id.slice(4, 12);
    // no model here: the gate is reached all the same, the failure said
    expect(rt.events.list({ runId: run.id, kind: "answers.failed" })).toHaveLength(1);
    rt.artifacts.put({
      runId: run.id,
      type: "answer-suggestions",
      name: "spec.json",
      content: JSON.stringify({
        for: `${spec.artifactId}@1`,
        items: [
          {
            question: "What does GET /delivery-slots return for a closed zone?",
            about: ["R1"],
            kind: "answer",
            answer: "An empty list with 200",
            options: [],
            sources: ["Confluence 4400123 · Responses"],
          },
          {
            question: "What does the form do when the slots service is down?",
            about: [],
            kind: "decision",
            options: [
              { text: "An error with «Try again»", note: "the order waits", suggested: false },
              { text: "The local schedule", note: "today's behaviour", suggested: true },
            ],
            sources: ["ABC-42 · plan, item 3"],
          },
          {
            question: "The exact wording of the delivery terms?",
            about: [],
            kind: "unknown",
            options: [],
            sources: [],
          },
        ],
      }),
      provenance: { kind: "agent", agentId: "answers" },
      sourceRefs: [`${spec.artifactId}@1`],
    });
    const page = await getPage(`/runs/${short}/artifacts/spec/spec.json`);
    expect(page).toContain('<a href="#questions">Questions <span class="muted">3</span></a>');
    expect(page).toContain('name="qa-1" value="jarvis" form="decide-form" checked');
    expect(page).toContain('name="qa-2" value="opt-1" form="decide-form" checked');
    expect(page).toContain('name="qa-3" value="own" form="decide-form" checked');
    expect(page).toContain("Confluence 4400123 · Responses");
    // a decision says what it stands on too
    expect(page).toContain("<span>ABC-42 · plan, item 3</span>");
    // the decision under the questions, a note folded there; no side column repeating the document
    expect(page).toContain('class="dock" data-decision id="decide-form"');
    expect(page).toContain('<details class="note"><summary>+ A note</summary>');
    expect(page).not.toContain("Your decision");
    const res = await post(`/runs/${short}/decide`, {
      t: ui.token,
      artifact: spec.artifactId,
      version: "1",
      decision: "request_changes",
      "qa-1": "jarvis",
      "qa-2": "opt-0",
      "qa-3": "analyst",
      comment: "Keep the slots for 3 days.",
    });
    expect(res.status).toBe(303);
    const [approval] = rt.artifacts.approvalsFor(spec.artifactId);
    expect(approval?.comment).toBe(
      [
        "Answers to the open questions (binding for the next version):",
        "1. What does GET /delivery-slots return for a closed zone?",
        "   → An empty list with 200",
        "2. What does the form do when the slots service is down?",
        "   → An error with «Try again»",
        "3. The exact wording of the delivery terms?",
        "   → open, for the analyst: keep it as a risk, do not decide it.",
        "",
        "Keep the slots for 3 days.",
      ].join("\n"),
    );
    // on record next to the version, and shown there
    const answers = rt.artifacts.listLatest(run.id, "answers")[0];
    expect(answers?.provenance.kind).toBe("human");
    expect(await getPage(`/runs/${short}/artifacts/spec/spec.json?v=1`)).toContain(
      'An empty list with 200 <span class="meta">— answered</span>',
    );
  });
});

describe("a used-up loop on the page", () => {
  it("Run again is recorded once for the card or `jarvis continue`; Open in editor opens the checkout", async () => {
    const r = rt.runs.create({
      task: "Compact form: the upload toggle hides attached files",
      workflow: "gated",
      owner: DEV,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
    });
    rt.runs.update(r.id, { currentStep: "write", currentIteration: 3 });
    rt.runs.transition(r.id, "RUNNING");
    rt.runs.transition(r.id, "WAITING_HUMAN", {
      reason: "back edge write->write#defects_found exhausted",
      waitingFor: { kind: "loop", detail: "write->write#defects_found" },
    });
    rt.events.emit({ kind: "run.state", runId: r.id, payload: { state: "WAITING_HUMAN" } });
    const short = r.id.slice(4, 12);
    const page = await getPage(`/runs/${short}`);
    expect(page).toContain("Run write again");
    expect(page).toContain("Open in editor");

    const open = await post(`/runs/${short}/open`, { t: ui.token });
    expect(open.location).toBe(`/runs/${short}?notice=opened&editor=VS%20Code`);
    expect(opened[0]?.dir).toBe(sb.project);
    expect(await getPage(open.location as string)).toContain("↗ opened in VS Code");

    expect((await post(`/runs/${short}/rerun`, { t: ui.token })).status).toBe(303);
    expect((await post(`/runs/${short}/rerun`, { t: ui.token })).status).toBe(303);
    const asked = rt.events.list({ runId: r.id, kind: "loop.rerun" });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.payload).toMatchObject({ step: "write", channel: "ui" });
    expect(asked[0]?.actor).toBe("user:dev@example.com");
    const after = await getPage(`/runs/${short}`);
    expect(after).toContain("write runs again — asked by dev@example.com from the page");
    expect(after).toContain(`jarvis continue ${short}`);
  });
  it("One more round sends the work back to the step the edge went to, with a note box for it", async () => {
    const r = rt.runs.create({
      task: "Delivery slots: the courier app sees closed zones",
      workflow: "gated",
      owner: DEV,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
    });
    rt.runs.update(r.id, { currentStep: "verify", currentIteration: 3 });
    rt.runs.transition(r.id, "RUNNING");
    rt.runs.transition(r.id, "WAITING_HUMAN", {
      reason: "back edge verify->write#defects_found exhausted",
      waitingFor: { kind: "loop", detail: "verify->write#defects_found" },
    });
    rt.events.emit({ kind: "run.state", runId: r.id, payload: { state: "WAITING_HUMAN" } });
    const short = r.id.slice(4, 12);
    const page = await getPage(`/runs/${short}`);
    expect(page).toContain('<input type="hidden" name="back" value="write">');
    expect(page).toContain("One more round of write");
    expect(page).toContain("Run verify again");
    expect(page).toContain("✎ Add a note for write");

    // a step the edge does not go back to is not taken: that is a plain run again
    expect((await post(`/runs/${short}/rerun`, { t: ui.token, back: "spec" })).status).toBe(303);
    expect(rt.events.list({ runId: r.id, kind: "loop.rerun" })[0]?.payload).toEqual({
      step: "verify",
      channel: "ui",
    });
  });

  it("One more round is recorded with the step it goes back to", async () => {
    const r = rt.runs.create({
      task: "Delivery slots: the courier app sees closed zones",
      workflow: "gated",
      owner: DEV,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
    });
    rt.runs.update(r.id, { currentStep: "verify", currentIteration: 3 });
    rt.runs.transition(r.id, "RUNNING");
    rt.runs.transition(r.id, "WAITING_HUMAN", {
      reason: "back edge verify->write#defects_found exhausted",
      waitingFor: { kind: "loop", detail: "verify->write#defects_found" },
    });
    rt.events.emit({ kind: "run.state", runId: r.id, payload: { state: "WAITING_HUMAN" } });
    const short = r.id.slice(4, 12);
    expect((await post(`/runs/${short}/rerun`, { t: ui.token, back: "write" })).status).toBe(303);
    const asked = rt.events.list({ runId: r.id, kind: "loop.rerun" });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.payload).toEqual({ step: "write", channel: "ui", back: true });
    expect(await getPage(`/runs/${short}`)).toContain("↻ one more round of write, then verify");
  });
});

describe("a stop on a budget, decided on the page", () => {
  function budgetStop(budget: Record<string, unknown>) {
    const run = rt.runs.create({
      task: "Order form: phone number mask",
      workflow: "gated",
      owner: DEV,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
    });
    rt.runs.update(run.id, { currentStep: "write", currentIteration: 1 });
    rt.runs.transition(run.id, "RUNNING");
    rt.checkpoints.save({ runId: run.id, stepId: "write", iteration: 1, kind: "suspend", state: { budget } });
    rt.runs.transition(run.id, "WAITING_HUMAN", {
      reason: "budget",
      waitingFor: { kind: "budget", detail: "x" },
    });
    rt.events.emit({ kind: "run.state", runId: run.id, payload: { state: "WAITING_HUMAN" } });
    return { run, short: run.id.slice(4, 12) };
  }

  it("the card says what ran out; more is recorded once, with the actor and channel ui", async () => {
    const { run, short } = budgetStop({
      scope: "agent",
      dimension: "toolCalls",
      used: 80,
      cap: 80,
      agent: "implementation",
    });
    const list = await getPage("/");
    expect(list).toContain("⏸ budget · write");
    expect(list).toContain("write stopped at 80 of 80 tool calls");
    const page = await getPage(`/runs/${short}`);
    expect(page).toContain("write stopped: 80 of 80 tool calls");
    expect(page).toContain("its conversation is kept");
    expect(page).toContain("+40 tool calls and go on");
    expect(page).toContain("Finish with what it has");
    expect(page).toContain(`action="/runs/${short}/budget"`);

    const bad = await post(`/runs/${short}/budget`, { t: ui.token, choice: "more", amount: "-3" });
    expect(bad.location).toBe(`/runs/${short}?notice=amount`);
    expect((await post(`/runs/${short}/budget`, { t: "nope", choice: "finish" })).status).toBe(403);
    expect(rt.events.list({ runId: run.id, kind: "budget.grant" })).toHaveLength(0);

    const res = await post(`/runs/${short}/budget`, { t: ui.token, choice: "more", amount: "25" });
    expect(res.status).toBe(303);
    expect(res.location).toBe(`/runs/${short}`);
    // a second press (another window) records nothing more
    await post(`/runs/${short}/budget`, { t: ui.token, choice: "finish" });
    const grants = rt.events.list({ runId: run.id, kind: "budget.grant" });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      stepId: "write",
      actor: "user:dev@example.com",
      payload: { scope: "agent", toolCalls: 25, channel: "ui" },
    });
    const after = await getPage(`/runs/${short}`);
    expect(after).toContain("↻ +25 tool calls — decided by dev@example.com from the page");
    expect(after).toContain(`jarvis continue ${short}`);
  });

  it("finish after a cap of the step: the allowance for the result document comes with it", async () => {
    const { run, short } = budgetStop({
      scope: "perStep",
      dimension: "outputTokens",
      used: 40_312,
      cap: 40_000,
    });
    expect(await getPage(`/runs/${short}`)).toContain("budget.perStep");
    await post(`/runs/${short}/budget`, { t: ui.token, choice: "finish" });
    expect(rt.events.list({ runId: run.id, kind: "budget.grant" })[0]?.payload).toMatchObject({
      scope: "perStep",
      finish: true,
      requests: 4,
      outputTokens: 32_000,
    });
  });
});

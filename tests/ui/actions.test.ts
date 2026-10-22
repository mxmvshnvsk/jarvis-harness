import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../../src/app/engine.ts";
import { resumableOf } from "../../src/app/resumable.ts";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import type { FileToOpen } from "../../src/cli/checkout.ts";
import { run as cli } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { openConflict } from "../../src/interaction/conflict.ts";
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

describe("the steps as they went", () => {
  it("a gate that sent the work back is not a pass; a step the run left unfinished is stopped, not done", async () => {
    const { run } = await parked();
    // the person sent the spec back: the gate's round ends with request_changes, the work goes to write#2
    rt.events.emit({
      kind: "step.finish",
      runId: run.id,
      stepId: "approve",
      payload: { stepId: "approve", status: "success", outcome: "request_changes" },
    });
    rt.events.emit({
      kind: "workflow.loop",
      runId: run.id,
      payload: { edge: "approve->write#request_changes", iteration: 1, max: 2 },
    });
    rt.events.emit({
      kind: "step.start",
      runId: run.id,
      stepId: "write",
      iteration: 2,
      payload: { stepId: "write", iteration: 2 },
    });
    rt.runs.transition(run.id, "RUNNING");
    rt.runs.update(run.id, { currentStep: "write", currentIteration: 2 });
    rt.runs.acquireLease(run.id, "cli:host:1", 60_000);
    const { runPage } = await import("../../src/ui/model.ts");
    const { runContent } = await import("../../src/ui/pages.ts");
    const status = async () =>
      Object.fromEntries(
        (await runPage(rt, createEngine(rt), rt.runs.get(run.id) as never, { homeDir: sb.home })).steps.map(
          (s) => [s.id, s.status],
        ),
      );
    expect(await status()).toEqual({ write: "running", approve: "returned" });
    const body = runContent(
      await runPage(rt, createEngine(rt), rt.runs.get(run.id) as never, { homeDir: sb.home }),
      Date.now(),
    ).value;
    expect(body).toMatch(/<li class="step returned">\n<span class="ic warn" aria-hidden="true">↺<\/span>/);
    expect(body).toContain("sent the work back to write 1/2 — request_changes");
    // Ctrl-C in write#2: the process is gone, the step did not finish — not «done» by its first round
    rt.runs.acquireLease(run.id, "cli:host:1", -1000);
    rt.runs.transition(run.id, "SUSPENDED");
    expect((await status()).write).toBe("stopped");
  });
});

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
    // the dock is the last thing on the page: inside the questions it came unstuck once they scrolled away
    expect(page).toMatch(/id="decide-form"[\s\S]*<\/form>\s*<\/main>/);
    expect(page.slice(page.indexOf('data-live="questions"'), page.indexOf('id="decide-form"'))).toContain(
      "</section>",
    );
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

describe("failed checks stop the run: the card and the choices", () => {
  const failing = {
    check: "test",
    command: "./gradlew test",
    ok: false,
    failures: [
      {
        suite: "com.example.OrderTotalTest",
        name: "discount is rounded once()",
        message: "expected: 99.90 but was: 99.89",
        expected: "99.90",
        actual: "99.89",
        stack: [{ file: "src/main/kotlin/OrderTotal.kt", line: 41, changed: true }],
      },
    ],
    tests: { failed: 1, total: 14 },
  };
  function stopped() {
    const r = rt.runs.create({
      task: "ABC-142 the order total is rounded twice after a discount",
      workflow: "fix",
      owner: DEV,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
    });
    for (const [step, i] of [
      ["spec", 1],
      ["implementation", 1],
      ["verify", 1],
      ["implementation", 2],
      ["verify", 2],
    ] as const)
      rt.history.start(r.id, step, i);
    for (const i of [1, 2])
      rt.artifacts.put({
        runId: r.id,
        type: "checks",
        name: "checks.json",
        content: JSON.stringify({ results: [failing] }),
        provenance: { kind: "tool", capability: "project.checks" },
        stepId: "checks",
        iteration: i,
      });
    rt.artifacts.put({
      runId: r.id,
      type: "implementation",
      name: "implementation.json",
      content: JSON.stringify({
        summary: "Moved the rounding after the discount.",
        notes: ["Could not find where the discount is rounded."],
      }),
      provenance: { kind: "agent", agentId: "implementation" },
      stepId: "implementation",
      iteration: 2,
    });
    rt.artifacts.put({
      runId: r.id,
      type: "loop-exhausted",
      name: "verify->implementation#defects_found.json",
      content: JSON.stringify({
        edge: "verify->implementation#defects_found",
        iterations: 1,
        maxIterations: 2,
        why: "same-failure",
        round: 2,
      }),
      provenance: { kind: "tool", capability: "runtime.loop" },
      stepId: "verify",
      iteration: 2,
    });
    rt.runs.update(r.id, { currentStep: "verify", currentIteration: 2 });
    rt.runs.transition(r.id, "RUNNING");
    rt.runs.transition(r.id, "WAITING_HUMAN", {
      reason: "checks of round 2 failed as the round before",
      waitingFor: { kind: "loop", detail: "verify->implementation#defects_found" },
    });
    rt.events.emit({ kind: "run.state", runId: r.id, payload: { state: "WAITING_HUMAN" } });
    return { r, short: r.id.slice(4, 12) };
  }

  it("says why it asks, the rounds, the failure, what the implementation said, the whole output", async () => {
    const { short } = stopped();
    const page = await getPage(`/runs/${short}`);
    expect(page).toContain("Waits for you · verify · round 2 of 3");
    expect(page).toContain("Tests failed again the same way");
    expect(page).toContain("Round 2 failed exactly as round 1");
    expect(page).toContain("<b>Round 1 · 1 failed</b>");
    expect(page).toContain('<span class="meta">the same as round 1</span>');
    expect(page).toContain("<h3>OrderTotalTest › discount is rounded once</h3>");
    expect(page).toContain('<span class="pill bad">same as round 1</span>');
    expect(page).toContain(
      "Moved the rounding after the discount. Could not find where the discount is rounded.",
    );
    expect(page).toContain('value="hint" data-go="Send back to implementation" checked');
    expect(page).toContain('value="go-on"');
    expect(page).toContain(`action="/runs/${short}/tests"`);
    // the button is in the dock at the bottom of the screen and submits the card's form
    expect(page).toContain('<div class="dock" data-live="dock" role="region" aria-label="Actions">');
    expect(page).toContain(
      '<button type="submit" form="tests-form" class="btn primary big" data-choice-go>Send back to implementation</button>',
    );
    expect(page).toContain('id="tests-form"');
    expect(page).toContain(`href="/runs/${short}/artifacts/checks/checks.json?v=2"`);
  });

  it("a hint goes back to implementation as a redo with the person's words; empty, it is asked for", async () => {
    const { r, short } = stopped();
    expect((await post(`/runs/${short}/tests`, { t: ui.token, choice: "hint", text: " " })).location).toBe(
      `/runs/${short}?notice=no-hint`,
    );
    await post(`/runs/${short}/tests`, {
      t: ui.token,
      choice: "hint",
      text: "PromoClient.percentOf rounds the discount",
    });
    const redo = rt.events.list({ runId: r.id, kind: "step.redo" })[0]?.payload as {
      step: string;
      note: string;
    };
    expect(redo.step).toBe("implementation");
    expect(redo.note).toBe(
      "The checks failed (OrderTotalTest › discount is rounded once()). A person looked at it: PromoClient.percentOf rounds the discount",
    );
  });

  it("the test is wrong, I fix it myself, go on without it", async () => {
    const a = stopped();
    await post(`/runs/${a.short}/tests`, { t: ui.token, choice: "test-wrong" });
    expect(
      (rt.events.list({ runId: a.r.id, kind: "step.redo" })[0]?.payload as { note?: string } | undefined)
        ?.note,
    ).toContain("Change the test so it checks what the specification asks");
    const b = stopped();
    await post(`/runs/${b.short}/tests`, { t: ui.token, choice: "myself" });
    expect(rt.events.list({ runId: b.r.id, kind: "loop.rerun" })[0]?.payload).toEqual({
      step: "verify",
      channel: "ui",
    });
    const c = stopped();
    await post(`/runs/${c.short}/tests`, { t: ui.token, choice: "go-on", text: "flaky on CI, ABC-150" });
    expect(rt.events.list({ runId: c.r.id, kind: "loop.goOn" })[0]?.payload).toMatchObject({
      failures: ["OrderTotalTest › discount is rounded once()"],
      note: "flaky on CI, ABC-150",
    });
    expect(await getPage(`/runs/${c.short}`)).toContain(
      "goes on without the failed checks — decided by dev@example.com",
    );
  });
});

describe("implementation asks, with the answers it sees", () => {
  it("each answer is a button: one click answers as if typed", async () => {
    const r = rt.runs.create({
      task: "ABC-142 the order total is rounded twice after a discount",
      workflow: "fix",
      owner: DEV,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
    });
    rt.runs.update(r.id, { currentStep: "implementation", currentIteration: 2 });
    rt.runs.transition(r.id, "RUNNING");
    const thread = rt.interactions.open({
      runId: r.id,
      kind: "clarification",
      stepId: "implementation",
      iteration: 2,
      origin: "agent:implementation",
      openedBy: "agent:implementation",
      meta: {
        agent: "implementation",
        answers: ["Follow the spec: change RefundTest", "Keep refunds as they are"],
      },
      message: {
        role: "jarvis",
        actor: "agent:implementation",
        text: "RefundTest expects the discount rounded on its own (99.89); the spec says round once at the end. Which is right?",
      },
    });
    rt.runs.transition(r.id, "WAITING_HUMAN", {
      reason: `clarification needed by implementation: ${thread.id}`,
      waitingFor: { kind: "clarification", interactionId: thread.id },
    });
    rt.events.emit({ kind: "run.state", runId: r.id, payload: { state: "WAITING_HUMAN" } });
    const short = r.id.slice(4, 12);
    const page = await getPage(`/runs/${short}`);
    expect(page).toContain('<div class="answers" role="group" aria-label="The answers implementation sees">');
    expect(page).toContain('name="answer" value="Follow the spec: change RefundTest" class="btn small"');
    expect(page).toContain('placeholder="Or answer in your words"');
    await post(`/runs/${short}/clarify`, {
      t: ui.token,
      answer: "Follow the spec: change RefundTest",
      text: "",
    });
    expect(rt.interactions.messages(thread.id)[1]).toMatchObject({
      role: "human",
      text: "Follow the spec: change RefundTest",
    });
  });
});

describe("steering a run from the page", () => {
  it("the switches record who asked; a run that ended takes none", async () => {
    const r = rt.runs.create({
      task: "ABC-142 the order total",
      workflow: "fix",
      owner: DEV,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
    });
    rt.runs.update(r.id, { currentStep: "implementation", currentIteration: 1 });
    rt.runs.transition(r.id, "RUNNING");
    const short = r.id.slice(4, 12);
    await post(`/runs/${short}/steer`, { t: ui.token, what: "ask", on: "on" });
    await post(`/runs/${short}/steer`, { t: ui.token, what: "stop-after", on: "on" });
    expect(rt.events.list({ runId: r.id, kind: "run.checksAsk" })[0]).toMatchObject({
      actor: "user:dev@example.com",
      payload: { ask: "every-failure" },
    });
    expect(rt.events.list({ runId: r.id, kind: "run.pauseAfter" })[0]?.payload).toEqual({
      step: "implementation",
      iteration: 1,
    });
    rt.runs.transition(r.id, "CANCELLED");
    expect((await post(`/runs/${short}/steer`, { t: ui.token, what: "ask", on: "off" })).location).toBe(
      `/runs/${short}?notice=already-ended`,
    );
  });
});

describe("a conflict with a hand edit (ADR-0019 §6.3)", () => {
  /** A run whose step changed a.ts and a person then changed it too, parked on the conflict. */
  function conflicted() {
    const repo = join(sb.root, "payments-service");
    mkdirSync(repo, { recursive: true });
    const env = {
      PATH: process.env.PATH ?? "",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    };
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env }).trim();
    const commit = (text: string, message: string) => {
      writeFileSync(join(repo, "a.ts"), text);
      git(["add", "-A"]);
      git(["commit", "-q", "-m", message]);
      return git(["rev-parse", "HEAD"]);
    };
    git(["init", "-q", "-b", "main"]);
    const base = commit("one\n", "init");
    const runCommit = commit("the run\n", "jarvis: write #1 SUSPENDED");
    const humanCommit = commit("mine\n", "human edit");
    const r = rt.runs.create({
      task: "Payments: retry only temporary rejections",
      workflow: "gated",
      owner: DEV,
      workspace: { mode: "worktree", repoRoot: repo, path: repo, baseRef: "HEAD", baseCommit: base },
      dataClass: "internal",
    });
    rt.runs.update(r.id, { currentStep: "write" });
    rt.checkpoints.save({
      runId: r.id,
      stepId: "write",
      iteration: 1,
      kind: "suspend",
      headCommit: runCommit,
    });
    rt.runs.transition(r.id, "RUNNING");
    const run = rt.runs.require(r.id);
    const thread = openConflict(rt, run, { files: ["a.ts"], byHand: ["a.ts"], runCommit, humanCommit });
    rt.runs.transition(r.id, "WAITING_HUMAN", {
      reason: "a.ts changed both by write and by hand",
      waitingFor: { kind: "conflict", interactionId: thread.id },
    });
    rt.events.emit({ kind: "run.state", runId: r.id, payload: { state: "WAITING_HUMAN" } });
    return { run: rt.runs.require(r.id), thread, repo, short: r.id.slice(4, 12), git };
  }

  it("the page names the file and takes the run's version; the person's stays aside", async () => {
    const { run, thread, repo, short, git } = conflicted();
    const page = await getPage(`/runs/${short}`);
    expect(page).toContain("write had changed a file you then changed by hand");
    expect(page).toContain("a.ts");
    expect(page).toContain("Keep mine");
    expect(page).toContain("Take the run&#39;s");
    expect(page).toContain("I combined them");
    expect(await getPage("/")).toContain("conflict · write");

    const done = await post(`/runs/${short}/conflict`, { t: ui.token, choice: "run" });
    expect(done.location).toBe(`/runs/${short}?notice=conflict-decided`);
    expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe("the run\n");
    expect(git(["show", `refs/jarvis/set-aside/${short}/${thread.id}:a.ts`])).toBe("mine");
    expect(rt.interactions.get(thread.id)?.state).toBe("resolved");
    expect(rt.interactions.get(thread.id)?.resolvedBy).toBe("dev@example.com");
    expect(resumableOf(rt, rt.runs.require(run.id))).toBe("decided");
    expect(await getPage(`/runs/${short}`)).toContain("✓ run — decided by dev@example.com");
    // decided once: a second press finds nothing open
    expect((await post(`/runs/${short}/conflict`, { t: ui.token, choice: "mine" })).location).toBe(
      `/runs/${short}?notice=not-waiting`,
    );
  });

  it("`jarvis answer <run> mine` keeps the person's files; another word is refused", async () => {
    const { thread, repo, short } = conflicted();
    expect(await jarvis(["answer", short, "theirs"]).done).toBe(1);
    expect(rt.interactions.get(thread.id)?.state).toBe("open");
    const answered = jarvis(["answer", short, "mine"]);
    expect(await answered.done).toBe(0);
    expect(answered.out()).toContain("keep your files; the step starts again from them");
    expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe("mine\n");
    expect(rt.interactions.get(thread.id)?.state).toBe("resolved");
    expect(rt.runs.require(thread.runId).currentIteration).toBe(2);
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

describe("the implementation gate says how to try it", () => {
  it("into the checkout, how to start, what to check by hand, what Accept and Send back lead to", async () => {
    sb.write(
      "home/.jarvis/worktrees/web/run-ABC-42/package.json",
      JSON.stringify({ scripts: { "start-dev": "x" } }),
    );
    sb.write("home/.jarvis/worktrees/web/run-ABC-42/yarn.lock", "");
    const run = rt.runs.create({
      task: "ABC-42 delivery slots",
      workflow: "gated",
      owner: DEV,
      workspace: {
        mode: "worktree",
        repoRoot: sb.project,
        path: `${sb.home}/.jarvis/worktrees/web/run-ABC-42`,
        branch: "jarvis/ABC-42/run",
        baseRef: "HEAD",
      },
      dataClass: "internal",
    });
    rt.artifacts.put({
      runId: run.id,
      type: "spec",
      name: "spec.json",
      content: JSON.stringify({
        title: "Delivery slots",
        goals: ["g"],
        requirements: [
          { id: "R1", text: "Slots come from logistics-api", acceptance: ["a closed zone shows no slots"] },
        ],
      }),
      provenance: { kind: "agent", agentId: "spec" },
    });
    const impl = rt.artifacts.put({
      runId: run.id,
      type: "implementation",
      name: "implementation.json",
      content: JSON.stringify({ summary: "Slots on the order form" }),
      provenance: { kind: "agent", agentId: "implementation" },
    });
    rt.runs.update(run.id, { currentStep: "approve", currentIteration: 1 });
    rt.runs.transition(run.id, "RUNNING");
    rt.checkpoints.save({
      runId: run.id,
      stepId: "approve",
      iteration: 1,
      kind: "suspend",
      state: { awaitingApproval: { type: "implementation", version: 1 } },
    });
    rt.runs.transition(run.id, "WAITING_HUMAN", {
      reason: "approval",
      waitingFor: { kind: "approval", detail: "implementation" },
    });
    const short = run.id.slice(4, 12);
    // the run page: one line to paste
    const card = await getPage(`/runs/${short}`);
    expect(card).toContain("Try it before you decide");
    expect(card).toContain("cd ~/.jarvis/worktrees/web/run-ABC-42 &amp;&amp; yarn start-dev");
    expect(card).toContain("guessed from package.json");

    const page = await getPage(`/runs/${short}/artifacts/implementation/implementation.json`);
    expect(page).toContain('<a href="#try">Try it</a>');
    expect(page).toContain("Go to the run&#39;s checkout");
    expect(page).toContain("branch jarvis/ABC-42/run");
    expect(page).toContain("<code>yarn start-dev</code>");
    expect(page).toContain("<b>R1</b> Slots come from logistics-api");
    expect(page).toContain('<input type="checkbox"> a closed zone shows no slots');
    expect(page).toContain(`git switch -c try-${short} jarvis/ABC-42/run`);
    expect(page).toContain("<b>Send back</b> → write again");
    expect(page).toContain("<b>Accept</b> → the run completes");
    expect(impl.version).toBe(1);

    // Open in editor from here comes back here
    const open = await post(`/runs/${short}/open`, {
      t: ui.token,
      return: `/runs/${short}/artifacts/implementation/implementation.json`,
    });
    expect(open.location).toBe(
      `/runs/${short}/artifacts/implementation/implementation.json?notice=opened&editor=VS%20Code`,
    );
    expect((await post(`/runs/${short}/open`, { t: ui.token, return: "https://elsewhere" })).location).toBe(
      `/runs/${short}?notice=opened&editor=VS%20Code`,
    );
  });
});

describe("a file a page refers to", () => {
  const getJson = async (path: string, referer?: string) => {
    const res = await fetch(`http://127.0.0.1:${ui.port}${path}`, {
      headers: {
        cookie: `jarvis_ui_${ui.port}=${encodeURIComponent(ui.token)}`,
        ...(referer ? { referer: `http://127.0.0.1:${ui.port}${referer}` } : {}),
      },
    });
    return {
      status: res.status,
      body: (await res.json()) as { opened?: string; path?: string; error?: string },
    };
  };

  it("opens in the editor at its line: in the run's checkout, a shortened path found by its end", async () => {
    sb.write("project/src/orders/SlotService.java", "class SlotService {}\n");
    execFileSync("git", ["init", "-q"], { cwd: sb.project });
    execFileSync("git", ["add", "-A"], { cwd: sb.project });
    const checkout = `${sb.root}/checkout`;
    sb.write("checkout/src/orders/SlotService.java", "class SlotService { int changed; }\n");
    const r = rt.runs.create({
      task: "Delivery slots for ABC-42",
      workflow: "gated",
      owner: DEV,
      workspace: { mode: "worktree", repoRoot: sb.project, path: checkout, baseRef: "HEAD" },
      dataClass: "internal",
    });
    const short = r.id.slice(4, 12);

    const inRun = await getJson("/open?path=src%2Forders%2FSlotService.java&line=12&js=1", `/runs/${short}`);
    expect(inRun).toEqual({ status: 200, body: { opened: "VS Code", path: "src/orders/SlotService.java" } });
    expect(opened[0]).toEqual({
      dir: checkout,
      files: [{ path: `${checkout}/src/orders/SlotService.java`, line: 12 }],
    });

    const shortened = await getJson("/open?path=SlotService.java&js=1");
    expect(shortened.body.path).toBe("src/orders/SlotService.java");
    expect(opened[1]?.dir).toBe(sb.project);

    expect((await getJson("/open?path=..%2F..%2Fetc%2Fpasswd&js=1")).status).toBe(404);
    expect((await getJson("/open?path=Missing.java&js=1")).body.error).toContain("is not a file of");
  });
});

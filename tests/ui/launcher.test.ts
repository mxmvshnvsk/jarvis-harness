import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../../src/app/engine.ts";
import { resumableOf } from "../../src/app/resumable.ts";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { recordGiven } from "../../src/interaction/answers.ts";
import { createLauncher, type Launcher } from "../../src/ui/launcher.ts";
import { startUiServer, type UiServer } from "../../src/ui/server.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** ADR-0023 §6: tasks started from the page, run by the CLI in the background, driven by the page. */
let sb: Sandbox;
let rt: Runtime;
let launcher: Launcher;
let ui: UiServer | undefined;
const DEV = { kind: "user" as const, id: "dev@example.com", verified: false };

beforeEach(async () => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  // a "CLI" that notes where and with what it was started
  sb.write("cli.sh", `#!/bin/sh\necho "$PWD|$JARVIS_INTERACTIVE|$*" >> "${sb.root}/calls.txt"\n`);
  const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
  rt = createRuntime(loaded, { env: {} });
  launcher = createLauncher({
    runtime: rt,
    cli: ["sh", join(sb.root, "cli.sh")],
    logDir: join(sb.root, "launches"),
  });
});
afterEach(async () => {
  await ui?.close();
  ui = undefined;
  await rt.close();
  sb.cleanup();
});

const calls = async (n: number): Promise<string[]> => {
  const file = join(sb.root, "calls.txt");
  for (let i = 0; i < 100; i++) {
    const lines = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
    if (lines.length >= n) return lines;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("the CLI was not started");
};

const createRun = (task: string) =>
  rt.runs.create({
    task,
    workflow: "fix",
    owner: DEV,
    workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
    dataClass: "internal",
  });

describe("the launcher", () => {
  it("starts the CLI without a terminal, finds the run it made and goes on with it after a wait", async () => {
    const launch = launcher.start({
      task: "Order form: phone number mask",
      workflow: "fix",
      repoRoot: sb.project,
    });
    expect((await calls(1))[0]).toBe(`${sb.project}|off|fix Order form: phone number mask`);
    // the CLI creates its run; the launcher matches it on its tick
    const run = createRun("Order form: phone number mask");
    launcher.tend();
    expect(launch.runId).toBe(run.id);
    expect(launcher.drives(run.id)).toBe(true);
    expect(rt.events.list({ runId: run.id, kind: "run.driver" })).toHaveLength(1);
    // a run started elsewhere is not the page's
    expect(launcher.drives(createRun("Billing: rounding in invoice totals").id)).toBe(false);
    // waiting for a model: resumed once the wait is over
    await new Promise((r) => setTimeout(r, 100)); // the first CLI process has exited
    rt.runs.update(run.id, { currentStep: "implementation", currentIteration: 1 });
    rt.runs.transition(run.id, "RUNNING");
    rt.runs.transition(run.id, "WAITING_BUDGET", {
      reason: "model flash is unavailable",
      waitingFor: { kind: "model", detail: "flash" },
    });
    rt.checkpoints.save({
      runId: run.id,
      stepId: "implementation",
      iteration: 1,
      kind: "suspend",
      state: { resumeAfter: new Date(Date.now() + 60_000).toISOString() },
    });
    launcher.tend();
    launcher.tend(new Date(Date.now() + 120_000));
    expect((await calls(2))[1]).toBe(`${sb.project}|off|resume ${run.id}`);
  });
});

describe("a task whose design changed at the same link", () => {
  it("the box on the page starts the CLI with --fresh design", async () => {
    launcher.start({ task: "ABC-42", workflow: "research", repoRoot: sb.project, freshDesign: true });
    expect((await calls(1))[0]).toBe(`${sb.project}|off|research ABC-42 --fresh design`);
  });

  it("the run keeps what the task asked: a resume reads the frames again too", () => {
    const run = rt.runs.create({
      task: "ABC-42",
      workflow: "research",
      owner: DEV,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
      options: { fresh: ["design"] },
    });
    expect(rt.runs.get(run.id)?.options).toEqual({ fresh: ["design"] });
    expect(createRun("Order form: phone number mask").options).toBeUndefined();
  });
});

describe("module research from the page", () => {
  it("runs one research at a time: the rest wait in a queue, in order, and can be taken out", async () => {
    const first = launcher.startModule({
      module: "src/orders",
      note: "how totals are rounded",
      repoRoot: sb.project,
    });
    const second = launcher.startModule({ module: "src/billing", repoRoot: sb.project });
    const third = launcher.startModule({ module: "src/shared/upload", repoRoot: sb.project });
    expect(first.queued).toBe(false);
    expect([second.queued, third.queued]).toEqual([true, true]);
    expect((await calls(1))[0]).toBe(
      `${sb.project}|off|onboard --module src/orders --note how totals are rounded`,
    );
    // the CLI made its run; it is the launch's once matched by the module
    const run = rt.runs.create({
      task: "Map the module `src/orders` of this repository for onboarding.",
      workflow: "onboard-module",
      owner: DEV,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
    });
    rt.artifacts.put({
      runId: run.id,
      type: "module-input",
      name: "module.json",
      content: JSON.stringify({ module: "src/orders" }),
      provenance: { kind: "tool", capability: "onboard.module" },
    });
    rt.runs.transition(run.id, "RUNNING");
    await new Promise((r) => setTimeout(r, 100)); // the first CLI process has exited
    launcher.tend();
    expect(first.runId).toBe(run.id);
    // its run still goes on: the queue waits
    expect(second.queued).toBe(true);
    expect(launcher.unqueue(third.id)).toBe(true);
    expect(launcher.unqueue(first.id)).toBe(false);
    rt.runs.transition(run.id, "COMPLETED");
    launcher.tend();
    expect(second.queued).toBe(false);
    expect((await calls(2))[1]).toBe(`${sb.project}|off|onboard --module src/billing`);
    expect(launcher.list().some((l) => l.id === third.id)).toBe(false);
  });
});

describe("New task on the page", () => {
  const post = (
    path: string,
    fields: Record<string, string>,
  ): Promise<{ status: number; location?: string }> => {
    const body = new URLSearchParams(fields).toString();
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: ui?.port,
          path,
          method: "POST",
          headers: {
            host: `127.0.0.1:${ui?.port}`,
            origin: `http://127.0.0.1:${ui?.port}`,
            cookie: `jarvis_ui_${ui?.port}=${encodeURIComponent(ui?.token ?? "")}`,
            "content-type": "application/x-www-form-urlencoded",
            "content-length": String(Buffer.byteLength(body)),
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
  };
  const page = async (path: string): Promise<string> =>
    (
      await fetch(`http://127.0.0.1:${ui?.port}${path}`, {
        headers: { cookie: `jarvis_ui_${ui?.port}=${encodeURIComponent(ui?.token ?? "")}` },
      })
    ).text();

  it("a form for the task; Start runs the CLI in the repository and the launch shows up under Running", async () => {
    ui = await startUiServer({
      runtime: rt,
      engine: createEngine(rt),
      port: 0,
      homeDir: sb.home,
      projectRoot: sb.project,
      pollMs: 30,
      actor: async () => DEV,
      launcher,
    });
    const runs = await page("/");
    expect(runs).toContain('<a class="btn primary small" href="/#new">New task</a>');
    expect(runs).toContain('action="/runs/new"');
    // research first and chosen: find out before changing anything
    expect(runs).toContain('<option value="research" selected>research — find out and write it down');
    expect(runs).toContain('<option value="fix">fix — a short way for a bug');
    expect((await post("/runs/new", { task: "x", workflow: "fix" })).status).toBe(403); // no token
    const token = ui.token;
    expect((await post("/runs/new", { t: token, task: " ", workflow: "fix" })).location).toContain(
      "notice=no-task",
    );
    expect(
      (await post("/runs/new", { t: token, task: "x", workflow: "fix", repo: "/etc" })).location,
    ).toContain("notice=no-repo");
    const started = await post("/runs/new", {
      t: token,
      task: "Compact form: the upload toggle hides attached files",
      workflow: "fix",
      repo: sb.project,
    });
    expect(started.status).toBe(303);
    expect(started.location).toMatch(/^\/launches\/[0-9a-f]{12}$/);
    expect((await calls(1))[0]).toBe(
      `${sb.project}|off|fix Compact form: the upload toggle hides attached files`,
    );
    // the browser lands on the launch: it prepares, reloads itself, and becomes the run's page
    const launchPage = await page(started.location ?? "/");
    expect(launchPage).toContain("Compact form: the upload toggle hides attached files");
    expect(launchPage).toMatch(/Preparing the run's checkout|ended without a run/);
    if (launchPage.includes("Preparing the run's checkout")) {
      // refreshed in place, so the header's popover stays open; a full reload only without scripts
      expect(launchPage).toContain('data-tick="2000"');
      expect(launchPage).toContain('<noscript><meta http-equiv="refresh" content="2"></noscript>');
    }
    const run = createRun("Compact form: the upload toggle hides attached files");
    const res = await fetch(`http://127.0.0.1:${ui.port}${started.location}`, {
      redirect: "manual",
      headers: { cookie: `jarvis_ui_${ui.port}=${encodeURIComponent(ui.token)}` },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/runs/${run.id.replace(/^run_/, "").slice(0, 8)}`);
  });

  const serve = async () => {
    ui = await startUiServer({
      runtime: rt,
      engine: createEngine(rt),
      port: 0,
      homeDir: sb.home,
      projectRoot: sb.project,
      pollMs: 30,
      actor: async () => DEV,
      launcher,
    });
    return ui.token;
  };
  /** A run a terminal started: it stopped on its agent's tool calls, the card there was left (`q`). */
  const leftAtBudget = (pid: number) => {
    const run = createRun("Order form: phone number mask");
    rt.runs.update(run.id, { currentStep: "implementation", currentIteration: 1 });
    rt.runs.transition(run.id, "RUNNING");
    rt.checkpoints.save({
      runId: run.id,
      stepId: "implementation",
      iteration: 1,
      kind: "suspend",
      state: { budget: { scope: "agent", dimension: "toolCalls", used: 50, cap: 50, agent: "research" } },
    });
    rt.runs.transition(run.id, "WAITING_HUMAN", {
      reason: "research used its 50 tool calls",
      waitingFor: { kind: "budget", detail: "agent toolCalls" },
    });
    rt.events.emit({ kind: "run.state", runId: run.id, payload: { state: "WAITING_HUMAN" } });
    const card = { kind: "budget", pid, host: hostname() };
    rt.events.emit({ kind: "card.open", runId: run.id, payload: card });
    return { run, short: run.id.replace(/^run_/, "").slice(0, 8), card };
  };

  it("more granted here for a run a terminal started and left: the page goes on with it", async () => {
    const token = await serve();
    const { run, short, card } = leftAtBudget(process.pid);
    rt.events.emit({ kind: "card.closed", runId: run.id, payload: card });
    const res = await post(`/runs/${short}/budget`, { t: token, choice: "more", amount: "25" });
    expect(res.location).toBe(`/runs/${short}`);
    expect((await calls(1))[0]).toBe(`${sb.project}|off|resume ${run.id}`);
    expect(launcher.drives(run.id)).toBe(true);
    expect(rt.events.list({ runId: run.id, kind: "run.driver" })[0]?.payload).toMatchObject({
      adopted: true,
    });
  });

  it("a terminal still waits at the card: it goes on there, the page starts nothing", async () => {
    const token = await serve();
    const { run, short } = leftAtBudget(process.pid); // this process: alive
    await post(`/runs/${short}/budget`, { t: token, choice: "more", amount: "25" });
    expect(rt.events.list({ runId: run.id, kind: "budget.grant" })).toHaveLength(1);
    expect(launcher.drives(run.id)).toBe(false);
    const html = await page(`/runs/${short}`);
    expect(html).toContain("The terminal waiting at the card goes on with it.");
    expect(html).not.toContain(`action="/runs/${short}/resume"`);
    expect((await post(`/runs/${short}/resume`, { t: token })).location).toBe(
      `/runs/${short}?notice=not-waiting`,
    );
  });

  it("Resume: a decision nobody went on with, a run stopped with Ctrl-C or left without its process", async () => {
    const token = await serve();
    // decided in a terminal that then closed: Resume on the run's page and in Waits for you
    const { run, short, card } = leftAtBudget(process.pid);
    rt.events.emit({
      kind: "budget.grant",
      runId: run.id,
      stepId: "implementation",
      iteration: 1,
      payload: { scope: "agent", dimension: "toolCalls", toolCalls: 25, channel: "cli" },
    });
    rt.events.emit({ kind: "card.closed", runId: run.id, payload: card });
    expect(resumableOf(rt, rt.runs.get(run.id) ?? run)).toBe("decided");
    expect(await page(`/runs/${short}`)).toContain(`action="/runs/${short}/resume"`);
    expect(await page("/")).toContain(`action="/runs/${short}/resume"`);
    const res = await post(`/runs/${short}/resume`, { t: token });
    expect(res.location).toBe(`/runs/${short}?notice=resumed`);
    expect((await calls(1))[0]).toBe(`${sb.project}|off|resume ${run.id}`);

    const stopped = createRun("Billing: rounding in invoice totals");
    rt.runs.transition(stopped.id, "RUNNING");
    expect(resumableOf(rt, rt.runs.get(stopped.id) ?? stopped)).toBe("interrupted");
    rt.runs.transition(stopped.id, "SUSPENDED", { reason: "interrupted with Ctrl-C" });
    const short2 = stopped.id.replace(/^run_/, "").slice(0, 8);
    const html = await page(`/runs/${short2}`);
    expect(html).toContain("stopped with Ctrl-C");
    expect(html).toContain(`action="/runs/${short2}/resume"`);
  });

  it("nothing to resume: undecided, failed, ended", () => {
    const { run, card } = leftAtBudget(process.pid);
    rt.events.emit({ kind: "card.closed", runId: run.id, payload: card });
    expect(resumableOf(rt, rt.runs.get(run.id) ?? run)).toBeUndefined(); // no decision yet
    const failed = createRun("Billing: rounding in invoice totals");
    rt.runs.transition(failed.id, "RUNNING");
    rt.runs.transition(failed.id, "FAILED", { reason: "boom" });
    expect(resumableOf(rt, rt.runs.get(failed.id) ?? failed)).toBeUndefined();
  });

  /** A research of ABC-42 that has ended: sdd can go on from it. */
  const finishedResearch = () => {
    const run = rt.runs.create({
      task: "ABC-42: Delivery slots on the order form",
      workflow: "research",
      owner: DEV,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
    });
    for (const stepId of ["discover", "sources", "research"]) {
      rt.events.emit({ kind: "step.start", runId: run.id, stepId, payload: { stepId, iteration: 1 } });
      if (stepId === "research")
        rt.events.emit({ kind: "agent.finish", runId: run.id, stepId, payload: { contradictions: 7 } });
      rt.events.emit({ kind: "step.finish", runId: run.id, stepId, payload: { stepId, status: "success" } });
    }
    rt.runs.update(run.id, { currentStep: "research", currentIteration: 1 });
    rt.runs.transition(run.id, "RUNNING");
    rt.runs.transition(run.id, "COMPLETED");
    return { run, short: run.id.replace(/^run_/, "").slice(0, 8) };
  };

  it("Continue to sdd on a finished research: `jarvis continue` in the background, once", async () => {
    const token = await serve();
    const { run, short } = finishedResearch();
    const before = await page(`/runs/${short}`);
    expect(before).toContain("Take it into the full cycle");
    expect(before).toContain(`action="/runs/${short}/continue"`);
    expect(before).toContain("7 contradictions");
    const first = await post(`/runs/${short}/continue`, { t: token });
    expect(first.location).toMatch(/^\/launches\/[0-9a-f]{12}$/);
    expect((await calls(1))[0]).toBe(`${sb.project}|off|continue ${run.id}`);
    // a second click while the first prepares its checkout joins it
    expect((await post(`/runs/${short}/continue`, { t: token })).location).toBe(first.location);
    // the CLI made the sdd run from it: the research says where it went on, the new run where it came from
    const to = rt.runs.create({
      task: run.task,
      workflow: "sdd",
      owner: DEV,
      workspace: run.workspace,
      dataClass: "internal",
    });
    rt.events.emit({ kind: "run.created", runId: to.id, payload: { continuedFrom: run.id } });
    launcher.tend();
    expect(launcher.list()[0]?.runId).toBe(to.id);
    const after = await page(`/runs/${short}`);
    expect(after).toContain("→ continued in sdd");
    expect(after).not.toContain("Take it into the full cycle");
    const toShort = to.id.replace(/^run_/, "").slice(0, 8);
    const toPage = await page(`/runs/${toShort}`);
    expect(toPage).toContain(
      `continued from <a href="/runs/${short}">research ${short}</a> · 7 contradictions carried over`,
    );
    // the steps the research did are done here too, said where (pilot: they stood pending)
    expect(toPage).toContain(
      `<b>research<span class="sr"> — done</span></b><span class="note">done in research ${short}`,
    );
    expect(toPage).toContain('<li class="step pending">');
    // gone on already: the button's address leads to that run
    expect((await post(`/runs/${short}/continue`, { t: token })).location).toBe(`/runs/${toShort}`);
  });

  it("New task with sdd offers the research of the same issue to start from", async () => {
    const token = await serve();
    const { run } = finishedResearch();
    const from = (q: Record<string, string>) =>
      page(`/runs/from?${new URLSearchParams({ repo: sb.project, ...q })}`);
    expect(await page("/")).toContain("data-from");
    const offered = await from({ task: "ABC-42", workflow: "sdd" });
    expect(offered).toContain(`name="from" value="${run.id}" checked`);
    expect(offered).toContain("Start from the research of");
    // no base commit to compare with: said, not guessed
    expect(offered).toContain("tell whether the code changed since");
    expect(await from({ task: "ABC-43", workflow: "sdd" })).toContain("No finished research of ABC-43");
    expect(await from({ task: "ABC-42", workflow: "research" })).toBe("");
    expect(await from({ task: "ABC-42", workflow: "sdd", repo: "/etc" })).toBe("");
    // Start with the box ticked: the research goes on
    const started = await post("/runs/new", {
      t: token,
      task: "ABC-42",
      workflow: "sdd",
      repo: sb.project,
      from: run.id,
    });
    expect(started.location).toMatch(/^\/launches\/[0-9a-f]{12}$/);
    expect((await calls(1))[0]).toBe(`${sb.project}|off|continue ${run.id}`);
    // a research that can't go on as fix
    expect(
      (await post("/runs/new", { t: token, task: "ABC-42", workflow: "fix", repo: sb.project, from: run.id }))
        .location,
    ).toContain("notice=cannot-continue");
  });

  it("a clarification is answered on the page: an answer, then a rule, and the run goes on", async () => {
    const token = await serve();
    const run = createRun("ABC-42: Delivery slots on the order form");
    rt.runs.update(run.id, { currentStep: "requirements", currentIteration: 1 });
    rt.runs.transition(run.id, "RUNNING");
    const thread = rt.interactions.open({
      runId: run.id,
      kind: "clarification",
      stepId: "requirements",
      iteration: 1,
      origin: "requirements",
      openedBy: "agent:requirements",
      message: {
        role: "jarvis",
        actor: "requirements",
        text: "Can a customer pick a slot for today after 18:00?",
      },
    });
    rt.runs.transition(run.id, "WAITING_HUMAN", {
      reason: `clarification needed by requirements: ${thread.id}`,
      waitingFor: { kind: "clarification", interactionId: thread.id },
    });
    rt.events.emit({ kind: "run.driver", runId: run.id, payload: { by: "ui" } });
    const short = run.id.replace(/^run_/, "").slice(0, 8);
    const card = await page(`/runs/${short}`);
    expect(card).toContain("requirements asks before going on");
    expect(card).toContain("Can a customer pick a slot for today after 18:00?");
    expect(card).toContain(`action="/runs/${short}/clarify" class="clarify"`);
    expect(card).not.toContain("Answer in the terminal");
    // on the list of runs: what it asks, and where to answer
    expect(await page("/")).toContain("⏸ clarification · requirements");
    // an empty answer, accepting before any proposal: nothing recorded
    expect((await post(`/runs/${short}/clarify`, { t: token, move: "say", text: " " })).location).toContain(
      "notice=no-answer",
    );
    expect((await post(`/runs/${short}/clarify`, { t: token, move: "accept" })).location).toContain(
      "notice=no-rule",
    );
    // an answer: on the thread at once; Jarvis's turn comes in the background (no model here: said so)
    await post(`/runs/${short}/clarify`, { t: token, move: "say", text: "Only until 20:00, same day." });
    expect(
      rt.interactions
        .messages(thread.id)
        .slice(0, 2)
        .map((m) => m.role),
    ).toEqual(["jarvis", "human"]);
    for (let i = 0; i < 100 && rt.interactions.messages(thread.id).length < 3; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(rt.interactions.messages(thread.id).at(-1)?.text).toMatch(/^⚠ No answer from the model/);
    // Jarvis proposes a rule: shown, with the button to accept it
    rt.interactions.say(thread.id, {
      role: "jarvis",
      actor: "clarifier",
      text: "So a same-day slot closes at 20:00.",
      proposal: { rule: "Same-day slots until 20:00", requirementCorrections: ["R3"], assumptions: [] },
    });
    const proposed = await page(`/runs/${short}`);
    expect(proposed).toContain("<b>Same-day slots until 20:00</b>");
    expect(proposed).toContain('value="accept" class="btn primary"');
    // a rule of one's own instead: recorded, the run goes on in the background
    const done = await post(`/runs/${short}/clarify`, {
      t: token,
      move: "rule",
      rule: "A same-day slot can be picked until 20:00",
    });
    expect(done.location).toBe(`/runs/${short}?notice=clarified`);
    const doc = JSON.parse(rt.artifacts.text(rt.artifacts.listLatest(run.id, "clarification")[0] as never));
    expect(doc.rule).toBe("A same-day slot can be picked until 20:00");
    expect(doc.answers).toEqual(["Only until 20:00, same day."]);
    expect(rt.runs.get(run.id)?.waitingFor).toBeUndefined();
    expect((await calls(1))[0]).toBe(`${sb.project}|off|resume ${run.id}`);
  });

  it("Cancel pressed on a run a process drives: the page says it is cancelling until it stops", async () => {
    await serve();
    const run = createRun("Order form: phone number mask");
    rt.runs.transition(run.id, "RUNNING");
    rt.runs.acquireLease(run.id, "cli:elsewhere", 90_000);
    const short = run.id.replace(/^run_/, "").slice(0, 8);
    expect(await page(`/runs/${short}`)).toContain("Cancel run…");
    rt.runs.requestCancel(run.id);
    const cancelling = await page(`/runs/${short}`);
    expect(cancelling).toContain(
      '<span class="pill bad"><span class="spin" aria-hidden="true"></span> CANCELLING</span>',
    );
    expect(cancelling).toContain("Cancelling — the run stops after its current model or tool call");
    expect(cancelling).toContain('aria-disabled="true">Cancelling…</span>');
    expect(cancelling).not.toContain("Cancel run…");
  });

  it("a clarification settled in an earlier run of the same task is offered again: one click", async () => {
    const token = await serve();
    const before = createRun("ABC-42: Delivery slots on the order form");
    rt.artifacts.put({
      runId: before.id,
      type: "clarification",
      name: "int_before.json",
      content: JSON.stringify({
        question: "Which value means a courier zone?",
        rule: "Only zone ids from logistics-api",
      }),
      provenance: { kind: "human", actor: DEV },
    });
    // another task's rule is not offered
    rt.artifacts.put({
      runId: createRun("ABC-77: Billing").id,
      type: "clarification",
      name: "int_other.json",
      content: JSON.stringify({ question: "Rounding?", rule: "Round half up" }),
      provenance: { kind: "human", actor: DEV },
    });
    const run = createRun("ABC-42");
    rt.runs.update(run.id, { currentStep: "requirements", currentIteration: 1 });
    rt.runs.transition(run.id, "RUNNING");
    const thread = rt.interactions.open({
      runId: run.id,
      kind: "clarification",
      stepId: "requirements",
      iteration: 1,
      openedBy: "agent:requirements",
      message: { role: "jarvis", actor: "requirements", text: "Which value means a courier zone?" },
    });
    rt.runs.transition(run.id, "WAITING_HUMAN", {
      reason: "clarification",
      waitingFor: { kind: "clarification", interactionId: thread.id },
    });
    const short = run.id.replace(/^run_/, "").slice(0, 8);
    const card = await page(`/runs/${short}`);
    expect(card).toContain("Decided before for this task");
    expect(card).toContain("<b>Only zone ids from logistics-api</b>");
    expect(card).not.toContain("Round half up");
    const done = await post(`/runs/${short}/clarify`, { t: token, move: "earlier-0" });
    expect(done.location).toBe(`/runs/${short}?notice=clarified`);
    const doc = JSON.parse(rt.artifacts.text(rt.artifacts.listLatest(run.id, "clarification")[0] as never));
    expect(doc.rule).toBe("Only zone ids from logistics-api");
    expect(rt.runs.get(run.id)?.waitingFor).toBeUndefined();
  });

  it("an implementation shows its place in the plan: one line folded, the panel on a click", async () => {
    await serve();
    const run = createRun("ABC-42: Delivery slots on the order form");
    rt.runs.update(run.id, { currentStep: "implementation", currentIteration: 1 });
    rt.runs.transition(run.id, "RUNNING");
    rt.runs.acquireLease(run.id, "cli:elsewhere", 90_000);
    rt.artifacts.put({
      runId: run.id,
      type: "plan",
      name: "plan.json",
      content: JSON.stringify({
        summary: "s",
        steps: [
          { id: "1", description: "Types for the slots", files: ["src/slots.types.ts"], verification: "tsc" },
          {
            id: "2",
            description: "Fetch the slots in the saga",
            files: ["src/saga.ts"],
            verification: "saga test",
          },
          { id: "3", description: "Slot picker", files: [], verification: "picker test" },
        ],
      }),
      provenance: { kind: "agent", agentId: "plan" },
    });
    const at = { runId: run.id, stepId: "implementation" };
    rt.events.emit({ kind: "step.start", ...at, payload: { stepId: "implementation", iteration: 1 } });
    rt.events.emit({ kind: "agent.start", ...at, payload: { agent: "implementation" } });
    for (const [capability, args] of [
      ["plan.step", { step: "1", status: "start" }],
      ["repo.write", { path: "src/slots.types.ts", content: "x" }],
      ["plan.step", { step: "2", status: "start" }],
    ] as const)
      rt.events.emit({
        kind: "tool.call",
        ...at,
        payload: { capability, ok: true, args: JSON.stringify(args) },
      });
    const short = run.id.replace(/^run_/, "").slice(0, 8);
    const body = await page(`/runs/${short}`);
    expect(body).toContain('<details class="planw" data-keep="plan">');
    expect(body).toContain(
      '<span class="of">Plan 2 of 3</span><span class="d">Fetch the slots in the saga</span>',
    );
    expect(body).toContain("<code>src/saga.ts</code>");
    expect(body).toContain("running now · plan 2 of 3");
    expect(await page("/")).toContain('<b class="planat">plan 2 of 3</b> Fetch the slots in the saga');
  });

  it("a run done with its implementation accepted becomes an eval case from its page", async () => {
    const token = await serve();
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: sb.project,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      }).trim();
    git("init", "-q");
    sb.write("project/src/slots.ts", "export const slots = [];\n");
    git("add", "src");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const run = rt.runs.create({
      task: "ABC-42: Delivery slots on the order form",
      workflow: "sdd",
      owner: DEV,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD", baseCommit: base },
      dataClass: "internal",
    });
    const spec = rt.artifacts.put({
      runId: run.id,
      type: "spec",
      name: "spec.json",
      content: JSON.stringify({
        title: "Slots",
        requirements: [{ id: "R1", text: "Slots", acceptance: ["3 days shown"] }],
      }),
      provenance: { kind: "agent", agentId: "specification" },
    });
    recordGiven(rt, spec, [{ question: "Keep the checkbox?", mode: "answer", text: "Remove it" }], DEV.id);
    const impl = rt.artifacts.put({
      runId: run.id,
      type: "implementation",
      name: "implementation.json",
      content: JSON.stringify({ summary: "done", changedFiles: ["src/slots.ts"] }),
      provenance: { kind: "agent", agentId: "implementation" },
    });
    rt.artifacts.approve({
      runId: run.id,
      stepId: "approve-impl",
      artifactId: impl.artifactId,
      version: 1,
      actor: DEV,
      decision: "approve",
    });
    sb.write("project/src/slots.ts", "export const slots = ['9-12'];\n");
    rt.runs.transition(run.id, "RUNNING");
    rt.runs.transition(run.id, "COMPLETED");
    const short = run.id.replace(/^run_/, "").slice(0, 8);
    expect(await page(`/runs/${short}`)).toContain("Make an eval case");
    expect((await post(`/runs/${short}/eval`, { t: token, suite: "Bad Suite" })).location).toContain(
      "notice=eval-suite",
    );
    expect((await post(`/runs/${short}/eval`, { t: token, suite: "pilot" })).location).toBe(
      `/runs/${short}?notice=eval-made`,
    );
    const dir = join(sb.project, "evals", "pilot", "abc-42-delivery-slots-on-the-order-form");
    const yaml = readFileSync(join(dir, "case.yaml"), "utf8");
    expect(yaml).toContain("src/slots.ts");
    expect(yaml).toContain("3 days shown");
    expect(yaml).toContain("Remove it");
    // the project's configuration, not committed, goes into the fixture too
    expect(existsSync(join(dir, "fixture", ".jarvis", "project.yaml"))).toBe(true);
    const after = await page(`/runs/${short}`);
    expect(after).toContain("✓ eval case");
    expect(after).toContain("jarvis evals run --suite pilot --mode record");
  });

  it("a step on its second round says what it fixes; a note goes to the running step", async () => {
    const token = await serve();
    const run = createRun("ABC-42: Delivery slots on the order form");
    rt.runs.update(run.id, { currentStep: "implementation", currentIteration: 2 });
    rt.runs.transition(run.id, "RUNNING");
    rt.runs.acquireLease(run.id, "cli:elsewhere", 90_000);
    const ev = (kind: string, stepId: string, payload: Record<string, unknown>) =>
      rt.events.emit({ kind, runId: run.id, stepId, payload });
    ev("step.start", "implementation", { stepId: "implementation", iteration: 1 });
    ev("step.finish", "implementation", { stepId: "implementation", iteration: 1, status: "success" });
    ev("step.finish", "tests", {
      stepId: "tests",
      status: "success",
      outcome: "defects_found",
      reason: "missing route for the courier app",
    });
    ev("step.finish", "checks", {
      stepId: "checks",
      status: "success",
      outcome: "defects_found",
      reason: "test-courier failed",
    });
    ev("workflow.loop", "verify", { edge: "verify->implementation#defects_found", iteration: 1, max: 2 });
    ev("step.start", "implementation", { stepId: "implementation", iteration: 2 });
    ev("agent.start", "implementation", { agent: "implementation" });
    const short = run.id.replace(/^run_/, "").slice(0, 8);
    const body = await page(`/runs/${short}`);
    expect(body).toContain(
      '<span class="of">Round 2 of 3</span><span class="d">Fixing 2 defects verify found</span>',
    );
    expect(body).toContain("missing route for the courier app");
    expect(body).toContain("✎ Add a note for implementation");
    expect((await post(`/runs/${short}/note`, { t: token, text: " " })).location).toContain("notice=no-note");
    expect(
      (await post(`/runs/${short}/note`, { t: token, text: "The method serves the courier app too" }))
        .location,
    ).toContain("notice=noted");
    const after = await page(`/runs/${short}`);
    expect(after).toContain("◌ goes with its next model call");
    expect(after).toContain("The method serves the courier app too");
    expect(rt.events.list({ runId: run.id, kind: "human.note" })[0]?.stepId).toBe("implementation");
  });

  it("a round sent back at the review gate shows who sent it and the comment, open", async () => {
    await serve();
    const run = createRun("ABC-42: Delivery slots on the order form");
    rt.runs.update(run.id, { currentStep: "implementation", currentIteration: 2 });
    rt.runs.transition(run.id, "RUNNING");
    rt.runs.acquireLease(run.id, "cli:elsewhere", 90_000);
    const impl = rt.artifacts.put({
      runId: run.id,
      type: "implementation",
      name: "implementation.json",
      content: "{}",
      provenance: { kind: "agent", agentId: "implementation" },
    });
    const ev = (kind: string, stepId: string, payload: Record<string, unknown>, actor?: string) =>
      rt.events.emit({ kind, runId: run.id, stepId, payload, ...(actor ? { actor } : {}) });
    ev("step.start", "implementation", { stepId: "implementation", iteration: 1 });
    ev("step.finish", "implementation", { stepId: "implementation", iteration: 1, status: "success" });
    rt.artifacts.approve({
      runId: run.id,
      stepId: "approve-impl",
      artifactId: impl.artifactId,
      version: impl.version,
      actor: DEV,
      decision: "request_changes",
      comment: "The slot picker: onClose comes from its parent.\nMake it optional.",
    });
    ev(
      "approval.recorded",
      "approve-impl",
      {
        artifactId: impl.artifactId,
        version: impl.version,
        type: "implementation",
        decision: "request_changes",
        channel: "ui",
      },
      "user:dev@example.com",
    );
    ev("step.finish", "approve-impl", {
      stepId: "approve-impl",
      status: "success",
      outcome: "request_changes",
    });
    ev("workflow.loop", "approve-impl", {
      edge: "approve-impl->implementation#request_changes",
      iteration: 1,
      max: 3,
    });
    ev("step.start", "implementation", { stepId: "implementation", iteration: 2 });
    ev("agent.start", "implementation", { agent: "implementation" });
    const short = run.id.replace(/^run_/, "").slice(0, 8);
    const body = await page(`/runs/${short}`);
    expect(body).toContain('<details class="planw fixw" data-keep="fixing" open>');
    expect(body).toContain(
      'Fixing what dev@example.com sent back at approve-impl: <span class="muted">The slot picker: onClose comes from its parent.</span>',
    );
    expect(body).toContain("sent back implementation@1 by dev@example.com in the browser");
    expect(body).toContain("Make it optional.");
  });
});

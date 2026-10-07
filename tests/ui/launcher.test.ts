import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../../src/app/engine.ts";
import { resumableOf } from "../../src/app/resumable.ts";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import { loadConfig } from "../../src/core/config/load.ts";
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
    expect(runs).toContain('<option value="fix" selected>fix — a short way for a bug');
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
});

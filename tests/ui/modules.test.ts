import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../../src/app/engine.ts";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { MODULE_MARKER } from "../../src/onboarding/render.ts";
import type { Launch, Launcher } from "../../src/ui/launcher.ts";
import { startUiServer, type UiServer } from "../../src/ui/server.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** Knowledge → Modules: research a folder from the page, review its candidate, commit the draft. */
let sb: Sandbox;
let rt: Runtime;
let ui: UiServer;
const DEV = { kind: "user" as const, id: "dev@example.com", verified: false };
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const started: Array<{ module: string; note?: string }> = [];
const adopted: string[] = [];

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: sb.project, encoding: "utf8", env: { ...process.env, ...gitEnv } });

/** A launcher that only notes what the page asked for. */
function stubLauncher(): Launcher {
  const launches: Launch[] = [];
  return {
    start: () => {
      throw new Error("not here");
    },
    startModule(input) {
      started.push({ module: input.module, ...(input.note ? { note: input.note } : {}) });
      const l: Launch = {
        id: `l${launches.length}`,
        task: `module ${input.module}`,
        workflow: "onboard-module",
        module: input.module,
        repoRoot: input.repoRoot,
        startedAt: new Date().toISOString(),
        log: "/dev/null",
        exitCode: null,
        queued: launches.some((x) => !x.queued),
      };
      launches.unshift(l);
      return l;
    },
    unqueue: (id) => {
      const at = launches.findIndex((l) => l.id === id && l.queued);
      if (at >= 0) launches.splice(at, 1);
      return at >= 0;
    },
    list: () => launches,
    get: (id) => launches.find((l) => l.id === id),
    drives: () => false,
    resume: () => false,
    adopt: (run) => {
      adopted.push(run.id);
      return true;
    },
    tend: () => {},
    tail: () => "",
  };
}

beforeEach(async () => {
  sb = sandbox();
  started.length = 0;
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  sb.write("project/src/orders/order.ts", "export class Order {}\n");
  sb.write("project/src/orders/form/step.ts", "export const step = 1;\n");
  git("init", "-q", "-b", "main");
  // the page commits as the repository's git config says, like a commit made by hand
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
  rt = createRuntime(loaded, { env: {} });
  ui = await startUiServer({
    runtime: rt,
    engine: createEngine(rt),
    port: 0,
    homeDir: sb.home,
    projectRoot: sb.project,
    pollMs: 30,
    mcpCheckEveryMs: 0,
    actor: async () => DEV,
    launcher: stubLauncher(),
    open: () => "VS Code",
  });
});
afterEach(async () => {
  await ui.close();
  await rt.close();
  sb.cleanup();
});

const cookie = () => `jarvis_ui_${ui.port}=${encodeURIComponent(ui.token)}`;
const page = async (path: string) =>
  (await fetch(`http://127.0.0.1:${ui.port}${path}`, { headers: { cookie: cookie() } })).text();
function post(path: string, fields: Array<[string, string]>): Promise<{ status: number; location?: string }> {
  const body = new URLSearchParams([["t", ui.token], ...fields]).toString();
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
          cookie: cookie(),
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
}

/** A finished research of src/orders whose candidate waits (what the `verify` step leaves). */
function researched(review: string[] = ["Every order is priced before tax."]) {
  const run = rt.runs.create({
    task: "Map the module `src/orders` of this repository for onboarding.",
    workflow: "onboard-module",
    owner: DEV,
    workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
    dataClass: "internal",
  });
  const put = (type: string, name: string, doc: unknown) =>
    rt.artifacts.put({
      runId: run.id,
      type,
      name,
      content: JSON.stringify(doc),
      mediaType: "application/json",
      provenance: { kind: "tool", capability: "onboard.verify" },
      stepId: "verify",
      iteration: 1,
    });
  put("module-input", "module.json", { module: "src/orders" });
  const candidate = put("candidate", "onboard-src-orders.json", {
    kind: "knowledge",
    title: "module src/orders",
    module: "src/orders",
    claims: { proposed: 4, kept: 3, dropped: 1 },
    review,
    dropped: [{ section: "publicApi", what: "Ghost", why: "not found in src/orders/order.ts" }],
    rationale: "Mapped by the onboarding agent; 3 of 4 claims were confirmed against the code, 1 dropped.",
    proposal: `---\ntags: [module, generated]\npaths: ["src/orders/**"]\n---\n${MODULE_MARKER}\n# Module src/orders\n\nHolds the order aggregate.\n`,
    paths: ["src/orders/**"],
    status: "proposed",
  });
  rt.runs.transition(run.id, "RUNNING");
  rt.runs.transition(run.id, "COMPLETED");
  return { run, candidate };
}

describe("Knowledge → Modules", () => {
  it("shows the tree and the path's suggestions; a folder starts its research with the note", async () => {
    const body = await page("/knowledge/modules?path=src/orders");
    expect(body).toContain('aria-current="page">Knowledge</a>');
    expect(body).toContain('<option value="src/orders/form">');
    expect(body).toContain("Start research");
    expect(body).toContain("jarvis onboard --module src/orders");

    const r = await post("/knowledge/modules/research", [
      ["path", "src/orders"],
      ["note", "how totals are rounded"],
    ]);
    expect(r.location).toBe("/knowledge/modules?path=src%2Forders&notice=started");
    expect(started).toEqual([{ module: "src/orders", note: "how totals are rounded" }]);
    expect(await page("/knowledge/modules?path=src/orders")).toContain("starting…");
    // a second one waits in the queue
    const q = await post("/knowledge/modules/research", [["path", "src/orders/form"]]);
    expect(q.location).toContain("notice=queued");
    expect(await page("/knowledge/modules?path=src/orders/form")).toContain("Queued — next");
  });

  it("refuses a path that is not a folder of a module", async () => {
    const r = await post("/knowledge/modules/research", [["path", "../etc"]]);
    expect(r.location).toContain("notice=no-path");
    expect(started).toEqual([]);
  });

  it("a candidate: what was dropped, what to check first; Accept needs every tick and writes a draft", async () => {
    const { candidate } = researched();
    const body = await page("/knowledge/modules?path=src/orders");
    expect(body).toContain("candidate waits");
    expect(body).toContain("Every order is priced before tax.");
    expect(body).toContain("<s>Ghost</s>");
    expect(body).toContain("Accept as a draft");
    expect(body).not.toContain("jarvis:onboard-module"); // the marker is not shown as text

    const at = `/knowledge/candidates/${candidate.artifactId}/accept`;
    expect((await post(at, [])).location).toContain("notice=check-all");
    const ok = await post(at, [["checked", "0"]]);
    expect(ok.location).toContain("notice=accepted");
    const file = join(sb.project, ".jarvis/knowledge/module-orders.md");
    expect(readFileSync(file, "utf8")).toContain("# Module src/orders");
    const after = await page("/knowledge/modules?path=src/orders");
    expect(after).toContain("draft");
    expect(after).toContain("1 knowledge file not committed");
    expect(rt.artifacts.approvalsFor(candidate.artifactId)[0]?.comment).toContain(
      "1 of 1 generalisations checked",
    );

    // Commit knowledge: one commit of the drafts, the repository's author
    const c = await post("/knowledge/commit", [["path", "src/orders"]]);
    expect(c.location).toContain("notice=committed");
    expect(git("log", "-1", "--format=%s %ae")).toContain("knowledge: module-orders t@t");
  });

  it("a document a person wrote at the target is replaced only on Replace (with the diff shown)", async () => {
    sb.write("project/.jarvis/knowledge/module-orders.md", "# Orders\n\nWritten by the team.\n");
    const { candidate } = researched([]);
    const body = await page("/knowledge/modules?path=src/orders");
    expect(body).toContain("Replace it");
    expect(body).toContain("What replacing");
    const at = `/knowledge/candidates/${candidate.artifactId}/accept`;
    expect((await post(at, [])).location).toContain("notice=taken");
    expect(readFileSync(join(sb.project, ".jarvis/knowledge/module-orders.md"), "utf8")).toContain(
      "Written by the team.",
    );
    expect((await post(at, [["replace", "1"]])).location).toContain("notice=accepted");
    expect(readFileSync(join(sb.project, ".jarvis/knowledge/module-orders.md"), "utf8")).toContain(
      "# Module src/orders",
    );
  });

  it("Research again: the candidate is discarded and a new research starts with the note and what was dropped", async () => {
    const { candidate } = researched();
    const r = await post(`/knowledge/candidates/${candidate.artifactId}/reject`, [
      ["comment", "Say how totals are rounded"],
      ["again", "1"],
    ]);
    expect(r.location).toContain("notice=again");
    expect(started[0]?.module).toBe("src/orders");
    expect(started[0]?.note).toContain("Say how totals are rounded");
    expect(started[0]?.note).toContain('publicApi "Ghost"');
    expect(rt.artifacts.approvalsFor(candidate.artifactId)[0]?.decision).toBe("reject");
    expect(existsSync(join(sb.project, ".jarvis/knowledge/module-orders.md"))).toBe(false);
  });

  it("a waiting candidate rings the bell and waits under Runs, with a link to its folder", async () => {
    researched();
    const runs = await page("/");
    expect(runs).toContain("1 waits for you");
    expect(runs).toContain("Review what the research found: <code>src/orders</code>");
    expect(runs).toContain('href="/knowledge/modules?path=src%2Forders">Review the module');
    // the header leads to Knowledge from every page, a run's too
    expect(runs).toContain('<a href="/knowledge">Knowledge</a>');
    const w = JSON.parse(await page("/waiting.json")) as { waiting: Array<{ href?: string; what: string }> };
    expect(w.waiting).toContainEqual(
      expect.objectContaining({
        href: "/knowledge/modules?path=src%2Forders",
        what: "review what the research found",
      }),
    );
  });

  it("a research parked on the quota window: paused, not failed — when it goes on, and Resume now", async () => {
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
    rt.runs.update(run.id, { currentStep: "map", currentIteration: 1 });
    rt.runs.transition(run.id, "RUNNING");
    const reason =
      'model flash: budget admission denied for pool "corp": output tokens: 14155 used of 30000 in window, need 16000';
    rt.events.emit({
      kind: "model.error",
      runId: run.id,
      stepId: "map",
      payload: { modelId: "flash", kind: "quota_exhausted", message: reason },
    });
    rt.runs.transition(run.id, "WAITING_BUDGET", { reason });
    rt.checkpoints.save({
      runId: run.id,
      stepId: "map",
      iteration: 1,
      kind: "suspend",
      state: { resumeAfter: new Date(Date.now() + 7 * 60_000).toISOString() },
    });
    const mod = await page("/knowledge/modules?path=src/orders");
    expect(mod).toContain("waits for quota");
    expect(mod).toContain("Paused, not failed");
    expect(mod).toContain("output tokens: 14155 used of 30000 in window");
    const short = run.id.replace(/^run_/, "").slice(0, 8);
    const runPage = await page(`/runs/${short}`);
    expect(runPage).toContain("paused, not failed");
    expect(runPage).toContain("paused · waits for the quota window"); // the step, not "waits for you"
    expect(runPage).toContain('class="btn small danger">Cancel run…');
    expect(runPage).toContain("Waits for the quota window of pool <code>corp</code>");
    expect(runPage).toContain("the run waits"); // the feed says it waits, not "gave up"
    expect(runPage).not.toContain("gave up");
    const runs = await page("/");
    expect(runs).toContain("waits for the quota window of corp");
    const r = await post(`/runs/${short}/resume`, [["back", "/knowledge/modules?path=src%2Forders"]]);
    expect(r.location).toBe("/knowledge/modules?path=src%2Forders&notice=resumed");
    expect(adopted).toEqual([run.id]);
  });

  it("Cancel on a run's page: at once when nothing runs it, at the next safe point when something does", async () => {
    const mk = () =>
      rt.runs.create({
        task: "Map the module `src/orders` of this repository for onboarding.",
        workflow: "onboard-module",
        owner: DEV,
        workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
        dataClass: "internal",
      });
    const idle = mk();
    rt.runs.transition(idle.id, "RUNNING");
    rt.runs.transition(idle.id, "WAITING_BUDGET", { reason: "quota" });
    const short = (id: string) => id.replace(/^run_/, "").slice(0, 8);
    expect(await page(`/runs/${short(idle.id)}`)).toContain("Cancel run…");
    expect((await post(`/runs/${short(idle.id)}/cancel`, [])).location).toContain("notice=cancelled");
    expect(rt.runs.get(idle.id)?.state).toBe("CANCELLED");
    expect(await page(`/runs/${short(idle.id)}`)).not.toContain("Cancel run…");
    expect((await post(`/runs/${short(idle.id)}/cancel`, [])).location).toContain("notice=already-ended");

    const busy = mk();
    rt.runs.acquireLease(busy.id, "cli:elsewhere", 60_000);
    rt.runs.transition(busy.id, "RUNNING");
    expect((await post(`/runs/${short(busy.id)}/cancel`, [])).location).toContain("notice=cancel-requested");
    expect(rt.runs.get(busy.id)).toMatchObject({ state: "RUNNING", cancelRequested: true });
  });
});

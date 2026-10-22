import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { recordDecision } from "../../src/app/decide.ts";
import {
  DeliveryError,
  deliverPr,
  linkOf,
  PR_REQUEST,
  pendingPrRequest,
  prOf,
  repositoryFromUrl,
} from "../../src/app/deliver.ts";
import { createEngine } from "../../src/app/engine.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { run as cli } from "../../src/cli/main.ts";
import { type Actor, DAEMON_ACTOR } from "../../src/core/domain/actor.ts";
import type { Run, RunOptions } from "../../src/core/domain/run.ts";
import { daemonTick } from "../../src/orchestration/daemon.ts";
import { WorktreeWorkspace, workspaceFactory } from "../../src/orchestration/worktree.ts";
import { newRunId, shortRunId } from "../../src/storage/runStore.ts";
import { actingAs, MemoryEventStore } from "../../src/telemetry/events.ts";
import type { Capability, ToolProvider } from "../../src/tools/types.ts";
import { inLang } from "../../src/ui/i18n.ts";
import { feedItem } from "../../src/ui/model.ts";
import { startUiServer, type UiServer } from "../../src/ui/server.ts";
import { PR_FIX_WORKFLOW } from "../../src/workflows/builtin.ts";
import { ACTOR, engineFor, testRuntime, workflowOf } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** ADR-0003 §4: a finished run delivered as a pull request; ADR-0006 §2–4: who did it, for whom. */
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const env = { PATH: process.env.PATH ?? "", HOME: "/nonexistent", ...gitEnv };

function sh(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
}

let sb: Sandbox;
let remote: string;
let rt: Runtime;

/** A Bitbucket that keeps its PRs in memory: what the profile's `bitbucket.pr.create` would reach. */
interface FakePr {
  readonly args: Record<string, unknown>;
  readonly marker?: string;
}
let prs: FakePr[];
let failNext: boolean;

function fakeBitbucket(): ToolProvider {
  const create: Capability = {
    name: "bitbucket.pr.create",
    description: "open a PR",
    network: "intranet",
    access: "write",
    effect: true,
    server: "bitbucket",
    parameters: { type: "object" },
    async handler(args, ctx) {
      if (failNext) {
        failNext = false;
        return { ok: false, error: "500 from the server" };
      }
      prs.push({ args, ...(ctx.effect ? { marker: ctx.effect.marker } : {}) });
      const id = prs.length;
      return {
        ok: true,
        text: JSON.stringify({
          id,
          links: { html: { href: `https://bitbucket.example/acme/orders-api/pull-requests/${id}` } },
        }),
      };
    },
    async verify(_args, _record, ctx) {
      return prs.some((p) => p.marker === ctx.effect?.marker) ? { ok: true, text: "{}" } : "not-found";
    },
  };
  return { name: "fake-bitbucket", capabilities: () => [create] };
}

async function setup(projectYaml = "", userYaml = ""): Promise<void> {
  sb.write("home/.jarvis/config.yaml", `version: 1\nactor: { id: me@corp }\n${userYaml}`);
  sb.write("project/.jarvis/project.yaml", `version: 1\n${projectYaml}`);
  rt = await testRuntime(sb, env);
  rt.registry.register(fakeBitbucket());
}

beforeEach(() => {
  sb = sandbox();
  prs = [];
  failNext = false;
  remote = join(sb.root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env });
  sh(sb.project, ["init", "-q", "-b", "main"]);
  writeFileSync(join(sb.project, "README.md"), "# orders-api\n");
  sh(sb.project, ["add", "-A"]);
  sh(sb.project, ["commit", "-q", "-m", "init"]);
  sh(sb.project, ["remote", "add", "origin", remote]);
  sh(sb.project, ["push", "-q", "origin", "main"]);
});
afterEach(async () => {
  await rt?.close();
  rt = undefined as unknown as Runtime;
  sb.cleanup();
});

const WORKFLOW = workflowOf({
  name: "change",
  entry: "implement",
  steps: [{ id: "implement", kind: "agentic", agent: "impl", transitions: { onSuccess: "DONE" } }],
});

function engine() {
  return engineFor(
    rt,
    [WORKFLOW],
    {
      impl: async (ctx) => {
        writeFileSync(join(ctx.workspace.ref.path, "orders.ts"), "export const total = 42;\n");
        ctx.runtime.artifacts.put({
          runId: ctx.run.id,
          type: "spec",
          name: "spec.json",
          content: JSON.stringify({
            title: "ABC-42: order totals",
            summary: "Orders show their total.",
            goals: ["a total on every order"],
          }),
          provenance: { kind: "agent", agentId: "impl" },
          stepId: ctx.step.id,
          iteration: ctx.iteration,
        });
        return { status: "success" };
      },
    },
    undefined,
    workspaceFactory(env),
  );
}

async function runOf(options?: RunOptions, owner: Actor = ACTOR): Promise<Run> {
  const id = newRunId();
  const wt = await WorktreeWorkspace.create({
    repoRoot: sb.project,
    worktreesDir: join(sb.home, "worktrees"),
    runId: id,
    task: "ABC-42 order totals",
    env,
  });
  return rt.runs.create({
    id,
    task: "ABC-42 order totals",
    workflow: "change",
    owner,
    workspace: wt.ref,
    dataClass: rt.loaded.config.dataClass,
    ...(options ? { options } : {}),
  });
}

/** A run done without the PR flow: its PR is put up by hand (Apply, «Prepare PR», `jarvis apply --pr`). */
async function completed(): Promise<Run> {
  const run = await runOf({ prFlow: false });
  const done = await engine().execute(run.id, { owner: "cli:test:1" });
  expect(done.run.state).toBe("COMPLETED");
  return done.run;
}

function remoteHead(branch: string): string {
  return execFileSync("git", ["rev-parse", `refs/heads/${branch}`], {
    cwd: remote,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("jarvis apply --pr", () => {
  it("the PR flow (delivery.flow, on by default): the run puts up its PR itself when its work is done", async () => {
    await setup('delivery:\n  branch: "feature/{key}"\n');
    const run = await runOf();
    const done = await engine().execute(run.id, { owner: "cli:test:1" });
    expect(done.run.state).toBe("COMPLETED");
    expect(prs).toHaveLength(1);
    expect(prOf(rt, done.run)?.source).toBe("feature/ABC-42");
  });

  it("the PR flow off for the run, or nothing to put up: the run ends as before", async () => {
    await setup();
    const off = await runOf({ prFlow: false });
    expect((await engine().execute(off.id, { owner: "cli:test:1" })).run.state).toBe("COMPLETED");
    expect(prs).toHaveLength(0);
    const quiet = engineFor(
      rt,
      [WORKFLOW],
      { impl: async () => ({ status: "success" }) },
      undefined,
      workspaceFactory(env),
    );
    const empty = await runOf();
    const done = await quiet.execute(empty.id, { owner: "cli:test:1" });
    expect(done.run.state).toBe("COMPLETED");
    expect(done.run.stateReason ?? "").not.toContain("no PR");
    expect(rt.events.list({ runId: empty.id, kind: "delivery.skipped" })[0]?.payload).toMatchObject({
      code: "empty",
    });
    expect(prs).toHaveLength(0);
  });

  it("pushes the run's changes as one commit on its base and opens the PR once", async () => {
    await setup();
    const run = await completed();
    const done = await deliverPr(rt, run, { actor: ACTOR, channel: "cli" });
    expect(done.url).toBe("https://bitbucket.example/acme/orders-api/pull-requests/1");
    expect(done.target).toBe("main");
    const branch = run.workspace.branch as string;
    // one commit on the base, with the run's tree
    const pushed = remoteHead(branch);
    expect(pushed).toBe(done.commit);
    const parent = execFileSync("git", ["rev-parse", `${pushed}^`], {
      cwd: remote,
      encoding: "utf8",
      env,
    }).trim();
    expect(parent).toBe(run.workspace.baseCommit);
    expect(
      execFileSync("git", ["show", `${pushed}:orders.ts`], { cwd: remote, encoding: "utf8", env }),
    ).toContain("total = 42");
    // the PR: the spec's title, a description that ends neutrally (the marker after it), the coordinates
    expect(prs).toHaveLength(1);
    const args = (prs[0] as FakePr).args as Record<string, string>;
    expect(args.title).toBe("ABC-42: order totals");
    expect(args.source).toBe(branch);
    expect(args.target).toBe("main");
    expect(args.repo).toBe("remote");
    expect(args.description).toContain("Orders show their total.");
    expect(args.description).toContain("- orders.ts");
    expect(String(args.description).trimEnd()).toMatch(/Prepared by Jarvis, run \w+\.$/);
    expect(args.description).not.toMatch(/claude\.ai|https?:/);
    // recorded: the artifact, the event, both effects in the journal
    expect(prOf(rt, run)?.url).toBe(done.url);
    const delivered = rt.events.list({ runId: run.id, kind: "run.delivered" });
    expect(delivered[0]?.payload?.url).toBe(done.url);
    expect(delivered[0]?.actor).toBe("user:me@corp");
    expect(rt.effects.byRun(run.id).map((e) => [e.capability, e.status])).toEqual([
      ["git.push", "done"],
      ["bitbucket.pr.create", "done"],
    ]);
    // asked again: it is there, nothing goes out
    const again = await deliverPr(rt, run, { actor: ACTOR, channel: "ui" });
    expect(again.already).toBe(true);
    expect(prs).toHaveLength(1);
  });

  it("takes the title and the target branch it is given", async () => {
    await setup();
    const run = await completed();
    sh(sb.project, ["push", "-q", "origin", "main:release"]);
    const done = await deliverPr(rt, run, {
      actor: ACTOR,
      channel: "cli",
      title: "Totals",
      target: "release",
    });
    expect(done.title).toBe("Totals");
    expect((prs[0] as FakePr).args.target).toBe("release");
  });

  it("the team's formats: the branch, the commit and the PR title; the author is the person", async () => {
    await setup(
      'delivery:\n  branch: "feature/{key}"\n  commit: { format: "{type}({scope}): {key} {subject}", scope: orders }\n  prTitle: "{type}({scope}): {key} {subject}"\n',
    );
    const run = await completed();
    const done = await deliverPr(rt, run, { actor: ACTOR, channel: "cli" });
    expect(done.source).toBe("feature/ABC-42");
    expect(remoteHead("feature/ABC-42")).toBe(done.commit);
    const message = execFileSync("git", ["log", "-1", "--format=%B%n--%an", done.commit], {
      cwd: remote,
      encoding: "utf8",
      env,
    });
    expect(message).toMatch(/^feat\(orders\): ABC-42 order totals\n\nJarvis-Run: \S+\nAssisted-By: Jarvis /);
    expect(message).not.toMatch(/--Jarvis/);
    expect((prs[0] as FakePr).args.title).toBe("feat(orders): ABC-42 order totals");
  });

  it("a format that wants the issue key refuses a task without one, before anything is pushed", async () => {
    await setup('delivery:\n  branch: "feature/{key}"\n');
    const run = await completed();
    rt.db.db.prepare("UPDATE runs SET task = ? WHERE id = ?").run("order totals", run.id);
    await expect(
      deliverPr(rt, rt.runs.require(run.id), { actor: ACTOR, channel: "cli" }),
    ).rejects.toMatchObject({
      code: "format",
    });
    expect(prs).toHaveLength(0);
  });

  it("a branch name git does not take is refused before anything is pushed", async () => {
    await setup();
    const run = await completed();
    await expect(
      deliverPr(rt, run, { actor: ACTOR, channel: "cli", source: "feature/ABC 42..x" }),
    ).rejects.toMatchObject({ code: "format" });
    expect(prs).toHaveLength(0);
  });

  it("a task in a Story goes into the Story's branch the run started from (relatedWork.story)", async () => {
    await setup();
    const run = await runOf();
    rt.db.db
      .prepare("UPDATE runs SET workspace_json = ? WHERE id = ?")
      .run(
        JSON.stringify({ ...run.workspace, story: { key: "ABC-40", branch: "feature/ABC-40", based: true } }),
        run.id,
      );
    const done = await engine().execute(run.id, { owner: "cli:test:1" });
    sh(sb.project, ["push", "-q", "origin", "main:feature/ABC-40"]);
    await deliverPr(rt, done.run, { actor: ACTOR, channel: "cli" });
    expect((prs[0] as FakePr).args.target).toBe("feature/ABC-40");
  });

  it("a failed PR is not recorded done: the next try opens it, the push is not repeated", async () => {
    await setup();
    const run = await completed();
    failNext = true;
    await expect(deliverPr(rt, run, { actor: ACTOR, channel: "cli" })).rejects.toThrow(/500 from the server/);
    expect(prOf(rt, run)).toBeUndefined();
    const done = await deliverPr(rt, run, { actor: ACTOR, channel: "cli" });
    expect(done.url).toMatch(/pull-requests\/1$/);
    expect(
      rt.events.list({ runId: run.id, kind: "effect.replayed" }).map((e) => e.payload?.capability),
    ).toEqual(["git.push"]);
  });

  it("delivery.pr: deny refuses, nothing is pushed", async () => {
    await setup("delivery: { pr: deny }\n");
    const run = await completed();
    await expect(deliverPr(rt, run, { actor: ACTOR, channel: "cli" })).rejects.toMatchObject({
      code: "denied",
    });
    expect(() => remoteHead(run.workspace.branch as string)).toThrow();
    expect(prs).toHaveLength(0);
  });

  it("delivery.pr: approve wants a person's approval of the PR as it will go out", async () => {
    await setup("delivery: { pr: approve }\n");
    const run = await completed();
    const error = await deliverPr(rt, run, { actor: ACTOR, channel: "ui" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeliveryError);
    expect((error as DeliveryError).code).toBe("approval");
    const pending = pendingPrRequest(rt, run);
    expect(pending?.request.title).toBe("ABC-42: order totals");
    expect(prs).toHaveLength(0);
    recordDecision(rt, run, {
      actor: ACTOR,
      artifact: pending?.artifact as never,
      type: PR_REQUEST,
      decision: "approve",
      channel: "ui",
    });
    const done = await deliverPr(rt, run, { actor: ACTOR, channel: "ui" });
    expect(done.url).toBeDefined();
    expect(pendingPrRequest(rt, run)).toBeUndefined();
  });

  it("from the terminal: refused by the policy with its exit code, no server named when there is none", async () => {
    await setup("delivery: { pr: deny }\n");
    const run = await completed();
    const jarvis = async (args: string[]) => {
      let err = "";
      const sink = (keep: boolean) =>
        new Writable({
          write(c, _e, cb) {
            if (keep) err += String(c);
            cb();
          },
        });
      const code = await cli(["node", "jarvis", ...args], {
        streams: { out: sink(false), err: sink(true) },
        context: { cwd: sb.project, homeDir: sb.home, env: { ...env, JARVIS_INTERACTIVE: "off" } },
      });
      return { code, err };
    };
    const denied = await jarvis(["apply", shortRunId(run.id), "--pr"]);
    expect(denied.code).toBe(12);
    expect(denied.err).toContain("delivery.pr: deny");
    sb.write("project/.jarvis/project.yaml", "version: 1\n");
    const none = await jarvis(["apply", shortRunId(run.id), "--pr"]);
    expect(none.code).toBe(1);
    expect(none.err).toContain("no MCP server here opens pull requests");
  });

  it("says so when no server opens pull requests", async () => {
    await setup();
    rt.registry.unregister("fake-bitbucket");
    const run = await completed();
    await expect(deliverPr(rt, run, { actor: ACTOR, channel: "cli" })).rejects.toMatchObject({
      code: "no-capability",
    });
  });
});

describe("a run that delivers itself (--deliver pr)", () => {
  it("opens its PR when the workflow is done, then completes", async () => {
    await setup();
    const run = await runOf({ delivery: "pr" });
    const done = await engine().execute(run.id, { owner: "cli:test:1" });
    expect(done.run.state).toBe("COMPLETED");
    expect(prOf(rt, done.run)?.url).toMatch(/pull-requests\/1$/);
  });

  it("with delivery.pr: approve waits for a person; the daemon goes on for the owner once approved", async () => {
    await setup("delivery: { pr: approve }\n");
    const run = await runOf({ delivery: "pr" });
    const parked = await engine().execute(run.id, { owner: "cli:test:1" });
    expect(parked.run.state).toBe("WAITING_HUMAN");
    expect(parked.run.waitingFor).toMatchObject({ kind: "approval", detail: PR_REQUEST });
    expect(prs).toHaveLength(0);
    const request = rt.artifacts.listLatest(run.id, PR_REQUEST)[0];
    recordDecision(rt, parked.run, {
      actor: ACTOR,
      artifact: request as never,
      type: PR_REQUEST,
      decision: "approve",
      channel: "cli",
    });
    const tick = await daemonTick(rt, engine(), { owner: "daemon:test" });
    expect(tick.resumed).toEqual([{ runId: run.id, state: "COMPLETED", exitCode: 0 }]);
    expect(prs).toHaveLength(1);
    // ADR-0006 §2: the daemon did it, for the owner — on the PR's record and every event of the resume
    const pr = prOf(rt, rt.runs.require(run.id));
    expect(pr).toMatchObject({ actor: "service:daemon", onBehalfOf: "user:me@corp" });
    const delivered = rt.events.list({ runId: run.id, kind: "run.delivered" })[0];
    expect(delivered).toMatchObject({ actor: "service:daemon", onBehalfOf: "user:me@corp" });
    const effects = rt.events.list({ runId: run.id, kind: "effect.done" });
    expect(effects.map((e) => [e.actor, e.onBehalfOf])).toEqual([
      ["service:daemon", "user:me@corp"],
      ["service:daemon", "user:me@corp"],
    ]);
    // the person's approval stays theirs, for nobody else
    const approval = rt.events.list({ runId: run.id, kind: "approval.recorded" })[0];
    expect(approval?.actor).toBe("user:me@corp");
    expect(approval?.onBehalfOf).toBeUndefined();
  });

  it("daemon.actAsOwner: false — the daemon parks it with the reason; the owner goes on", async () => {
    await setup("", "daemon: { actAsOwner: false }\n");
    const run = await runOf({ delivery: "pr" });
    const parked = await engine().execute(run.id, { owner: "daemon:test", actor: DAEMON_ACTOR });
    expect(parked.run.state).toBe("WAITING_HUMAN");
    expect(parked.run.stateReason).toMatch(/daemon\.actAsOwner: false/);
    expect(prs).toHaveLength(0);
    // not the daemon's to resume
    const tick = await daemonTick(rt, engine(), { owner: "daemon:test" });
    expect(tick.resumed).toEqual([]);
    const done = await engine().execute(run.id, { owner: "cli:test:1" });
    expect(done.run.state).toBe("COMPLETED");
    expect(prOf(rt, done.run)).toMatchObject({ actor: "user:me@corp" });
    expect(prOf(rt, done.run)?.onBehalfOf).toBeUndefined();
  });

  it("a PR it cannot make does not undo the work: completed, with why", async () => {
    await setup("delivery: { pr: deny }\n");
    const run = await runOf({ delivery: "pr" });
    const done = await engine().execute(run.id, { owner: "cli:test:1" });
    expect(done.run.state).toBe("COMPLETED");
    expect(done.run.stateReason).toMatch(/no PR: pull requests are off/);
    expect(rt.events.list({ runId: run.id, kind: "delivery.failed" })[0]?.payload?.code).toBe("denied");
  });
});

describe("actors on events (ADR-0006 §2)", () => {
  it("an event without an actor is the acting one's, with onBehalfOf; a named one keeps its own", () => {
    const events = new MemoryEventStore();
    actingAs({ actor: "service:daemon", onBehalfOf: "user:me@corp" }, () => {
      events.emit({ kind: "model.call" });
      events.emit({ kind: "approval.recorded", actor: "user:other@corp" });
    });
    events.emit({ kind: "outside" });
    expect(events.events.map((e) => [e.kind, e.actor, e.onBehalfOf])).toEqual([
      ["model.call", "service:daemon", "user:me@corp"],
      ["approval.recorded", "user:other@corp", undefined],
      ["outside", undefined, undefined],
    ]);
  });

  it("CI: the job names whose change it runs for (JARVIS_ON_BEHALF_OF)", async () => {
    await setup();
    await rt.close();
    rt = await testRuntime(sb, { ...env, JARVIS_ON_BEHALF_OF: "dev@corp" });
    const ci: Actor = { kind: "ci", id: "pipeline:7", verified: false };
    const run = await runOf(undefined, ci);
    await engine().execute(run.id, { owner: "ci:1" });
    const state = rt.events.list({ runId: run.id, kind: "run.state" })[0];
    expect(state).toMatchObject({ actor: "ci:pipeline:7", onBehalfOf: "user:dev@corp" });
  });
});

describe("where the PR goes and what came back", () => {
  it("reads the repository from the remote's URL", () => {
    expect(repositoryFromUrl("git@bitbucket.org:acme/orders-api.git")).toEqual({
      workspace: "acme",
      repo: "orders-api",
    });
    expect(repositoryFromUrl("https://git.example/scm/SHOP/payments-service.git")).toEqual({
      workspace: "SHOP",
      repo: "payments-service",
    });
    expect(repositoryFromUrl("ssh://git@git.example:7999/shop/common-lib.git")).toEqual({
      workspace: "shop",
      repo: "common-lib",
    });
    expect(repositoryFromUrl("orders-api")).toEqual({});
  });

  it("finds the PR's link in what the server answered", () => {
    expect(
      linkOf({ ok: true, text: '{"id":3,"links":{"self":[{"href":"https://git.example/pr/3"}]}}' }),
    ).toEqual({
      url: "https://git.example/pr/3",
      id: "3",
    });
    expect(linkOf({ ok: true, text: "created https://git.example/acme/orders-api/pull-requests/9" })).toEqual(
      {
        url: "https://git.example/acme/orders-api/pull-requests/9",
      },
    );
  });
});

describe("the run page: «Create PR» next to Apply", () => {
  let ui: UiServer;
  afterEach(async () => {
    await ui?.close();
  });

  async function serve(): Promise<void> {
    ui = await startUiServer({
      runtime: rt,
      engine: createEngine(rt),
      port: 0,
      homeDir: sb.home,
      projectRoot: sb.project,
      pollMs: 30,
      actor: async () => ACTOR,
    });
  }

  const cookie = (lang = "en") => `jarvis_ui_${ui.port}=${encodeURIComponent(ui.token)}; jarvis_lang=${lang}`;

  async function page(path: string, lang = "en"): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${ui.port}${path}`, { headers: { cookie: cookie(lang) } });
    return res.text();
  }

  function post(
    path: string,
    fields: Record<string, string>,
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

  it("creates the PR from the page and shows its link", async () => {
    await setup();
    const run = await completed();
    await serve();
    const short = shortRunId(run.id);
    expect(await page(`/runs/${short}`)).toContain("Prepare PR");
    expect(await page(`/runs/${short}`, "ru")).toContain("Подготовить PR");
    // the form's token, as every run action
    expect((await post(`/runs/${short}/pr`, { t: "wrong" })).status).toBe(403);
    // the first click shows the card: nothing pushed yet
    const prepared = await post(`/runs/${short}/pr`, { t: ui.token });
    expect(prepared.location).toContain("notice=pr-check");
    const card = await page(`/runs/${short}`);
    expect(card).toContain("The pull request as it will go out");
    expect(card).toContain('name="source"');
    expect(prs).toHaveLength(0);
    // what the person changed on the card is what goes out
    const created = await post(`/runs/${short}/pr`, {
      t: ui.token,
      confirm: "1",
      source: "feature/ABC-42-totals",
      title: "Order totals",
    });
    expect(created.location).toContain("notice=pr-created");
    expect((prs[0] as FakePr).args).toMatchObject({ source: "feature/ABC-42-totals", title: "Order totals" });
    expect(remoteHead("feature/ABC-42-totals")).toMatch(/^[0-9a-f]{40}$/);
    const after = await page(`/runs/${short}`);
    expect(after).toContain("https://bitbucket.example/acme/orders-api/pull-requests/1");
    expect(after).not.toContain(">Create PR<");
    expect(after).not.toContain(">Prepare PR<");
    // the PR flow's panel and the code review page; the read fails here: no server reads PRs
    expect(after).toContain("PR_REVIEW");
    expect(after).toContain("Check comments");
    expect(await page(`/runs/${short}/pr`)).toContain("Code review");
    const check = await post(`/runs/${short}/pr-check`, { t: ui.token });
    expect(check.location).toContain("notice=pr-check-failed");
    // the end: the task finalized here, the PR not ready, said so
    expect(after).toContain("Finalize the task");
    const notReady = await post(`/runs/${short}/finalize`, { t: ui.token });
    expect(notReady.location).toContain("notice=finalize-failed");
    const finalized = await post(`/runs/${short}/finalize`, { t: ui.token, anyway: "1" });
    expect(finalized.location).toContain("notice=finalized");
    expect(await page(`/runs/${short}`)).toContain("FINALIZED");
    expect(prs).toHaveLength(1);
  });

  it("delivery.pr: approve — the first click shows the PR, the second approves and sends it", async () => {
    await setup("delivery: { pr: approve }\n");
    const run = await completed();
    await serve();
    const short = shortRunId(run.id);
    const first = await post(`/runs/${short}/pr`, { t: ui.token });
    expect(first.location).toContain("notice=pr-check");
    const shown = await page(`/runs/${short}`);
    expect(shown).toContain("Approve and create PR");
    expect(shown).toContain("ABC-42: order totals");
    expect(prs).toHaveLength(0);
    const second = await post(`/runs/${short}/pr`, { t: ui.token, confirm: "1" });
    expect(second.location).toContain("notice=pr-created");
    expect(prs).toHaveLength(1);
    const approval = rt.events.list({ runId: run.id, kind: "approval.recorded" })[0];
    expect(approval?.payload).toMatchObject({ type: PR_REQUEST, channel: "ui" });
  });

  it("a run waiting for its PR's approval shows what it waits on", async () => {
    await setup("delivery: { pr: approve }\n");
    const run = await runOf({ delivery: "pr" });
    await engine().execute(run.id, { owner: "cli:test:1" });
    await serve();
    const res = await fetch(`http://127.0.0.1:${ui.port}/runs/${shortRunId(run.id)}`, {
      headers: { cookie: cookie() },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(PR_REQUEST);
  });

  it("no button where the project says no PRs", async () => {
    await setup("delivery: { pr: deny }\n");
    const run = await completed();
    await serve();
    expect(await page(`/runs/${shortRunId(run.id)}`)).not.toContain("Prepare PR");
  });
});

describe("activity says on whose behalf (ADR-0006 §2)", () => {
  it("the daemon's line names the owner", () => {
    const e = {
      seq: 1,
      ts: "2026-10-20T10:00:00.000Z",
      kind: "run.delivered",
      actor: "service:daemon",
      onBehalfOf: "user:me@corp",
      payload: { url: "https://bitbucket.example/pr/1" },
    };
    expect(feedItem(e)?.text).toBe(
      "PR opened: https://bitbucket.example/pr/1 by daemon on behalf of me@corp",
    );
    expect(inLang("ru", () => feedItem(e)?.text)).toBe(
      "Открыт PR: https://bitbucket.example/pr/1 — daemon от имени me@corp",
    );
    const resumed = {
      ...e,
      kind: "run.state",
      payload: { state: "RUNNING", reason: "resumed from WAITING_HUMAN" },
    };
    expect(feedItem(resumed)?.text).toBe(
      "running — resumed from WAITING_HUMAN by daemon on behalf of me@corp",
    );
  });
});

describe("the PR flow's fixes (jarvis pr-fix)", () => {
  it("the agreed threads fixed on top of the PR's branch: one commit pushed, each thread answered", async () => {
    await setup('delivery:\n  commit: { fix: "{subject}" }\n');
    const replies: Array<Record<string, unknown>> = [];
    const comment: Capability = {
      name: "bitbucket.pr.comment",
      description: "comment",
      network: "intranet",
      access: "write",
      effect: true,
      server: "bitbucket",
      parameters: { type: "object" },
      async handler(args) {
        replies.push(args);
        return { ok: true, text: "{}" };
      },
    };
    rt.registry.register({ name: "fake-comments", capabilities: () => [comment] });
    const parent = await completed();
    const pr = await deliverPr(rt, parent, { actor: ACTOR, channel: "cli" });
    const prHead = remoteHead(pr.source);
    const put = (type: string, content: unknown) =>
      rt.artifacts.put({
        runId: parent.id,
        type,
        name: `${type}.json`,
        content: JSON.stringify(content),
        provenance: { kind: "tool", capability: "test" },
        stepId: "pr",
      });
    put("pr-review", {
      threads: [
        {
          id: 101,
          author: "reviewer-a",
          text: "total may be negative",
          file: "orders.ts",
          line: 1,
          replies: [],
        },
      ],
    });
    put("pr-triage", {
      items: [
        {
          thread: 101,
          comment: 101,
          verdict: "agree",
          reason: "r",
          reply: "Agreed: the total is never negative now.",
          change: "orders.ts: clamp the total at 0",
          sources: [],
          state: "to-fix",
        },
      ],
    });
    // the fix run's checkout: the PR's head as the remote has it
    sh(sb.project, ["fetch", "-q", "origin", pr.source]);
    const id = newRunId();
    const wt = await WorktreeWorkspace.create({
      repoRoot: sb.project,
      worktreesDir: join(sb.home, "worktrees"),
      runId: id,
      task: "ABC-42 PR comments",
      baseRef: `origin/${pr.source}`,
      env,
    });
    const fix = rt.runs.create({
      id,
      task: "ABC-42 PR comments",
      workflow: "pr-fix",
      owner: ACTOR,
      workspace: wt.ref,
      dataClass: rt.loaded.config.dataClass,
      options: { prFix: { runId: parent.id }, prFlow: false },
    });
    let asked = "";
    const engine = engineFor(
      rt,
      [workflowOf(parse(PR_FIX_WORKFLOW) as Record<string, unknown>)],
      {
        implementation: async (ctx) => {
          asked = ctx.inputs
            .map((ref) => {
              const [artifactId, version] = ref.split("@");
              return rt.artifacts.text(rt.artifacts.get(artifactId as string, Number(version)) as never);
            })
            .join("\n");
          writeFileSync(join(ctx.workspace.ref.path, "orders.ts"), "export const total = Math.max(0, 42);\n");
          return { status: "success" };
        },
      },
      undefined,
      workspaceFactory(env),
    );
    const done = await engine.execute(fix.id, { owner: "cli:test:1" });
    expect(done.run.state).toBe("COMPLETED");
    expect(asked).toContain("total may be negative");
    expect(asked).toContain("clamp the total at 0");
    // one commit on the PR's head, pushed onto its branch
    const head = remoteHead(pr.source);
    expect(head).not.toBe(prHead);
    expect(
      execFileSync("git", ["rev-parse", `${head}^`], { cwd: remote, encoding: "utf8", env }).trim(),
    ).toBe(prHead);
    expect(
      execFileSync("git", ["log", "-1", "--format=%s", head], { cwd: remote, encoding: "utf8", env }).trim(),
    ).toBe("address review comments");
    // the thread answered, marked fixed with the commit
    expect(replies[0]).toMatchObject({ id: pr.id, parent: 101 });
    expect(String(replies[0]?.content)).toMatch(
      /^Agreed: the total is never negative now\.\n\n— Jarvis: fixed in [0-9a-f]{10}$/,
    );
    const triage = JSON.parse(rt.artifacts.text(rt.artifacts.listLatest(parent.id, "pr-triage")[0] as never));
    expect(triage.items[0]).toMatchObject({ state: "fixed", fix: { run: fix.id, commit: head } });
    expect(rt.events.list({ runId: parent.id, kind: "pr.fixPushed" })).toHaveLength(1);
  });
});

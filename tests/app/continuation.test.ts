import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  continuationOf,
  continuedFromOf,
  isStale,
  issueKeyOf,
  startPointOf,
} from "../../src/app/continuation.ts";
import { createEngine } from "../../src/app/engine.ts";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import type { Run } from "../../src/core/domain/run.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** A finished research goes on as sdd from the page: which one, and whether its code changed since. */
let sb: Sandbox;
let rt: Runtime;
const DEV = { kind: "user" as const, id: "dev@example.com", verified: false };
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: sb.project, encoding: "utf8", env: { ...process.env, ...gitEnv } }).trim();
const commit = (file: string, text: string) => {
  sb.write(`project/${file}`, text);
  git("add", "-A");
  git("commit", "-qm", `change ${file}`);
};

beforeEach(async () => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  git("init", "-q");
  commit("src/orders/slots.ts", "export const slots = [];\n");
  rt = createRuntime(await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} }), { env: {} });
});
afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

/** A research that read `read` and ended. */
const research = (task: string, read: readonly string[] = [], base = true): Run => {
  const run = rt.runs.create({
    task,
    workflow: "research",
    owner: DEV,
    workspace: {
      mode: "cwd",
      repoRoot: sb.project,
      path: sb.project,
      baseRef: "HEAD",
      ...(base ? { baseCommit: git("rev-parse", "HEAD") } : {}),
    },
    dataClass: "internal",
  });
  for (const path of read)
    rt.events.emit({
      kind: "tool.call",
      runId: run.id,
      stepId: "research",
      payload: { capability: "repo.read", ok: true, args: JSON.stringify({ path }) },
    });
  rt.events.emit({ kind: "agent.finish", runId: run.id, stepId: "research", payload: { contradictions: 3 } });
  rt.runs.update(run.id, { currentStep: "research", currentIteration: 1 });
  rt.runs.transition(run.id, "RUNNING");
  rt.runs.transition(run.id, "COMPLETED");
  return rt.runs.get(run.id) as Run;
};

describe("going on from a research", () => {
  it("finds the issue key of a task", () => {
    expect(issueKeyOf("ABC-42: Delivery slots on the order form")).toBe("ABC-42");
    expect(issueKeyOf("see https://jira.example.corp/browse/ABC-42")).toBe("ABC-42");
    expect(issueKeyOf("slots on the order form")).toBeUndefined();
  });

  it("a finished research goes on as sdd from requirements, once", () => {
    const engine = createEngine(rt);
    const run = research("ABC-42");
    const next = continuationOf(rt, engine, run);
    expect(next?.workflow).toBe("sdd");
    expect(next?.startAt).toBe(next?.rest[0]);
    expect(next?.rest.some((s) => s.startsWith("approve-"))).toBe(false);
    // gone on: no second time, and the new run knows where it came from
    const to = rt.runs.create({ ...run, id: undefined, workflow: "sdd" } as never);
    rt.events.emit({ kind: "run.created", runId: to.id, payload: { continuedFrom: run.id } });
    expect(continuationOf(rt, engine, run)).toBeUndefined();
    expect(continuedFromOf(rt, to)).toBe(run.id);
  });

  it("a continuation stopped by a cancel lets the research go on again", () => {
    const engine = createEngine(rt);
    const run = research("ABC-42");
    const to = rt.runs.create({ ...run, id: undefined, workflow: "sdd" } as never);
    rt.events.emit({ kind: "run.created", runId: to.id, payload: { continuedFrom: run.id } });
    rt.runs.transition(to.id, "RUNNING");
    expect(continuationOf(rt, engine, run)).toBeUndefined();
    // ended FAILED on the cancel before the engine said CANCELLED: still a cancel
    rt.runs.transition(to.id, "FAILED", { reason: "cancel requested" });
    expect(continuationOf(rt, engine, run)?.workflow).toBe("sdd");
  });

  it("offers the research of the same issue in the repository, ticked while the code it read stands", async () => {
    const engine = createEngine(rt);
    const run = research("ABC-42: Delivery slots on the order form", ["src/orders/slots.ts"]);
    const at = (task: string) => startPointOf(rt, engine, { task, workflow: "sdd", repoRoot: sb.project });
    const fresh = await at("ABC-42");
    expect(fresh?.run.id).toBe(run.id);
    expect(fresh?.contradictions).toBe(3);
    expect(fresh?.since).toEqual({ commits: 0, touched: [] });
    expect(fresh && isStale(fresh)).toBe(false);
    // another issue, another workflow, another repository: nothing to start from
    expect(await at("ABC-43")).toBeUndefined();
    expect(
      await startPointOf(rt, engine, { task: "ABC-42", workflow: "research", repoRoot: sb.project }),
    ).toBeUndefined();
    expect(
      await startPointOf(rt, engine, { task: "ABC-42", workflow: "sdd", repoRoot: sb.home }),
    ).toBeUndefined();
    // a commit elsewhere: still fresh
    commit("README.md", "orders\n");
    const elsewhere = await at("ABC-42");
    expect(elsewhere?.since).toEqual({ commits: 1, touched: [] });
    // a commit to a file it read: out of date, offered unticked
    commit("src/orders/slots.ts", "export const slots = ['9-12'];\n");
    const stale = await at("ABC-42");
    expect(stale?.since).toEqual({ commits: 2, touched: ["src/orders/slots.ts"] });
    expect(stale && isStale(stale)).toBe(true);
  });

  it("without a base commit it can't tell, and a task without a key matches by its words", async () => {
    const engine = createEngine(rt);
    const run = research("slots on the order form", [], false);
    const point = await startPointOf(rt, engine, {
      task: "slots on the order form",
      workflow: "sdd",
      repoRoot: sb.project,
    });
    expect(point?.run.id).toBe(run.id);
    expect(point?.since).toBeUndefined();
  });
});

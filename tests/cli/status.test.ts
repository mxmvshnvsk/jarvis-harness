import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app/runtime.ts";
import { run } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let runId: string;

beforeEach(async () => {
  sb = sandbox();
  sb.write(
    "home/.jarvis/config.yaml",
    "version: 1\nquotaPools:\n  corp: { window: { minutes: 20 }, limits: { outputTokens: 1000, requests: 10 } }\n",
  );
  sb.write("project/.jarvis/project.yaml", "version: 1\n");
  const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
  const rt = createRuntime(loaded, { env: {} });
  const created = rt.runs.create({
    task: "ABC-123",
    workflow: "sdd",
    owner: { kind: "user", id: "me@corp", verified: false },
    workspace: {
      mode: "worktree",
      repoRoot: sb.project,
      path: "/wt",
      branch: "jarvis/ABC-123/abc",
      baseRef: "HEAD",
    },
    dataClass: "confidential",
  });
  runId = created.id;
  rt.runs.transition(runId, "RUNNING");
  rt.runs.update(runId, { currentStep: "spec", currentIteration: 1 });
  const stepId = rt.history.start(runId, "research", 1);
  rt.history.finish(stepId, "success", undefined, []);
  rt.artifacts.put({
    runId,
    type: "research",
    name: "research.json",
    content: "{}",
    provenance: { kind: "agent", agentId: "research" },
    stepId: "research",
  });
  rt.artifacts.put({
    runId,
    type: "spec",
    name: "spec.md",
    content: "# spec",
    provenance: { kind: "agent", agentId: "spec" },
    stepId: "spec",
  });
  rt.checkpoints.save({ runId, stepId: "spec", iteration: 1, kind: "step", headCommit: "0123456789abcdef" });
  rt.usage.record({
    pool: "corp",
    model: "flash",
    runId,
    promptTokens: 100,
    cachedTokens: 20,
    outputTokens: 300,
  });
  rt.events.emit({
    kind: "model.call",
    runId,
    stepId: "spec",
    payload: {
      modelId: "flash",
      promptTokens: 100,
      cachedTokens: 20,
      outputTokens: 300,
      latencyMs: 900,
      retries: 1,
    },
  });
  rt.runs.transition(runId, "WAITING_HUMAN", { reason: "approve spec" });
  rt.close();
});

afterEach(() => sb.cleanup());

async function jarvis(args: string[]) {
  let out = "";
  let err = "";
  const code = await run(["node", "jarvis", ...args], {
    streams: {
      out: new Writable({
        write(c, _e, cb) {
          out += String(c);
          cb();
        },
      }),
      err: new Writable({
        write(c, _e, cb) {
          err += String(c);
          cb();
        },
      }),
    },
    context: { cwd: sb.project, homeDir: sb.home, env: { PATH: process.env.PATH ?? "" } },
  });
  return { code, out, err };
}

describe("jarvis status", () => {
  it("lists active runs with budget", async () => {
    const r = await jarvis(["status"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/ABC-123\s+WAITING_HUMAN\s+spec#1/);
    expect(r.out).toContain("corp: 300/1000 output tokens, 1/10 requests in 20m window (30%)");
  });

  it("shows one run in detail by id prefix", async () => {
    const r = await jarvis(["status", runId.slice(4, 12)]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`run ${runId}`);
    expect(r.out).toContain("state      WAITING_HUMAN — approve spec");
    expect(r.out).toContain("tokens     1 calls, 100 prompt (20 cached), 300 output, 1 retries");
    expect(r.out).toMatch(/spec\/spec\.md@1\s+agent:spec.*AWAITING APPROVAL/);
    expect(r.out).toMatch(/research\/research\.json@1\s+agent:research/);
    expect(r.out).toContain("checkpoint step at spec #1 @ 0123456789");
    expect(r.out).toContain("model.call");
  });

  it("emits JSON and exits 1 for unknown runs", async () => {
    const r = await jarvis(["--json", "status", runId]);
    const detail = JSON.parse(r.out) as {
      run: { state: string };
      pendingApprovals: unknown[];
      tokens: { outputTokens: number };
    };
    expect(detail.run.state).toBe("WAITING_HUMAN");
    expect(detail.pendingApprovals).toHaveLength(1);
    expect(detail.tokens.outputTokens).toBe(300);
    const missing = await jarvis(["status", "zzz"]);
    expect(missing.code).toBe(1);
  });

  it("cancels an idle run immediately and hides it from the default list", async () => {
    const c = await jarvis(["cancel", runId]);
    expect(c.code).toBe(0);
    expect(c.out).toContain("cancelled");
    const list = await jarvis(["status"]);
    expect(list.out).toContain("no active runs");
    const all = await jarvis(["status", "--all"]);
    expect(all.out).toContain("CANCELLED");
  });

  it("shows a RUNNING run whose process is gone as such, and cancels it at once (pilot: Ctrl-C)", async () => {
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    rt.runs.transition(runId, "RUNNING");
    // the process took the lease and died: nobody renews it
    rt.runs.acquireLease(runId, "cli:host:4242", -1000);
    rt.close();
    const short = runId.replace(/^run_/, "").slice(0, 8);
    const list = await jarvis(["status"]);
    expect(list.out).toContain(`no process → jarvis resume|cancel ${short}`);
    const detail = await jarvis(["status", runId]);
    expect(detail.out).toContain("no process holds it (interrupted or crashed)");
    const c = await jarvis(["cancel", short]);
    expect(c.out).toContain("cancelled");
  });

  it("keeps one line per run when a task is a paragraph (pilot: onboarding prompts)", async () => {
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    rt.runs.create({
      task: "Map the module `packages/shared` of this repository for onboarding.\nDeterministic facts: 3 files.\nStay inside `packages/shared`.",
      workflow: "onboard-module",
      owner: { kind: "user", id: "me@corp", verified: false },
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "internal",
    });
    rt.close();
    const all = await jarvis(["status", "--all"]);
    const rows = all.out.split("\n").filter((l) => /^[0-9a-f]{8} /.test(l));
    expect(rows).toHaveLength(2);
    expect(all.out).toContain("Map the module packages/shared of this reposito…");
    expect(all.out).not.toContain("Deterministic facts");
  });

  it("says a finished run has nothing to cancel instead of requesting a cancel (pilot)", async () => {
    expect((await jarvis(["cancel", runId])).code).toBe(0);
    const again = await jarvis(["cancel", runId]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("is already CANCELLED; nothing to cancel");
    expect(again.out).not.toContain("held by");
  });
});

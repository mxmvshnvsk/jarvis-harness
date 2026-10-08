import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestRerun } from "../../src/app/decide.ts";
import { Journey } from "../../src/app/journey.ts";
import { pauseRequested, requestPause } from "../../src/app/pause.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { formatStepReport } from "../../src/cli/progress.ts";
import { createStyle } from "../../src/cli/style.ts";
import { ModelError } from "../../src/models/errors.ts";
import { interruption } from "../../src/orchestration/interrupt.ts";
import { LeaseHeldError } from "../../src/orchestration/types.ts";
import { loadWorkflows } from "../../src/workflows/load.ts";
import { ACTOR, createRun, engineFor, testRuntime, workflowOf, writeArtifact } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let rt: Runtime;

beforeEach(async () => {
  sb = sandbox();
  sb.write("project/.jarvis/project.yaml", "version: 1\n");
  rt = await testRuntime(sb);
});
afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

const owner = { owner: "cli:test:1" };

describe("LocalWorkflowEngine", () => {
  it("runs the built-in smoke workflow to completion with history, artifacts and checkpoints", async () => {
    const workflows = [...loadWorkflows().values()];
    const engine = engineFor(rt, workflows);
    const run = createRun(rt, "smoke");
    const result = await engine.execute(run.id, owner);
    expect(result.run.state).toBe("COMPLETED");
    expect(result.exitCode).toBe(0);
    expect(rt.history.list(run.id).map((h) => `${h.stepId}:${h.status}`)).toEqual([
      "hello:success",
      "done-check:success",
    ]);
    expect(rt.history.list(run.id)[1]?.inputs).toHaveLength(1);
    expect(rt.artifacts.listLatest(run.id).map((a) => a.name)).toEqual(["hello.md"]);
    expect(rt.checkpoints.list(run.id).map((c) => `${c.stepId}:${c.kind}`)).toEqual([
      "done-check:step",
      "done-check:step",
    ]);
    expect(result.run.lease).toBeUndefined();
    const kinds = rt.events.list({ runId: run.id }).map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["run.lease", "run.state", "step.start", "step.finish", "step.next"]),
    );
  });

  it("follows outcome back edges with bounded iterations and parks on exhaustion", async () => {
    const wf = workflowOf({
      name: "loop",
      entry: "research",
      steps: [
        {
          id: "research",
          kind: "agentic",
          agent: "research",
          outputs: ["research"],
          transitions: { onSuccess: "impact" },
        },
        {
          id: "impact",
          kind: "agentic",
          agent: "impact",
          inputs: ["research"],
          transitions: {
            onSuccess: "DONE",
            onOutcome: { needs_research: { to: "research", maxIterations: 2 } },
          },
        },
      ],
    });
    let impactCalls = 0;
    const engine = engineFor(rt, [wf], {
      research: async (ctx) => writeArtifact(ctx, "research", `research v${ctx.iteration}`),
      impact: async (ctx) => {
        impactCalls += 1;
        expect(ctx.inputs).toHaveLength(1);
        return { status: "success", outcome: "needs_research", reason: "unknown module" };
      },
    });
    const run = createRun(rt, "loop");
    const result = await engine.execute(run.id, owner);
    expect(result.run.state).toBe("WAITING_HUMAN");
    expect(result.exitCode).toBe(10);
    expect(result.run.stateReason).toContain("exhausted");
    expect(impactCalls).toBe(3);
    expect(result.run.iterations).toEqual({ "impact->research#needs_research": 2 });
    expect(rt.history.list(run.id).map((h) => `${h.stepId}#${h.iteration}`)).toEqual([
      "research#1",
      "impact#1",
      "research#2",
      "impact#2",
      "research#3",
      "impact#3",
    ]);
    expect(
      rt.artifacts.versions(rt.artifacts.find(run.id, "research", "research.md")?.artifactId as string),
    ).toHaveLength(3);
    expect(rt.artifacts.listLatest(run.id, "loop-exhausted")).toHaveLength(1);
  });

  it("deletes scratch files an agent left and says so in the step's line", async () => {
    const wf = workflowOf({
      name: "scratch",
      entry: "work",
      steps: [{ id: "work", kind: "agentic", agent: "work", transitions: { onSuccess: "DONE" } }],
    });
    const left = ["tmp-a.txt", "tmp-b.txt", "probe.txt", "x-probe2.txt"];
    const engine = engineFor(rt, [wf], { work: async () => ({ status: "success" }) }, undefined, {
      async open(ref) {
        return {
          ref,
          checkpoint: async () => undefined,
          restore: async () => {},
          sweepScratch: async () => left,
        };
      },
    });
    const run = createRun(rt, "scratch");
    expect((await engine.execute(run.id, owner)).run.state).toBe("COMPLETED");
    const journey = new Journey(["work"]);
    const lines = rt.events.list({ runId: run.id }).flatMap((e) => journey.push(e));
    const step = lines.find((l) => l.kind === "step");
    expect(step?.kind === "step" && step.report.scratchRemoved).toEqual(left);
    if (step?.kind !== "step") throw new Error("no step line");
    expect(formatStepReport(step.report, [], createStyle(false))[1]).toBe(
      "  removed scratch files the agent left: tmp-a.txt, tmp-b.txt, probe.txt +1",
    );
  });

  it("runs the step of a used-up loop again as a fresh round after the person fixed it", async () => {
    const wf = workflowOf({
      name: "loop",
      entry: "work",
      steps: [
        { id: "work", kind: "agentic", agent: "work", transitions: { onSuccess: "verify" } },
        {
          id: "verify",
          kind: "agentic",
          agent: "verify",
          transitions: {
            onSuccess: "DONE",
            onOutcome: { defects_found: { to: "work", maxIterations: 1 } },
          },
        },
      ],
    });
    let fixed = false;
    const seen: string[] = [];
    const engine = engineFor(rt, [wf], {
      work: async () => ({ status: "success" }),
      verify: async (ctx) => {
        seen.push(`${ctx.iteration}:${ctx.restored ? "restored" : "fresh"}`);
        ctx.saveCheckpoint({ toolCalls: 40 });
        return fixed
          ? { status: "success" }
          : { status: "success", outcome: "defects_found", reason: "lint: no final newline" };
      },
    });
    const run = createRun(rt, "loop");
    const parked = await engine.execute(run.id, owner);
    expect(parked.run.waitingFor).toMatchObject({ kind: "loop" });
    expect(parked.run).toMatchObject({ currentStep: "verify", currentIteration: 2 });
    fixed = true;
    const resumed = await engine.execute(run.id, owner);
    expect(resumed.run.state).toBe("COMPLETED");
    expect(seen).toEqual(["1:fresh", "2:fresh", "3:fresh"]);
  });

  it("gives the step a used-up edge went back to one more round, then the step that stopped", async () => {
    const wf = workflowOf({
      name: "loop",
      entry: "work",
      steps: [
        { id: "work", kind: "agentic", agent: "work", transitions: { onSuccess: "verify" } },
        {
          id: "verify",
          kind: "agentic",
          agent: "verify",
          transitions: {
            onSuccess: "DONE",
            onOutcome: { defects_found: { to: "work", maxIterations: 1 } },
          },
        },
      ],
    });
    const seen: string[] = [];
    let rounds = 0;
    const engine = engineFor(rt, [wf], {
      work: async (ctx) => {
        rounds++;
        seen.push(`work ${ctx.iteration}`);
        return { status: "success" };
      },
      verify: async (ctx) => {
        seen.push(`verify ${ctx.iteration}`);
        return rounds >= 3
          ? { status: "success" }
          : { status: "success", outcome: "defects_found", reason: "the route is not registered" };
      },
    });
    const run = createRun(rt, "loop");
    const parked = await engine.execute(run.id, owner);
    expect(parked.run.waitingFor).toMatchObject({ kind: "loop", detail: "verify->work#defects_found" });
    requestRerun(rt, parked.run, ACTOR, "ui", "work");
    const resumed = await engine.execute(run.id, owner);
    expect(resumed.run.state).toBe("COMPLETED");
    expect(seen).toEqual(["work 1", "verify 1", "work 2", "verify 2", "work 3", "verify 3"]);
  });

  it("Pause from another process parks the run at the next step and Resume goes on there", async () => {
    const wf = workflowOf({
      name: "paused",
      entry: "one",
      steps: [
        { id: "one", kind: "agentic", agent: "one", transitions: { onSuccess: "two" } },
        { id: "two", kind: "agentic", agent: "two", transitions: { onSuccess: "DONE" } },
      ],
    });
    const seen: string[] = [];
    const engine = engineFor(rt, [wf], {
      one: async (ctx) => {
        seen.push("one");
        requestPause(rt, ctx.run, "user:dev@example.com", "ui");
        expect(ctx.pauseRequested?.()).toEqual({ by: "dev@example.com", seq: expect.any(Number) });
        return { status: "success" };
      },
      two: async () => {
        seen.push("two");
        return { status: "success" };
      },
    });
    const run = createRun(rt, "paused");
    const parked = await engine.execute(run.id, owner);
    expect(parked.run).toMatchObject({ state: "SUSPENDED", currentStep: "two" });
    expect(parked.run.stateReason).toContain("paused by dev@example.com");
    expect(pauseRequested(rt, run.id)).toBeUndefined();
    const resumed = await engine.execute(run.id, owner);
    expect(resumed.run.state).toBe("COMPLETED");
    expect(seen).toEqual(["one", "two"]);
  });

  it("parks on the approval gate, resumes after approval, and re-parks after a human edit", async () => {
    const wf = workflowOf({
      name: "gate",
      entry: "spec",
      steps: [
        {
          id: "spec",
          kind: "agentic",
          agent: "spec",
          outputs: ["spec"],
          transitions: { onSuccess: "approve" },
        },
        { id: "approve", kind: "approval", artifactType: "spec", transitions: { onSuccess: "DONE" } },
      ],
    });
    const engine = engineFor(rt, [wf], { spec: async (ctx) => writeArtifact(ctx, "spec", "# spec") });
    const run = createRun(rt, "gate");
    const parked = await engine.execute(run.id, owner);
    expect(parked.run.state).toBe("WAITING_HUMAN");
    expect(parked.exitCode).toBe(10);
    expect(rt.checkpoints.latest(run.id)).toMatchObject({
      kind: "suspend",
      stepId: "approve",
      state: { awaitingApproval: { type: "spec", version: 1 } },
    });
    expect(rt.history.list(run.id).at(-1)).toMatchObject({
      stepId: "approve",
      status: "suspended",
      outcome: "WAITING_HUMAN",
    });

    const spec = rt.artifacts.find(run.id, "spec", "spec.md");
    if (!spec) throw new Error("spec");
    rt.artifacts.recordHumanEdit(spec.artifactId, "# spec, edited", ACTOR);
    rt.artifacts.approve({
      runId: run.id,
      stepId: "approve",
      artifactId: spec.artifactId,
      version: 1,
      actor: ACTOR,
      decision: "approve",
    });
    const stillParked = await engine.execute(run.id, owner);
    expect(stillParked.run.state).toBe("WAITING_HUMAN"); // approval was for v1, latest is v2

    rt.artifacts.approve({
      runId: run.id,
      stepId: "approve",
      artifactId: spec.artifactId,
      version: 2,
      actor: ACTOR,
      decision: "approve",
    });
    const done = await engine.execute(run.id, owner);
    expect(done.run.state).toBe("COMPLETED");
    expect(rt.history.list(run.id).filter((h) => h.stepId === "spec")).toHaveLength(1);
  });

  it("parks on quota exhaustion with resumeAfter and resumes from the intra-step checkpoint", async () => {
    const wf = workflowOf({
      name: "quota",
      entry: "work",
      steps: [{ id: "work", kind: "agentic", agent: "work", transitions: { onSuccess: "DONE" } }],
    });
    let attempt = 0;
    const now = new Date("2026-10-03T12:00:00Z");
    const engine = engineFor(
      rt,
      [wf],
      {
        work: async (ctx) => {
          attempt += 1;
          if (attempt === 1) {
            ctx.saveCheckpoint({ toolCalls: 3 });
            throw new ModelError("quota_exhausted", "pool corp exhausted", {
              retryAfterMs: 5 * 60_000,
              modelId: "flash",
            });
          }
          expect(ctx.restored).toEqual({ toolCalls: 3 });
          return { status: "success" };
        },
      },
      () => now,
    );
    const run = createRun(rt, "quota");
    const parked = await engine.execute(run.id, owner);
    expect(parked.run.state).toBe("WAITING_BUDGET");
    expect(parked.exitCode).toBe(11);
    const ckp = rt.checkpoints.latest(run.id);
    expect(ckp?.kind).toBe("suspend");
    expect(ckp?.state.resumeAfter).toBe("2026-10-03T12:05:00.000Z");
    expect(rt.runs.resumable().map((r) => r.id)).toEqual([run.id]);

    const resumed = await engine.execute(run.id, owner);
    expect(resumed.run.state).toBe("COMPLETED");
    expect(attempt).toBe(2);
  });

  it("waits for a model that is down instead of failing, and gives up after modelWait.giveUpAfterHours", async () => {
    const wf = workflowOf({
      name: "outage",
      entry: "work",
      steps: [{ id: "work", kind: "agentic", agent: "work", transitions: { onSuccess: "DONE" } }],
    });
    let now = new Date("2026-10-03T12:00:00Z");
    const down = () => {
      throw new ModelError("transient", "model flash: provider error (500): upstream", { modelId: "flash" });
    };
    const engine = engineFor(rt, [wf], { work: async () => down() }, () => now);
    const run = createRun(rt, "outage");

    const parked = await engine.execute(run.id, owner);
    expect(parked.run.state).toBe("WAITING_BUDGET");
    expect(parked.run.waitingFor).toEqual({ kind: "model", detail: "flash" });
    expect(parked.run.stateReason).toBe("model flash is unavailable: provider error (500)");
    const first = rt.checkpoints.latest(run.id)?.state;
    expect(first?.resumeAfter).toBe("2026-10-03T12:05:00.000Z");
    expect(first?.modelUnavailable).toEqual({
      since: "2026-10-03T12:00:00.000Z",
      reason: "provider error (500)",
      checks: 1,
    });

    // still down: the outage goes on from the same moment
    now = new Date("2026-10-03T12:06:00Z");
    await engine.execute(run.id, owner);
    expect(rt.checkpoints.latest(run.id)?.state.modelUnavailable).toMatchObject({
      since: "2026-10-03T12:00:00.000Z",
      checks: 2,
    });

    // twelve hours later the run fails as it used to
    now = new Date("2026-10-04T00:00:01Z");
    const failed = await engine.execute(run.id, owner);
    expect(failed.run.state).toBe("FAILED");
    expect(failed.run.stateReason).toContain("provider error (500)");
  });

  it("Ctrl-C parks the run where it is (SUSPENDED, exit 130) and continue goes on from there", async () => {
    const wf = workflowOf({
      name: "two",
      entry: "a",
      steps: [
        { id: "a", kind: "agentic", agent: "a", transitions: { onSuccess: "b" } },
        { id: "b", kind: "agentic", agent: "b", transitions: { onSuccess: "DONE" } },
      ],
    });
    const ran: string[] = [];
    const engine = engineFor(rt, [wf], {
      a: async () => {
        ran.push("a");
        interruption.request(); // the person pressed Ctrl-C while step a was running
        return { status: "success" };
      },
      b: async () => {
        ran.push("b");
        return { status: "success" };
      },
    });
    const run = createRun(rt, "two");
    try {
      const stopped = await engine.execute(run.id, owner);
      expect(stopped.run.state).toBe("SUSPENDED");
      expect(stopped.exitCode).toBe(130);
      expect(stopped.run.currentStep).toBe("b");
      expect(ran).toEqual(["a"]);
    } finally {
      interruption.reset();
    }
    const resumed = await engine.execute(run.id, owner);
    expect(resumed.run.state).toBe("COMPLETED");
    expect(ran).toEqual(["a", "b"]);
  });

  it("fails the run on step failure and allows a retry via resume", async () => {
    const wf = workflowOf({
      name: "flaky",
      entry: "a",
      steps: [{ id: "a", kind: "agentic", agent: "a", transitions: { onSuccess: "DONE" } }],
    });
    let calls = 0;
    const engine = engineFor(rt, [wf], {
      a: async () => {
        calls += 1;
        return calls === 1 ? { status: "failure", reason: "boom" } : { status: "success" };
      },
    });
    const run = createRun(rt, "flaky");
    const failed = await engine.execute(run.id, owner);
    expect(failed.run.state).toBe("FAILED");
    expect(failed.run.stateReason).toBe("boom");
    expect(failed.exitCode).toBe(1);
    const retried = await engine.execute(run.id, owner);
    expect(retried.run.state).toBe("COMPLETED");
  });

  it("stops at a safe point when cancel was requested and treats undeclared outcomes as failures", async () => {
    const wf = workflowOf({
      name: "cancel",
      entry: "a",
      steps: [
        { id: "a", kind: "agentic", agent: "a", transitions: { onSuccess: "b" } },
        { id: "b", kind: "agentic", agent: "b", transitions: { onSuccess: "DONE" } },
      ],
    });
    const engine = engineFor(rt, [wf], {
      a: async (ctx) => {
        rt.runs.requestCancel(ctx.run.id);
        return { status: "success" };
      },
      b: async () => ({ status: "success" }),
    });
    const run = createRun(rt, "cancel");
    const result = await engine.execute(run.id, owner);
    expect(result.run.state).toBe("CANCELLED");
    expect(rt.history.list(run.id).map((h) => h.stepId)).toEqual(["a"]);

    // an agent that stops between its calls on the cancel: the run is cancelled, not failed
    const mid = workflowOf({
      name: "mid",
      entry: "a",
      steps: [{ id: "a", kind: "agentic", agent: "a", transitions: { onSuccess: "DONE" } }],
    });
    const engine3 = engineFor(rt, [mid], {
      a: async (ctx) => {
        rt.runs.requestCancel(ctx.run.id);
        return { status: "failure", reason: "cancel requested" };
      },
    });
    const run3 = createRun(rt, "mid");
    const r3 = await engine3.execute(run3.id, owner);
    expect(r3.run.state).toBe("CANCELLED");
    expect(r3.run.stateReason).toBe("cancelled at a safe point");

    const wild = workflowOf({
      name: "wild",
      entry: "a",
      steps: [{ id: "a", kind: "agentic", agent: "a", transitions: { onSuccess: "DONE" } }],
    });
    const engine2 = engineFor(rt, [wild], { a: async () => ({ status: "success", outcome: "go_wild" }) });
    const run2 = createRun(rt, "wild");
    const r2 = await engine2.execute(run2.id, owner);
    expect(r2.run.state).toBe("FAILED");
    expect(r2.run.stateReason).toContain("undeclared outcome");
  });

  it("refuses to run a run another process holds unless the lease is stolen", async () => {
    const wf = workflowOf({
      name: "held",
      entry: "a",
      steps: [{ id: "a", kind: "agentic", agent: "a", transitions: { onSuccess: "DONE" } }],
    });
    const engine = engineFor(rt, [wf], { a: async () => ({ status: "success" }) });
    const run = createRun(rt, "held");
    rt.runs.acquireLease(run.id, "daemon:other", 90_000);
    await expect(engine.execute(run.id, owner)).rejects.toBeInstanceOf(LeaseHeldError);
    const stolen = await engine.execute(run.id, { ...owner, steal: true });
    expect(stolen.run.state).toBe("COMPLETED");
  });

  it("runs composite children in parallel and propagates their outcome", async () => {
    const wf = workflowOf({
      name: "composite",
      entry: "verify",
      steps: [
        {
          id: "verify",
          kind: "composite",
          children: ["t1", "t2"],
          transitions: { onSuccess: "DONE", onOutcome: { defects_found: { to: "fix", maxIterations: 1 } } },
        },
        { id: "t1", kind: "agentic", agent: "t1" },
        { id: "t2", kind: "agentic", agent: "t2" },
        { id: "fix", kind: "agentic", agent: "fix", transitions: { onSuccess: "verify" } },
      ],
    });
    let fixed = false;
    const engine = engineFor(rt, [wf], {
      t1: async () => ({ status: "success" }),
      t2: async () => (fixed ? { status: "success" } : { status: "success", outcome: "defects_found" }),
      fix: async () => {
        fixed = true;
        return { status: "success" };
      },
    });
    const run = createRun(rt, "composite");
    const result = await engine.execute(run.id, owner);
    expect(result.run.state).toBe("COMPLETED");
    expect(rt.history.list(run.id).map((h) => h.stepId)).toEqual([
      "verify",
      "t1",
      "t2",
      "fix",
      "verify",
      "t1",
      "t2",
    ]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import { ACTOR, createRun, engineFor, testRuntime, workflowOf, writeArtifact } from "../helpers/engine.ts";
import { completion, type FakeOpenAi, startFakeOpenAi } from "../helpers/fakeOpenAi.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let server: FakeOpenAi;
let rt: Runtime | undefined;

beforeEach(async () => {
  sb = sandbox();
  server = await startFakeOpenAi();
});
afterEach(async () => {
  await rt?.close();
  await server.close();
  sb.cleanup();
});

function userConfig(): string {
  return `version: 1
models:
  flash:
    provider: openai-compatible
    baseUrl: ${server.baseUrl}
    model: flash
    egress: private
    contextWindow: 8000
    maxOutput: 100
roles:
  work: { models: [flash] }
`;
}

const owner = { owner: "cli:test:1" };

describe("per-run / per-step budget (ADR-0018 §4)", () => {
  it("parks the run for a human when the step cap is exceeded, independent of the provider pool", async () => {
    sb.write("home/.jarvis/config.yaml", userConfig());
    sb.write(
      "project/.jarvis/project.yaml",
      "version: 1\nbudget:\n  perStep: { outputTokens: 20 }\n  perRun: { requests: 100 }\n",
    );
    rt = await testRuntime(sb);
    server.respond(() => completion("ok")); // 7 output tokens per call
    const wf = workflowOf({
      name: "b",
      entry: "work",
      steps: [{ id: "work", kind: "agentic", agent: "work", transitions: { onSuccess: "DONE" } }],
    });
    let calls = 0;
    const engine = engineFor(rt, [wf], {
      work: async (ctx) => {
        for (;;) {
          calls += 1;
          await ctx.gateway.call({
            modelId: "flash",
            role: "work",
            messages: [{ role: "user", content: "go" }],
          });
        }
      },
    });
    const run = createRun(rt, "b");
    const result = await engine.execute(run.id, owner);
    expect(result.run.state).toBe("WAITING_HUMAN");
    expect(result.run.stateReason).toContain("budget.perStep.outputTokens exceeded");
    expect(calls).toBe(4); // 0, 7, 14 used → allowed; 21 ≥ 20 → refused
    expect(server.requests).toHaveLength(3);
    expect(rt.checkpoints.latest(run.id)?.state).toMatchObject({
      budget: { scope: "perStep", dimension: "outputTokens" },
    });
    const calls_ = rt.events.list({ runId: run.id, kind: "model.call" });
    expect(calls_[0]?.stepId).toBe("work");
  });
});

describe("human gate modes (ADR-0009 §2, §4)", () => {
  const gate = workflowOf({
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
      {
        id: "approve",
        kind: "approval",
        artifactType: "spec",
        transitions: { onSuccess: "DONE", onOutcome: { request_changes: { to: "spec", maxIterations: 2 } } },
      },
    ],
  });
  const agents = {
    spec: async (ctx: Parameters<typeof writeArtifact>[0]) =>
      writeArtifact(ctx, "spec", `# spec ${ctx.iteration}`),
  };

  it("humanGate: fail in a non-interactive profile fails the run with exit 1", async () => {
    sb.write(
      "project/.jarvis/project.yaml",
      "version: 1\nprofiles:\n  ci: { interactive: false, humanGate: fail }\n",
    );
    rt = await testRuntime(sb, { JARVIS_PROFILE: "ci" });
    const engine = engineFor(rt, [gate], agents);
    const run = createRun(rt, "gate");
    const result = await engine.execute(run.id, owner);
    expect(result.run.state).toBe("FAILED");
    expect(result.run.stateReason).toContain("humanGate: fail");
  });

  it("humanGate: artifact (default) parks with exit 10 even when non-interactive", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\nprofiles:\n  ci: { interactive: false }\n");
    rt = await testRuntime(sb, { JARVIS_PROFILE: "ci" });
    const engine = engineFor(rt, [gate], agents);
    const run = createRun(rt, "gate");
    const result = await engine.execute(run.id, owner);
    expect(result.run.state).toBe("WAITING_HUMAN");
    expect(result.exitCode).toBe(10);
  });

  it("skip-if-approved passes the gate from a committed approval matching the content hash", async () => {
    sb.write(
      "project/.jarvis/project.yaml",
      "version: 1\nprofiles:\n  ci: { interactive: false, humanGate: skip-if-approved }\n",
    );
    rt = await testRuntime(sb, { JARVIS_PROFILE: "ci" });
    const engine = engineFor(rt, [gate], agents);
    const run = createRun(rt, "gate", "ABC-7");
    // First pass: no committed approval → parks.
    const parked = await engine.execute(run.id, owner);
    expect(parked.run.state).toBe("WAITING_HUMAN");
    const spec = rt.artifacts.find(run.id, "spec", "spec.md");
    if (!spec) throw new Error("spec");
    // Commit an approval for a *different* content → still parked.
    sb.write(
      "project/.jarvis/approvals/ABC-7/spec.json",
      JSON.stringify({
        artifactId: spec.artifactId,
        version: 1,
        contentRef: "0".repeat(64),
        decision: "approve",
      }),
    );
    expect((await engine.execute(run.id, owner)).run.state).toBe("WAITING_HUMAN");
    // Commit the right one → passes.
    sb.write(
      "project/.jarvis/approvals/ABC-7/spec.json",
      JSON.stringify({
        artifactId: spec.artifactId,
        version: 1,
        contentRef: spec.contentRef,
        decision: "approve",
      }),
    );
    const done = await engine.execute(run.id, owner);
    expect(done.run.state).toBe("COMPLETED");
    expect(rt.events.list({ runId: run.id, kind: "approval.committed" })).toHaveLength(1);
  });

  it("request_changes with a comment goes back along the declared edge; reject fails the run", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\n");
    rt = await testRuntime(sb);
    const engine = engineFor(rt, [gate], agents);
    const run = createRun(rt, "gate");
    await engine.execute(run.id, owner);
    const spec = rt.artifacts.find(run.id, "spec", "spec.md");
    if (!spec) throw new Error("spec");
    rt.artifacts.approve({
      runId: run.id,
      stepId: "approve",
      artifactId: spec.artifactId,
      version: 1,
      actor: ACTOR,
      decision: "request_changes",
      comment: "add risks",
    });
    const again = await engine.execute(run.id, owner);
    expect(again.run.state).toBe("WAITING_HUMAN"); // spec regenerated as v2, waiting again
    expect(rt.artifacts.latest(spec.artifactId)?.version).toBe(2);
    expect(again.run.iterations).toEqual({ "approve->spec#request_changes": 1 });
    rt.artifacts.approve({
      runId: run.id,
      stepId: "approve",
      artifactId: spec.artifactId,
      version: 2,
      actor: ACTOR,
      decision: "reject",
      comment: "no",
    });
    const rejected = await engine.execute(run.id, owner);
    expect(rejected.run.state).toBe("FAILED");
    expect(rejected.run.stateReason).toContain("rejected by me@corp: no");
  });
});

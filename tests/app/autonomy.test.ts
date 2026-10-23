import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTONOMY_DECIDED } from "../../src/app/autonomy.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { checksAskOf } from "../../src/app/steer.ts";
import { BudgetExceededError } from "../../src/budget/runBudget.ts";
import { createRun, engineFor, testRuntime, workflowOf, writeArtifact } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** An autonomous run (experimental): where a person would be asked, a fixed rule decides and says so. */
let sb: Sandbox;
let rt: Runtime;
const owner = { owner: "cli:test:1" };

beforeEach(async () => {
  sb = sandbox();
  sb.write("project/.jarvis/project.yaml", "version: 1\n");
  rt = await testRuntime(sb);
});
afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

const AUTO = { autonomous: true as const };
const decided = (runId: string) =>
  rt.events.list({ runId, kind: AUTONOMY_DECIDED }).map((e) => e.payload?.what);

const gated = workflowOf({
  name: "gated",
  entry: "requirements",
  steps: [
    {
      id: "requirements",
      kind: "agentic",
      agent: "requirements",
      outputs: ["requirements"],
      transitions: { onSuccess: "approve" },
    },
    {
      id: "approve",
      kind: "approval",
      artifactType: "requirements",
      transitions: {
        onSuccess: "DONE",
        onOutcome: { request_changes: { to: "requirements", maxIterations: 2 } },
      },
    },
  ],
});

describe("an autonomous run", () => {
  it("passes a gate without a person and says so; a run with a person still waits", async () => {
    const agents = {
      requirements: async (ctx: Parameters<typeof writeArtifact>[0]) =>
        writeArtifact(ctx, "requirements", "{}"),
    };
    const engine = engineFor(rt, [gated], agents);
    const auto = createRun(rt, "gated", "ABC-1", AUTO);
    expect((await engine.execute(auto.id, owner)).run.state).toBe("COMPLETED");
    expect(decided(auto.id)).toEqual(["gate"]);
    const event = rt.events.list({ runId: auto.id, kind: AUTONOMY_DECIDED })[0];
    expect(event?.actor).toBe("service:autonomous");
    expect(event?.onBehalfOf).toBe("user:me@corp");

    const manual = createRun(rt, "gated");
    expect((await engine.execute(manual.id, owner)).run.state).toBe("WAITING_HUMAN");
  });

  it("answers an agent's question with the most cautious assumption and runs the step again", async () => {
    const seen: string[] = [];
    let calls = 0;
    const engine = engineFor(rt, [gated], {
      requirements: async (ctx) => {
        calls += 1;
        const rules = rt.artifacts.listLatest(ctx.run.id, "clarification");
        seen.push(rules.length > 0 ? rt.artifacts.text(rules[0] as never) : "");
        return calls === 1
          ? writeArtifact(
              ctx,
              "requirements",
              JSON.stringify({ clarification: { question: "Round before or after the discount?" } }),
              "needs_clarification",
            )
          : writeArtifact(ctx, "requirements", "{}");
      },
    });
    const run = createRun(rt, "gated", "ABC-2", AUTO);
    expect((await engine.execute(run.id, owner)).run.state).toBe("COMPLETED");
    expect(calls).toBe(2);
    expect(seen[1]).toContain("most cautious reading");
    expect(seen[1]).toContain("Round before or after the discount?");
    expect(rt.interactions.listForRun(run.id)).toEqual([]);
    expect(decided(run.id)).toEqual(["assumption", "gate"]);
  });

  it("ends as FAILED when the agent still asks after the assumption", async () => {
    const engine = engineFor(rt, [gated], {
      requirements: async (ctx) => writeArtifact(ctx, "requirements", "{}", "needs_clarification"),
    });
    const run = createRun(rt, "gated", "ABC-3", AUTO);
    const done = await engine.execute(run.id, owner);
    expect(done.run.state).toBe("FAILED");
    expect(done.run.stateReason).toContain("still needs a person's answer");
  });

  it("ends as FAILED when a back edge's rounds are used up, not waiting for a person", async () => {
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
          transitions: {
            onSuccess: "DONE",
            onOutcome: { needs_research: { to: "research", maxIterations: 1 } },
          },
        },
      ],
    });
    const engine = engineFor(rt, [wf], {
      research: async (ctx) => writeArtifact(ctx, "research", "r"),
      impact: async () => ({ status: "success", outcome: "needs_research" }),
    });
    const run = createRun(rt, "loop", "ABC-4", AUTO);
    const done = await engine.execute(run.id, owner);
    expect(done.run.state).toBe("FAILED");
    expect(done.run.stateReason).toContain("autonomous: back edge impact->research#needs_research exhausted");
    expect(rt.artifacts.listLatest(run.id, "loop-exhausted")).toHaveLength(1);
    expect(decided(run.id)).toEqual(["stopped"]);
  });

  it("ends as FAILED on a spent budget instead of waiting for more", async () => {
    const engine = engineFor(rt, [gated], {
      requirements: async () => {
        throw new BudgetExceededError("perRun", "outputTokens", 120, 100);
      },
    });
    const run = createRun(rt, "gated", "ABC-5", AUTO);
    const done = await engine.execute(run.id, owner);
    // the budget judge weighs it: no model here, so no more — requirements is analysis, the run ends
    expect(done.run.state).toBe("FAILED");
    expect(done.run.stateReason).toContain("the budget judge said no: the judge could not answer");
    expect(decided(run.id)).toEqual(["budget"]);
  });

  it("takes every round of failed checks before it stops", () => {
    const auto = createRun(rt, "gated", "ABC-6", AUTO);
    const manual = createRun(rt, "gated", "ABC-7");
    expect(checksAskOf(rt, auto.id)).toBe("when-rounds-end");
    expect(checksAskOf(rt, manual.id)).toBe("same-failure");
  });
});

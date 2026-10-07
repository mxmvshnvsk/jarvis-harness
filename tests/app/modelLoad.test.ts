import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { modelsHealthOf } from "../../src/app/modelHealth.ts";
import { modelLoadOf } from "../../src/app/modelLoad.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { modelsPopover } from "../../src/ui/pages.ts";
import { ACTOR, testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let rt: Runtime;
beforeEach(async () => {
  sb = sandbox();
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  rt = await testRuntime(sb, {});
});
afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

const live = (task: string) => {
  const run = rt.runs.create({
    task,
    workflow: "research",
    owner: ACTOR,
    workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
    dataClass: "internal",
  });
  rt.runs.transition(run.id, "RUNNING");
  rt.runs.acquireLease(run.id, "cli:t", 60_000);
  const at = { runId: run.id, stepId: "research", iteration: 1 };
  rt.events.emit({
    kind: "step.start",
    ...at,
    payload: { stepId: "research", iteration: 1, kind: "agentic" },
  });
  rt.events.emit({ kind: "agent.start", ...at, payload: { agent: "research", modelId: "flash" } });
  return { run, at };
};

describe("model requests at once, over every run (what a pool's concurrency limit would cap)", () => {
  it("now: the live runs whose step waits for the model; not one running the tools of its answer", () => {
    const a = live("ABC-1: order card");
    const b = live("ABC-2: billing rounding");
    const c = live("ABC-3: delivery slots");
    rt.events.emit({
      kind: "tool.batch",
      ...c.at,
      payload: {
        modelCall: 1,
        size: 2,
        parallel: true,
        calls: [
          { capability: "repo.read", args: "{}" },
          { capability: "repo.read", args: "{}" },
        ],
      },
    });
    const load = modelLoadOf(rt);
    expect(load.inFlight.map((f) => f.run).sort()).toEqual(
      [a.run.id, b.run.id].map((id) => id.slice(4, 12)).sort(),
    );
    expect(load.inFlight[0]).toMatchObject({ step: "research", modelId: "flash" });
  });

  it("the peak today from the answers' ends and latencies; back-to-back calls are not at once", () => {
    const { at } = live("ABC-4: totals");
    const t = Date.now();
    const call = (endAgo: number, latency: number) =>
      rt.events.emit({
        kind: "model.call",
        ...at,
        ts: new Date(t - endAgo).toISOString(),
        payload: { latencyMs: latency },
      } as never);
    // three overlap from t−65s; two more touch end to start only
    call(40_000, 30_000);
    call(45_000, 20_000);
    call(50_000, 15_000);
    call(10_000, 5_000);
    call(5_000, 5_000);
    const load = modelLoadOf(rt);
    expect(load.peak?.count).toBe(3);
    expect(Date.parse(load.peak?.at as string)).toBe(t - 65_000);
    const pop = modelsPopover(modelsHealthOf(rt)).value;
    expect(pop).toContain("<b>At once</b>");
    expect(pop).toMatch(/1 request now · peak today 3 at \d\d:\d\d/);
  });
});

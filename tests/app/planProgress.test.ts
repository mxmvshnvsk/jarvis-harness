import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planProgressOf } from "../../src/app/planProgress.ts";
import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import type { Run } from "../../src/core/domain/run.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** Where an implementation is in its plan: the agent's marks first, the files it wrote when it gives none. */
let sb: Sandbox;
let rt: Runtime;
let run: Run;
const DEV = { kind: "user" as const, id: "dev@example.com", verified: false };

beforeEach(async () => {
  sb = sandbox();
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: dev@example.com }\n");
  sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace: { mode: cwd }\n");
  rt = createRuntime(await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} }), { env: {} });
  run = rt.runs.create({
    task: "ABC-42",
    workflow: "sdd",
    owner: DEV,
    workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
    dataClass: "internal",
  });
  rt.runs.update(run.id, { currentStep: "implementation", currentIteration: 1 });
  run = rt.runs.get(run.id) as Run;
  rt.artifacts.put({
    runId: run.id,
    type: "plan",
    name: "plan.json",
    content: JSON.stringify({
      summary: "s",
      steps: [
        { id: "S1", description: "Types for the slots", files: ["src/slots.types.ts"], verification: "tsc" },
        {
          id: "S2",
          description: "Fetch the slots",
          files: ["src/saga.ts", "./src/api.ts"],
          verification: "saga test",
        },
        { id: "S3", description: "Slot picker", files: ["src/picker.tsx"], verification: "picker test" },
      ],
    }),
    provenance: { kind: "agent", agentId: "plan" },
  });
});
afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

const call = (capability: string, args: Record<string, unknown>, ok = true) =>
  rt.events.emit({
    kind: "tool.call",
    runId: run.id,
    stepId: "implementation",
    payload: { capability, ok, args: JSON.stringify(args) },
  });
const progress = () => planProgressOf(rt, run, rt.events.list({ runId: run.id, limit: 1000 }));

describe("plan progress", () => {
  it("starts at the first step; files written finish a step; the agent's mark moves it", () => {
    // a previous attempt of the step does not count
    call("plan.step", { step: "S3", status: "done" });
    rt.events.emit({
      kind: "step.start",
      runId: run.id,
      stepId: "implementation",
      payload: { stepId: "implementation" },
    });
    expect(progress()).toMatchObject({ current: 0, done: 0, outOfOrder: false });
    call("repo.write", { path: "src/slots.types.ts", content: "x" });
    expect(progress()).toMatchObject({ current: 1, done: 1, lastFile: "src/slots.types.ts" });
    // marks by the step's number too; a failed write is not a touch
    call("plan.step", { step: "2", status: "start" });
    call("repo.edit", { path: "src/saga.ts" });
    call("repo.edit", { path: "src/api.ts" }, false);
    const at2 = progress();
    expect(at2?.current).toBe(1);
    expect(at2?.steps[1]).toMatchObject({ status: "on", touched: 1 });
    expect(at2?.steps.map((s) => s.status)).toEqual(["done", "on", "todo"]);
    // ahead of the plan: said
    call("plan.step", { step: "S3", status: "start" });
    expect(progress()).toMatchObject({ current: 2, outOfOrder: true });
    call("plan.step", { step: "S2", status: "done" });
    call("plan.step", { step: "S3", status: "done" });
    const end = progress();
    expect(end?.current).toBeUndefined();
    expect(end?.done).toBe(3);
  });

  it("no plan, no progress", () => {
    rt.runs.update(run.id, { currentStep: "fix-it", currentIteration: 1 });
    const other = rt.runs.create({ ...run, id: undefined } as never);
    expect(planProgressOf(rt, other, [])).toBeUndefined();
  });
});

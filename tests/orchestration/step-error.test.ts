import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import { readLogs } from "../../src/telemetry/log.ts";
import { createRun, engineFor, testRuntime, workflowOf } from "../helpers/engine.ts";
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

describe("an unexpected exception inside a step", () => {
  it("fails the run, and leaves the stack in the journal (cut) and in the log (whole)", async () => {
    const wf = workflowOf({
      name: "explodes",
      entry: "a",
      steps: [{ id: "a", kind: "agentic", agent: "a", transitions: { onSuccess: "DONE" } }],
    });
    const engine = engineFor(rt, [wf], {
      a: async () => {
        throw new TypeError("cannot read properties of undefined (reading 'x')");
      },
    });
    const run = createRun(rt, "explodes");
    const result = await engine.execute(run.id, { owner: "cli:test:1" });
    expect(result.run.state).toBe("FAILED");
    expect(result.run.stateReason).toContain("cannot read properties");

    const event = rt.events.list({ runId: run.id, kind: "step.error" })[0];
    expect(event?.payload).toMatchObject({ stepId: "a", error: "TypeError" });
    expect(String(event?.payload?.stack)).toContain("step-error.test.ts");

    const logs = readLogs(join(sb.home, ".jarvis", "logs"), { level: "error", run: run.id });
    expect(logs.map((l) => l.event)).toEqual(expect.arrayContaining(["step.error", "step.error.detail"]));
    const detail = logs.find((l) => l.event === "step.error.detail");
    expect(detail).toMatchObject({ name: "TypeError", stepId: "a" });
    expect(String(detail?.stack)).toContain("step-error.test.ts");
  });
});

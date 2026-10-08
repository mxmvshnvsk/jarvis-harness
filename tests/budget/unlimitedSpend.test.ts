import { afterEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import { BudgetedGateway, limitedUsageFromEvents } from "../../src/budget/runBudget.ts";
import type { ModelCaller } from "../../src/models/gateway.ts";
import { createRun, testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** What a run spent in its pool's unlimited hours does not count against the day's caps after them. */
let sb: Sandbox;
let rt: Runtime;
afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

const NIGHT_ENDS = new Date("2026-10-08T06:00:00Z");
const free = (_model: string, at: Date) => at < NIGHT_ENDS;

describe("the night's spend after the night", () => {
  it("counts only the calls made outside the unlimited hours, once they are over", async () => {
    sb = sandbox();
    sb.write(
      "project/.jarvis/project.yaml",
      "version: 1\nbudget:\n  perRun: { inputTokens: 1000, requests: 10 }\n",
    );
    rt = await testRuntime(sb);
    const run = createRun(rt, "smoke");
    const call = (ts: string, input: number) =>
      rt.events.emit({
        kind: "model.call",
        ts,
        runId: run.id,
        stepId: "verify",
        iteration: 1,
        payload: { modelId: "flash", promptTokens: input, outputTokens: 10 },
      });
    for (let i = 0; i < 20; i++) call(`2026-10-08T05:${String(10 + i).padStart(2, "0")}:00Z`, 5_000);
    call("2026-10-08T06:01:00Z", 300);
    expect(limitedUsageFromEvents(rt.db.db, free, run.id)).toEqual({
      inputTokens: 300,
      outputTokens: 10,
      requests: 1,
    });
    const inner: ModelCaller = { call: async () => ({}) as never };
    const day = new BudgetedGateway(
      inner,
      rt.db.db,
      rt.loaded.config,
      { runId: run.id, stepId: "verify", iteration: 1 },
      () => 1,
      free,
    );
    expect(() => day.check(1)).not.toThrow();
    // without the hours known, the night counts: the old behaviour, a stop at once
    const blind = new BudgetedGateway(inner, rt.db.db, rt.loaded.config, {
      runId: run.id,
      stepId: "verify",
      iteration: 1,
    });
    expect(() => blind.check(1)).toThrow("perRun");
    // in the hours themselves everything counts against the grown caps
    expect(() => day.check(10)).toThrow("inputTokens");
  });
});

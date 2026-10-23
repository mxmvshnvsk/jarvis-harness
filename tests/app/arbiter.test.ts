import { describe, expect, it } from "vitest";
import { arbitrate } from "../../src/app/arbiter.ts";
import type { BudgetStop } from "../../src/app/budgetStop.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { stallSignalsOf } from "../../src/app/stall.ts";
import type { Run } from "../../src/core/domain/run.ts";

/** The journal of a step that stopped on a limit, and the judge's bounds — no model involved. */
type Ev = {
  kind: string;
  stepId?: string;
  iteration?: number;
  actor?: string;
  payload?: Record<string, unknown>;
};
const call = (capability: string, args: unknown, ok = true): Ev => ({
  kind: "tool.call",
  stepId: "impact",
  iteration: 1,
  payload: { capability, args: JSON.stringify(args), ok },
});
const runtimeWith = (events: Ev[], arbiter = { enabled: true, ceiling: 2, maxGrantsPerStep: 3 }) =>
  ({
    loaded: { config: { human: { arbiter }, roles: {} } },
    events: {
      list: (o: { kind?: string; kinds?: readonly string[] }) =>
        events
          .filter((e) => (o.kind ? e.kind === o.kind : o.kinds ? o.kinds.includes(e.kind) : true))
          .map((e, i) => ({ seq: i + 1, ts: "", ...e })),
    },
  }) as unknown as Runtime;
const run = { id: "run_1", task: "ABC-1 remove the banner" } as Run;
const stop: BudgetStop = {
  scope: "agent",
  dimension: "toolCalls",
  used: 40,
  cap: 40,
  stepId: "impact",
  iteration: 1,
  agent: "impact",
  suggested: 20,
};

describe("what the journal shows at a budget stop", () => {
  it("going round: the same calls again", () => {
    const events = Array.from({ length: 10 }, (_v, i) =>
      call("repo.search", { q: i % 2 === 0 ? "promoBanner" : "gift" }),
    );
    const sig = stallSignalsOf(runtimeWith(events), "run_1", "impact", 1);
    expect(sig.verdict).toBe("loop");
    expect(sig.top[0]).toEqual({ call: 'repo.search {"q":"promoBanner"}', times: 5 });
    expect(sig.summary).toMatch(/^going round: 8 of the last 10 calls repeat earlier ones/);
  });

  it("new work: a new place each call", () => {
    const events = Array.from({ length: 10 }, (_v, i) => call("repo.read", { path: `src/f${i}.ts` }));
    expect(stallSignalsOf(runtimeWith(events), "run_1", "impact", 1).verdict).toBe("progress");
  });

  it("too few calls to tell, or a mix: unclear", () => {
    expect(
      stallSignalsOf(runtimeWith([call("repo.read", { path: "a" })]), "run_1", "impact", 1).verdict,
    ).toBe("unclear");
    // 7 new, 3 again but spread: neither steady nor round
    const mixed = ["f0", "f1", "f0", "f2", "f3", "f1", "f4", "f5", "f2", "f6"].map((p) =>
      call("repo.read", { path: p }),
    );
    expect(stallSignalsOf(runtimeWith(mixed), "run_1", "impact", 1).verdict).toBe("unclear");
  });
});

describe("the budget judge's bounds", () => {
  it("a loop is a no without a model; new work a yes of half the limit", async () => {
    const loop = Array.from({ length: 10 }, () => call("repo.search", { q: "x" }));
    expect(await arbitrate(runtimeWith(loop), run, stop)).toMatchObject({
      grant: false,
      diagnosis: "loop",
      by: "signals",
    });
    const fresh = Array.from({ length: 10 }, (_v, i) => call("repo.read", { path: `f${i}` }));
    expect(await arbitrate(runtimeWith(fresh), run, stop)).toMatchObject({
      grant: true,
      amount: 20,
      by: "signals",
    });
  });

  it("never past the ceiling (×2 of the budget), nor more grants a step than allowed", async () => {
    const fresh = Array.from({ length: 10 }, (_v, i) => call("repo.read", { path: `f${i}` }));
    const granted = (n: number): Ev => ({
      kind: "budget.grant",
      stepId: "impact",
      iteration: 1,
      actor: "service:arbiter",
      payload: { scope: "agent", dimension: "toolCalls", toolCalls: n },
    });
    // 40 = 20 base + 20 granted: the ceiling of 2× the base is reached
    expect(await arbitrate(runtimeWith([...fresh, granted(20)]), run, stop)).toMatchObject({
      grant: false,
      by: "ceiling",
    });
    const three = [...fresh, granted(1), granted(1), granted(1)];
    const capped = await arbitrate(
      runtimeWith(three, { enabled: true, ceiling: 5, maxGrantsPerStep: 3 }),
      run,
      stop,
    );
    expect(capped).toMatchObject({ grant: false, by: "ceiling" });
    expect(capped.why).toContain("maxGrantsPerStep");
  });
});

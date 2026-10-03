import { describe, expect, it } from "vitest";
import { BudgetManager } from "../../src/budget/admission.ts";
import { MemoryUsageStore, windowBounds } from "../../src/budget/usage.ts";
import { QuotaPoolSchema } from "../../src/core/config/schema.ts";

const sliding = QuotaPoolSchema.parse({
  window: { minutes: 20 },
  limits: { outputTokens: 1000, requests: 5, inputTokens: 10_000, concurrency: 3 },
  soft: 0.8,
});
const fixed = QuotaPoolSchema.parse({
  window: { minutes: 60, kind: "fixed" },
  limits: { outputTokens: 100 },
});

const T0 = new Date("2026-10-03T12:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe("windowBounds", () => {
  it("slides with now and aligns fixed windows to the epoch", () => {
    expect(windowBounds(sliding, at(30))).toEqual({ start: at(10), end: at(30) });
    const f = windowBounds(fixed, new Date("2026-10-03T12:37:00Z"));
    expect(f.start.toISOString()).toBe("2026-10-03T12:00:00.000Z");
    expect(f.end.toISOString()).toBe("2026-10-03T13:00:00.000Z");
  });
});

describe("BudgetManager.admit", () => {
  function manager(now: () => Date) {
    const usage = new MemoryUsageStore();
    return { usage, budget: new BudgetManager(usage, { corp: sliding, fixed }, now) };
  }

  it("allows with full concurrency when the window is quiet", () => {
    const { budget } = manager(() => at(0));
    const d = budget.admit({ pool: "corp", estimatedOutputTokens: 100 });
    expect(d).toMatchObject({ allowed: true, soft: false, concurrency: 3, pressure: 0 });
  });

  it("switches to soft mode past the soft threshold", () => {
    const { usage, budget } = manager(() => at(5));
    usage.record({
      pool: "corp",
      model: "m",
      promptTokens: 10,
      cachedTokens: 0,
      outputTokens: 850,
      ts: at(1),
    });
    const d = budget.admit({ pool: "corp", estimatedOutputTokens: 50 });
    expect(d).toMatchObject({ allowed: true, soft: true, concurrency: 1 });
    expect(d.allowed && d.pressure).toBeCloseTo(0.85);
  });

  it("denies when the estimate does not fit and says when the window frees up", () => {
    const { usage, budget } = manager(() => at(5));
    usage.record({
      pool: "corp",
      model: "m",
      promptTokens: 10,
      cachedTokens: 0,
      outputTokens: 950,
      ts: at(1),
    });
    const d = budget.admit({ pool: "corp", estimatedOutputTokens: 100 });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toContain("output tokens");
      // oldest record at +1 min, window 20 min → frees shortly after +21 min
      expect(d.resetAt.getTime()).toBe(at(21).getTime() + 1000);
    }
  });

  it("denies on request count and input tokens", () => {
    const { usage, budget } = manager(() => at(5));
    for (let i = 0; i < 5; i += 1) {
      usage.record({
        pool: "corp",
        model: "m",
        promptTokens: 1,
        cachedTokens: 0,
        outputTokens: 1,
        ts: at(1),
      });
    }
    expect(budget.admit({ pool: "corp", estimatedOutputTokens: 1 })).toMatchObject({ allowed: false });
    const { usage: u2, budget: b2 } = manager(() => at(5));
    u2.record({ pool: "corp", model: "m", promptTokens: 9_990, cachedTokens: 0, outputTokens: 1, ts: at(1) });
    expect(b2.admit({ pool: "corp", estimatedOutputTokens: 1, estimatedPromptTokens: 50 })).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("input tokens"),
    });
  });

  it("forgets usage that left the sliding window", () => {
    const { usage, budget } = manager(() => at(30));
    usage.record({
      pool: "corp",
      model: "m",
      promptTokens: 1,
      cachedTokens: 0,
      outputTokens: 999,
      ts: at(1),
    });
    expect(budget.admit({ pool: "corp", estimatedOutputTokens: 500 })).toMatchObject({ allowed: true });
  });

  it("uses the fixed window end as reset time", () => {
    const now = new Date("2026-10-03T12:37:00Z");
    const { usage, budget } = manager(() => now);
    usage.record({ pool: "fixed", model: "m", promptTokens: 1, cachedTokens: 0, outputTokens: 100, ts: now });
    const d = budget.admit({ pool: "fixed", estimatedOutputTokens: 1 });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.resetAt.toISOString()).toBe("2026-10-03T13:00:00.000Z");
  });

  it("caps the local estimate by provider rate-limit headers until their reset passes", () => {
    let now = at(0);
    const { budget } = manager(() => now);
    budget.observe("corp", { remainingTokens: 10, resetTokensMs: 60_000 });
    expect(budget.admit({ pool: "corp", estimatedOutputTokens: 50 })).toMatchObject({ allowed: false });
    now = at(2);
    expect(budget.admit({ pool: "corp", estimatedOutputTokens: 50 })).toMatchObject({ allowed: true });
  });

  it("treats unknown pools as unlimited", () => {
    const { budget } = manager(() => at(0));
    expect(budget.admit({ pool: "model:x", estimatedOutputTokens: 1_000_000 })).toMatchObject({
      allowed: true,
    });
  });
});

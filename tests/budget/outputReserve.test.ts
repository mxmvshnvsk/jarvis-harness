import { describe, expect, it } from "vitest";
import { OutputReserve, RESERVE } from "../../src/budget/outputReserve.ts";

/** What a call reserves in its pool: the typical answer of its kind, not the whole maxOutput. */
describe("the output reserve", () => {
  const turn = { agentId: "onboard-mapper", role: "research", tools: true };
  const final = { ...turn, tools: false };

  it("without history: the default, never above maxOutput", () => {
    const r = new OutputReserve();
    expect(r.reserve(turn, 16000)).toBe(RESERVE.unknown);
    expect(r.reserve(turn, 500)).toBe(500);
  });

  it("with history: the 95th percentile of the same kind of call, at least the minimum", () => {
    const r = new OutputReserve([
      ...Array.from({ length: 40 }, () => ({ ...turn, outputTokens: 250 })),
      ...Array.from({ length: 10 }, () => ({ ...final, outputTokens: 7000 })),
    ]);
    // tool turns are short: the minimum; final answers are long: their own percentile
    expect(r.reserve(turn, 16000)).toBe(RESERVE.min);
    expect(r.reserve(final, 16000)).toBe(7000);
    // another agent of the same role knows nothing yet
    expect(r.reserve({ ...turn, agentId: "research" }, 16000)).toBe(RESERVE.unknown);
    for (let i = 0; i < 20; i++) r.observe(turn, 3600);
    expect(r.reserve(turn, 16000)).toBe(3600);
    expect(r.reserve(turn, 3000)).toBe(3000);
  });
});

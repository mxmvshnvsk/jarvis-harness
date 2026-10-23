import { describe, expect, it } from "vitest";
import { coverageGaps } from "../../src/agents/coverage.ts";

/** What an analysis leaves uncovered of its step's goal: measured from the artifacts, no model. */
const ctxWith = (artifacts: Record<string, unknown>) =>
  ({
    run: { id: "run_1", task: "ABC-21 remove the gift" },
    runtime: {
      artifacts: {
        listLatest: (_id: string, type: string) => (type in artifacts ? [{ type }] : []),
        text: (a: { type: string }) => JSON.stringify(artifacts[a.type]),
      },
    },
  }) as never;
const spec = {
  requirements: [
    { id: "R1", text: "the banner is gone" },
    { id: "R2", text: "the field is not sent" },
    { id: "R12", text: "the events stay" },
  ],
};

describe("coverage of an analysis", () => {
  it("impact: every requirement has a path, or says where it is", () => {
    const ctx = ctxWith({ spec });
    const doc = {
      affected: [{ path: "src/banner.tsx", kind: "code", reason: "renders it", requirements: ["R1"] }],
      elsewhere: [],
      unknowns: ["R12: the events table belongs to analytics"],
    };
    // R1 by its path, R12 in words (not R1 inside R12), R2 nowhere
    expect(coverageGaps(ctx, "impact", doc)).toEqual([
      "requirement R2 (the field is not sent): no path it affects, nor where it is",
    ]);
    expect(coverageGaps(ctxWith({}), "impact", doc)).toBeUndefined();
  });

  it("plan: every requirement has a step, every code path of the impact is in one", () => {
    const impact = {
      affected: [
        { path: "src/banner.tsx", kind: "code", reason: "r", requirements: ["R1"] },
        { path: "src/save.ts", kind: "code", reason: "r", requirements: ["R2"] },
        { path: "docs/a.md", kind: "docs", reason: "r", requirements: [] },
      ],
    };
    const doc = {
      steps: [
        { id: "S1", description: "remove it (R12 stays)", files: ["./src/banner.tsx"], requirements: ["R1"] },
      ],
    };
    expect(coverageGaps(ctxWith({ spec, impact }), "plan", doc)).toEqual([
      "requirement R2 (the field is not sent): no step implements it",
      "src/save.ts: the impact lists it, no step changes it",
    ]);
  });

  it("research: every task of the Story is accounted for; not measured without a Story", () => {
    const stories = { "story-tasks": { story: "ABC-21", tasks: [{ key: "ABC-19" }, { key: "ABC-17" }] } };
    expect(
      coverageGaps(ctxWith(stories), "research", { findings: [{ detail: "ABC-19 asks the back" }] }),
    ).toEqual(["the Story's task ABC-17: not in the findings, dependencies or unknowns"]);
    expect(coverageGaps(ctxWith({}), "research", { findings: [] })).toBeUndefined();
    expect(coverageGaps(ctxWith({ spec }), "review", {})).toBeUndefined();
  });
});

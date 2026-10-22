import { describe, expect, it } from "vitest";
import { REVIEW_AGENT, REVIEW_ANALYSIS_AGENT } from "../../src/agents/builtin/index.ts";

describe("the outcome follows the verdict", () => {
  it("review: a fix_required verdict with the outcome left at ok is fix_required", () => {
    expect(REVIEW_AGENT.outcomeOf?.({ verdict: "fix_required", outcome: "ok" })).toBe("fix_required");
    expect(REVIEW_AGENT.outcomeOf?.({ verdict: "approve" })).toBe("ok");
    expect(REVIEW_AGENT.output.outcomes).toContain("requirements_wrong");
  });
  it("review analysis: fix_code is fix_required, nothing_to_do is ok, a blocking question stays", () => {
    expect(REVIEW_ANALYSIS_AGENT.outcomeOf?.({ verdict: "fix_code" })).toBe("fix_required");
    expect(REVIEW_ANALYSIS_AGENT.outcomeOf?.({ verdict: "nothing_to_do" })).toBe("ok");
    expect(
      REVIEW_ANALYSIS_AGENT.outcomeOf?.({ verdict: "spec_wrong", outcome: "needs_clarification" }),
    ).toBeUndefined();
  });
});

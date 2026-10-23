import { describe, expect, it } from "vitest";
import { idleNudge } from "../../src/agents/runner.ts";

describe("the nudge of an agent that does not edit", () => {
  it("a later round is told to finish if its work is in the code, not to start the plan", () => {
    expect(idleNudge(12, 1)).toContain("start the first open step of the plan now");
    expect(idleNudge(12, 3)).toBe(
      "12 model calls and no edit yet. Decide now: if what this round is for is already in the code, stop checking and produce the result document, saying so; else make the change it needs.",
    );
    expect(idleNudge(24, 3)).toContain("After 12 more calls without an edit the step stops.");
  });
});

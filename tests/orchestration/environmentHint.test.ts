import { describe, expect, it } from "vitest";
import { environmentHint } from "../../src/orchestration/tools/builtin.ts";

describe("a build broken by its checkout", () => {
  it("says what a person changes (pilot: a Gradle plugin reading git in a worktree, three rounds without a test)", () => {
    expect(
      environmentHint(
        "> Failed to apply plugin class 'SpringBootPlugin'.\n   > Bare Repository has neither a working tree, nor an index",
      ),
    ).toContain("-Pversion=0.0.0");
    expect(environmentHint("expected: <1> but was: <2>")).toBe("");
  });
});

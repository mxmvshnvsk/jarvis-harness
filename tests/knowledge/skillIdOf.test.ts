import { describe, expect, it } from "vitest";
import { skillIdOf } from "../../src/knowledge/sources.ts";

describe("a skill's id from the team's documentation", () => {
  it("drops SKILL_ and .md or .mdx", () => {
    expect(skillIdOf("documentation/app-services/SKILL_app-services.md", new Set())).toBe("app-services");
    expect(skillIdOf("documentation/mdx-docs/metrics/business-events.mdx", new Set())).toBe(
      "business-events",
    );
  });
});

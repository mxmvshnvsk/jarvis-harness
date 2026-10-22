import { describe, expect, it } from "vitest";
import { BUILTIN_AGENTS } from "../../src/agents/builtin/index.ts";
import { systemLayer } from "../../src/agents/context.ts";

describe("the task changes code only", () => {
  it("every agent is told: Confluence and Jira are read, never changed, nor proposed to be (pilot)", () => {
    for (const def of BUILTIN_AGENTS) {
      const layer = systemLayer(def, []);
      expect(layer).toContain("pages and issues outside them — Confluence specifications, Jira issues");
      expect(layer).toContain("Do not propose, plan or ask about updating them");
    }
  });
});

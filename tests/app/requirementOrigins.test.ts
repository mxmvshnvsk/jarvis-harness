import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkOf, originsForPr, originsOf, originsText } from "../../src/app/requirementOrigins.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { recordGiven } from "../../src/interaction/answers.ts";
import { ACTOR, testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let rt: Runtime;

const SOURCES = `# The task's sources

## Issue ABC-42

{"self":"https://jira.example.org/rest/api/2/issue/1001","fields":{"summary":"Remove the discount code field","description":"See https://wiki.example.org/pages/viewpage.action?pageId=777001."}}

## Confluence «Order form requirements» (777001)

3.2 The discount code field is removed from the form.
`;

const SPEC = {
  summary: "s",
  title: "Order form without the discount code",
  goals: ["g"],
  requirements: [
    {
      id: "R3",
      text: "The order form has no discount code field",
      acceptance: ["no field"],
      sources: [
        { ref: "777001", section: "3.2", quote: "The discount code field is removed from the form." },
      ],
    },
    { id: "R4", text: "The order is saved without a discount code", acceptance: ["saved"], sources: [] },
  ],
};

beforeEach(async () => {
  sb = sandbox();
  sb.write("project/.jarvis/project.yaml", "version: 1\n");
  rt = await testRuntime(sb);
});
afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

const put = (runId: string, type: string, content: string) =>
  rt.artifacts.put({
    runId,
    type,
    name: `${type}.json`,
    content,
    mediaType: "application/json",
    provenance: { kind: "agent", agentId: type },
    stepId: type,
  });

describe("where the spec's requirements came from (pilot: «R3 says so» to reviewers who had no R3)", () => {
  it("links a page by its id and an issue by its key from what the sources read", () => {
    expect(linkOf("777001", SOURCES)).toEqual({
      url: "https://wiki.example.org/pages/viewpage.action?pageId=777001",
      title: "Order form requirements",
    });
    expect(linkOf("abc-42", SOURCES)).toEqual({
      url: "https://jira.example.org/browse/ABC-42",
      title: "Remove the discount code field",
    });
    expect(linkOf("999999", SOURCES)).toEqual({});
  });

  it("the accepted spec's requirements with their pages, who accepted it and what was answered at its gate", () => {
    const run = rt.runs.create({
      task: "ABC-42",
      workflow: "sdd",
      owner: ACTOR,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: rt.loaded.config.dataClass,
    });
    put(run.id, "sources", SOURCES);
    const spec = put(run.id, "spec", JSON.stringify(SPEC));
    recordGiven(
      rt,
      spec,
      [{ question: "Keep the discount code in old orders?", mode: "answer", text: "No, drop it everywhere" }],
      "ivan@example.org",
    );
    rt.artifacts.approve({
      runId: run.id,
      stepId: "approve-spec",
      artifactId: spec.artifactId,
      version: spec.version,
      actor: { ...ACTOR, display: "Ivan Petrov" },
      decision: "approve",
    });
    const o = originsOf(rt, run);
    expect(o?.requirements[0]?.sources[0]).toMatchObject({
      section: "3.2",
      title: "Order form requirements",
      url: "https://wiki.example.org/pages/viewpage.action?pageId=777001",
    });
    expect(o?.accepted[0]?.by).toBe("Ivan Petrov");
    expect(o?.answers).toEqual([
      {
        question: "Keep the discount code in old orders?",
        mode: "answer",
        by: "ivan@example.org",
        answer: "No, drop it everywhere",
      },
    ]);
    const text = originsText(o as NonNullable<typeof o>);
    expect(text).toContain(
      "- R3 «The order form has no discount code field» — [Order form requirements](https://wiki.example.org/pages/viewpage.action?pageId=777001), 3.2: «The discount code field is removed from the form.»",
    );
    expect(text).toContain("- R4 «The order is saved without a discount code» — no page or issue says it");
    expect(text).toContain("The spec was accepted by Ivan Petrov on");
    expect(text).toContain(
      "- «Keep the discount code in old orders?» — «No, drop it everywhere» (ivan@example.org)",
    );
    const pr = originsForPr(o as NonNullable<typeof o>) ?? "";
    expect(pr).toContain(
      "Requirements:\n- The order form has no discount code field — [Order form requirements]",
    );
    expect(pr).not.toContain("R3");
    expect(pr).toContain("- «Keep the discount code in old orders?» — «No, drop it everywhere»");
  });
});

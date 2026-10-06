import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import { filesNamedIn } from "../../src/orchestration/tools/builtin.ts";
import { ACTOR, engineFor, testRuntime, workflowOf } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let rt: Runtime;
beforeEach(async () => {
  sb = sandbox();
  sb.write("project/.jarvis/project.yaml", "version: 1\n");
  sb.write("project/package.json", '{ "name": "demo", "devDependencies": { "typescript": "5" } }\n');
  sb.write("project/tsconfig.json", "{}\n");
  sb.write("project/src/a.ts", "export const a = () => 1;\n");
  sb.write("project/src/b.ts", "import { a } from './a';\nexport const b = () => a();\n");
  sb.write("project/src/a.test.ts", "import { a } from './a';\na();\n");
  // the graph reads tracked files
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["commit", "-q", "-m", "init"],
  ])
    execFileSync("git", args, { cwd: sb.project, env });
  rt = await testRuntime(sb);
});
afterEach(async () => {
  await rt.close();
  sb.cleanup();
});

function workflow(specText: string) {
  return workflowOf({
    name: "q",
    entry: "spec",
    steps: [
      {
        id: "spec",
        kind: "deterministic",
        tool: "artifact.write",
        args: { type: "spec", name: "spec.json", content: specText },
        transitions: { onSuccess: "impact" },
      },
      {
        id: "impact",
        kind: "agentic",
        agent: "impact",
        quick: "impact.quick",
        transitions: { onSuccess: "DONE" },
      },
    ],
  });
}

async function runWith(specText: string) {
  let agentCalls = 0;
  const engine = engineFor(rt, [workflow(specText)], {
    impact: async () => {
      agentCalls += 1;
      return { status: "success" };
    },
  });
  const run = rt.runs.create({
    task: "T",
    workflow: "q",
    owner: ACTOR,
    workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
    dataClass: "confidential",
  });
  const result = await engine.execute(run.id, { owner: "cli:test:1" });
  const quick = rt.events.list({ runId: run.id, kind: "step.quick" })[0]?.payload as Record<string, unknown>;
  return { result, agentCalls, quick, runId: run.id };
}

describe("impact without a model (quick: impact.quick)", () => {
  it("finds the repository files a text names", () => {
    expect(filesNamedIn("Fix `src/a.ts:1` (see src/b.ts, src/missing.ts and ../x.ts)", sb.project)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("answers from the spec's file and the code graph, without the agent", async () => {
    const { result, agentCalls, quick, runId } = await runWith(
      JSON.stringify({ summary: "Change `src/a.ts:1` to return 2.", requirements: [] }),
    );
    expect(result.run.state).toBe("COMPLETED");
    expect(agentCalls).toBe(0);
    expect(quick).toMatchObject({ tool: "impact.quick", used: true });
    const impact = rt.artifacts.listLatest(runId, "impact")[0];
    const doc = JSON.parse(rt.artifacts.text(impact as NonNullable<typeof impact>)) as {
      affected: Array<{ path: string; kind: string }>;
      dependencies: string[];
      sources: string[];
    };
    expect(doc.affected).toEqual([
      expect.objectContaining({ path: "src/a.ts", kind: "code" }),
      expect.objectContaining({ path: "src/a.test.ts", kind: "test" }),
    ]);
    expect(doc.dependencies).toEqual(["src/b.ts"]);
    expect(doc.sources[0]).toBe("spec/spec.json@1");
  });

  it("leaves telemetry, documentation and unnamed files to the agent", async () => {
    for (const text of ["Change src/a.ts and record a metric for it.", "Make the form remember its state."]) {
      const { agentCalls, quick } = await runWith(JSON.stringify({ summary: text }));
      expect(agentCalls, text).toBe(1);
      expect(quick).toMatchObject({ used: false });
    }
  });
});

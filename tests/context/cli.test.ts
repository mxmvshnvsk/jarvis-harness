import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_AGENTS } from "../../src/agents/builtin/index.ts";
import { AgentRegistry } from "../../src/agents/definition.ts";
import { AgentRuntimeRunner } from "../../src/agents/runner.ts";
import type { Runtime } from "../../src/app/runtime.ts";
import { run as cli } from "../../src/cli/main.ts";
import { AgenticExecutor, DeterministicExecutor } from "../../src/orchestration/executors.ts";
import { LocalWorkflowEngine } from "../../src/orchestration/runtime.ts";
import { BUILTIN_TOOLS } from "../../src/orchestration/tools/builtin.ts";
import { ACTOR, testRuntime, workflowOf } from "../helpers/engine.ts";
import { completion, type FakeOpenAi, startFakeOpenAi, toolCallCompletion } from "../helpers/fakeOpenAi.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let server: FakeOpenAi;
let rt: Runtime | undefined;
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

const RESEARCH_DOC = {
  summary: "done",
  findings: [{ topic: "t", detail: "d", sources: ["src/big.ts:1"] }],
  affectedAreas: ["src/big.ts"],
  existingImplementations: [],
  unknowns: [],
  sources: ["src/big.ts"],
  reasons: [],
  outcome: "ok",
};

const researchOnly = workflowOf({
  name: "r",
  entry: "research",
  steps: [
    {
      id: "research",
      kind: "agentic",
      agent: "research",
      outputs: ["research"],
      transitions: { onSuccess: "DONE" },
    },
  ],
});

beforeEach(async () => {
  sb = sandbox();
  server = await startFakeOpenAi();
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: sb.project, env: { ...process.env, ...gitEnv } });
  mkdirSync(join(sb.project, "src"), { recursive: true });
  writeFileSync(
    join(sb.project, "src", "big.ts"),
    Array.from({ length: 400 }, (_, i) => `export const value${i} = ${i}; // line ${i}`).join("\n"),
  );
  execFileSync("git", ["add", "-A"], { cwd: sb.project });
  execFileSync("git", ["commit", "-q", "-m", "init"], {
    cwd: sb.project,
    env: { ...process.env, ...gitEnv },
  });
  sb.write(
    "home/.jarvis/config.yaml",
    `version: 1
actor: { id: me@corp }
models:
  flash:
    provider: openai-compatible
    baseUrl: ${server.baseUrl}
    model: flash
    egress: private
    contextWindow: 16000
    maxOutput: 1000
    supports: { tools: true, jsonMode: true }
roles:
  research: { models: [flash] }
`,
  );
  // thresholds high enough that the loop itself never reshapes: the human does it
  sb.write(
    "project/.jarvis/project.yaml",
    "version: 1\nworkspace: { mode: cwd }\ncontext:\n  thresholds:\n    default: { watch: 0.9, compact: 0.92, aggressive: 0.95, reset: 0.99 }\n",
  );
});

afterEach(async () => {
  await rt?.close();
  await server.close();
  sb.cleanup();
});

async function jarvis(args: string[]) {
  let out = "";
  let err = "";
  const code = await cli(["node", "jarvis", ...args], {
    streams: {
      out: new Writable({
        write(c, _e, cb) {
          out += String(c);
          cb();
        },
      }),
      err: new Writable({
        write(c, _e, cb) {
          err += String(c);
          cb();
        },
      }),
    },
    context: { cwd: sb.project, homeDir: sb.home, env: {} },
  });
  return { code, out, err };
}

describe("jarvis context / compact / reset-context", () => {
  it("inspects, plans, compacts and resets the transcript of a parked run, and resume uses the result", async () => {
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    let phase = 0;
    server.respond((req, i) => {
      const system = (req.body.messages as Array<{ content: string }>)[0]?.content ?? "";
      if (system.startsWith("You compress"))
        return completion("## Goal\n- read big.ts\n## Sources\n- src/big.ts");
      if (phase === 0) {
        if (i < 5)
          return toolCallCompletion("repo.read", { path: "src/big.ts", startLine: i + 1, endLine: 400 });
        return { status: 429, body: { error: { message: "insufficient_quota" } } };
      }
      return completion(JSON.stringify(RESEARCH_DOC));
    });
    const registry = new AgentRegistry(BUILTIN_AGENTS, rt.loaded.project?.root);
    const engine = new LocalWorkflowEngine({
      runtime: rt,
      workflows: new Map([[researchOnly.name, researchOnly]]),
      executors: {
        deterministic: new DeterministicExecutor(BUILTIN_TOOLS),
        agentic: new AgenticExecutor(new AgentRuntimeRunner(registry)),
      },
      leaseOptions: { heartbeatMs: 0 },
    });
    const created = rt.runs.create({
      task: "ABC-1",
      workflow: "r",
      owner: ACTOR,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "confidential",
    });
    expect((await engine.execute(created.id, { owner: "cli:t" })).run.state).toBe("WAITING_BUDGET");
    const short = created.id.replace(/^run_/, "").slice(0, 8);

    const view = await jarvis(["context", short]);
    expect(view.code).toBe(0);
    expect(view.out).toMatch(/step research #1\s+model flash/);
    // kept as the parked call saw it: the trim made before that call is in the checkpoint (how many
    // results it trimmed depends on the size of the agent's instructions, not on this test)
    expect(view.out).toMatch(
      /history\s+\d+ tokens\s+10 messages in 5 blocks\s+\(0 handoff, [1-4] trimmed results?\)/,
    );
    expect(view.out).toMatch(/levels\s+watch 90%/);
    const json = JSON.parse((await jarvis(["--json", "context", short])).out) as {
      context: { blocks: number; level: string };
    };
    expect(json.context.blocks).toBe(5);

    const requestsBefore = server.requests.length;
    const dry = await jarvis(["compact", short, "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("dry run — compact would: ");
    expect(server.requests.length).toBe(requestsBefore); // no model call
    expect((await jarvis(["context", short])).out).toContain("(0 handoff");

    const done = await jarvis(["compact", short]);
    expect(done.code).toBe(0);
    expect(done.out).toMatch(/compact: \d+ of 5 blocks → handoff \+ tail, \d+ results? trimmed/);
    expect(done.out).toContain(`jarvis resume ${short}`);
    const after = await jarvis(["context", short]);
    expect(after.out).toMatch(/\(1 handoff, /);
    expect(rt.events.list({ kind: "context.compacted" }).at(-1)?.payload).toMatchObject({ manual: true });

    const reset = await jarvis(["reset-context", short]);
    expect(reset.code).toBe(0);
    expect(reset.out).toContain("handoff only");
    expect((await jarvis(["context", short])).out).toMatch(/1 messages in 1 blocks\s+\(1 handoff/);

    // the resumed step sees the handoff instead of the five tool rounds
    phase = 1;
    const beforeResume = server.requests.length;
    const resumed = await engine.execute(created.id, { owner: "cli:t" });
    expect(resumed.run.state).toBe("COMPLETED");
    const sent = server.requests
      .slice(beforeResume)
      .filter(
        (r) =>
          !((r.body.messages as Array<{ content: string }>)[0]?.content ?? "").startsWith("You compress"),
      );
    // the step's answer is already the result document: one call, no separate finalization
    expect(sent).toHaveLength(1);
    const firstAfter = sent[0]?.body.messages as Array<{ role: string; content: string }>;
    expect(firstAfter.some((m) => m.content?.startsWith("## Context handoff (reset)"))).toBe(true);
    expect(firstAfter.filter((m) => m.role === "tool")).toHaveLength(0);
  });

  it("refuses when there is nothing to reshape or the run is held", async () => {
    rt = await testRuntime(sb, { PATH: process.env.PATH ?? "" });
    const created = rt.runs.create({
      task: "ABC-2",
      workflow: "r",
      owner: ACTOR,
      workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD" },
      dataClass: "confidential",
    });
    const short = created.id.replace(/^run_/, "").slice(0, 8);
    const none = await jarvis(["compact", short]);
    expect(none.code).toBe(1);
    expect(none.err).toContain("no checkpointed agent transcript");
    expect((await jarvis(["context", short])).out).toContain("no checkpointed agent transcript");
    expect((await jarvis(["context", "nope"])).code).toBe(1);
  });
});

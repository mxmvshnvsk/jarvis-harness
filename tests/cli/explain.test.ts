import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.ts";
import {
  type CapturedRequest,
  completion,
  type FakeOpenAi,
  startFakeOpenAi,
  toolCallCompletion,
} from "../helpers/fakeOpenAi.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let server: FakeOpenAi;
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(args: string[], cwd = sb.project): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });
}

beforeEach(async () => {
  sb = sandbox();
  server = await startFakeOpenAi();
  git(["init", "-q", "-b", "main"]);
  mkdirSync(join(sb.project, "src"), { recursive: true });
  writeFileSync(
    join(sb.project, "src", "onboarding.ts"),
    "export function canRestartOnboarding() {\n  return false;\n}\n",
  );
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
    contextWindow: 32000
    maxOutput: 2000
    supports: { tools: true, jsonMode: true }
roles:
  research: { models: [flash] }
  implementation: { models: [flash] }
`,
  );
  sb.write("project/.jarvis/project.yaml", "version: 1\ntools:\n  local: { check: 'true' }\n");
  // a short project workflow that changes code without gates, so apply has something to deliver
  sb.write(
    "project/.jarvis/workflows/quick.yaml",
    `name: quick
version: 1
entry: research
steps:
  - { id: research, kind: agentic, agent: research, outputs: [research], transitions: { onSuccess: implementation } }
  - { id: implementation, kind: agentic, agent: implementation, inputs: [research], outputs: [implementation], transitions: { onSuccess: DONE } }
`,
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(async () => {
  await server.close();
  sb.cleanup();
});

async function jarvis(args: string[]) {
  let out = "";
  let err = "";
  const code = await run(["node", "jarvis", ...args], {
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
    context: { cwd: sb.project, homeDir: sb.home, env: { PATH: process.env.PATH ?? "", ...gitEnv } },
  });
  return { code, out, err };
}

function agentOf(req: CapturedRequest): string {
  const system = (req.body.messages as Array<{ content: string }>)[0]?.content ?? "";
  return /# Agent: ([\w-]+)/.exec(system)?.[1] ?? "?";
}
function wantsResult(req: CapturedRequest): boolean {
  const messages = req.body.messages as Array<{ role: string; content: string | null }>;
  const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  return !req.body.tools && /Produce the result document|did not match/.test(last);
}
function toolCount(req: CapturedRequest): number {
  return ((req.body.messages as Array<{ role: string }>) ?? []).filter((m) => m.role === "tool").length;
}

const base = { summary: "s", sources: ["src/onboarding.ts"], reasons: [] as unknown[] };
const DOCS: Record<string, unknown> = {
  research: {
    ...base,
    findings: [
      { topic: "restart", detail: "src/onboarding.ts returns false", sources: ["src/onboarding.ts:2"] },
    ],
    affectedAreas: ["src"],
    existingImplementations: [],
    unknowns: [],
    outcome: "ok",
  },
  requirements: {
    ...base,
    requirements: [{ id: "R1", text: "restart allowed", verifiable: true, sources: [] }],
    verdict: "READY",
    outcome: "ok",
  },
  specification: {
    ...base,
    title: "Allow restart",
    goals: ["restart allowed"],
    nonGoals: [],
    requirements: [{ id: "R1", text: "canRestartOnboarding returns true", acceptance: ["unit test"] }],
    risks: [],
    openQuestions: [],
    outcome: "ok",
  },
  implementation: { ...base, changedFiles: ["src/onboarding.ts"], notes: [], outcome: "ok" },
};

function script() {
  server.respond((req) => {
    const agent = agentOf(req);
    if (wantsResult(req)) return completion(JSON.stringify(DOCS[agent]));
    if (agent === "implementation" && toolCount(req) === 0)
      return toolCallCompletion("repo.edit", {
        path: "src/onboarding.ts",
        oldText: "return false;",
        newText: "return true;",
      });
    if (agent === "research" && toolCount(req) === 0)
      return toolCallCompletion("repo.search", { pattern: "Onboarding" });
    return completion("done");
  });
}

describe("jarvis research / spec", () => {
  it("research runs only the research step", async () => {
    script();
    const r = await jarvis(["--json", "research", "ABC-1"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as {
      run: { workflow: string; state: string };
      steps: Array<{ stepId: string }>;
    };
    expect(doc.run.workflow).toBe("research");
    expect(doc.run.state).toBe("COMPLETED");
    expect(doc.steps.map((s) => s.stepId)).toEqual(["discover", "sources", "research"]);
  });

  it("spec stops at the approval of the specification and finishes when it is approved", async () => {
    script();
    const parked = await jarvis(["--json", "spec", "ABC-2"]);
    expect(parked.code).toBe(10);
    const doc = JSON.parse(parked.out) as { run: { id: string }; pendingApprovals: Array<{ type: string }> };
    expect(doc.pendingApprovals.map((a) => a.type)).toEqual(["spec"]);
    const done = await jarvis(["--json", "approve", doc.run.id, "--resume"]);
    expect(done.code).toBe(0);
    expect(JSON.parse(done.out).run.state).toBe("COMPLETED");
  });
});

describe("jarvis explain", () => {
  async function appliedRun() {
    script();
    const worked = await jarvis(["--json", "work", "ABC-7", "--workflow", "quick"]);
    expect(worked.code).toBe(0);
    const runId = (JSON.parse(worked.out) as { run: { id: string } }).run.id;
    const applied = await jarvis(["apply", runId, "--message", "Allow onboarding restart"]);
    expect(applied.code).toBe(0);
    return runId;
  }

  it("keeps the Jarvis-Run trailer even with a custom apply message", async () => {
    const runId = await appliedRun();
    expect(git(["log", "-1", "--format=%B"])).toContain(`Jarvis-Run: ${runId}`);
  });

  it("explains a line: blame → commit → run → artifacts, sources and tool calls", async () => {
    const runId = await appliedRun();
    const r = await jarvis(["--json", "explain", "src/onboarding.ts:2"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out) as {
      target: { kind: string; commit: { subject: string; runId: string } };
      runs: Array<{
        run: { id: string; task: string };
        steps: Array<{ step: string }>;
        artifacts: Array<{ type: string; mentions: string[]; producedBy: string }>;
        tools: Record<string, number>;
      }>;
    };
    expect(doc.target.kind).toBe("line");
    expect(doc.target.commit).toMatchObject({ subject: "Allow onboarding restart", runId });
    const [explained] = doc.runs;
    expect(explained?.run).toMatchObject({ id: runId, task: "ABC-7" });
    expect(explained?.steps.map((s) => s.step)).toEqual(["research", "implementation"]);
    const research = explained?.artifacts.find((a) => a.type === "research");
    expect(research?.producedBy).toBe("agent research");
    expect(research?.mentions.length).toBeGreaterThan(0);
    expect(explained?.tools["repo.edit"]).toBe(1);

    const human = await jarvis(["explain", "src/onboarding.ts:2"]);
    expect(human.out).toContain("task      ABC-7");
    expect(human.out).toContain("research/research.json@1");
  });

  it("explains a file, a commit and a run, and says so when there is no provenance", async () => {
    const runId = await appliedRun();
    expect((await jarvis(["explain", "src/onboarding.ts"])).out).toContain("1 Jarvis run(s) changed it");
    const head = git(["rev-parse", "HEAD"]).trim();
    expect((await jarvis(["explain", head])).out).toContain("task      ABC-7");
    expect((await jarvis(["explain", runId.slice(0, 12)])).out).toContain(
      "steps     research → implementation",
    );

    const first = git(["rev-list", "--max-parents=0", "HEAD"]).trim();
    const none = await jarvis(["explain", first]);
    expect(none.out).toContain("no Jarvis-Run trailer");
    expect(none.err).toContain("no Jarvis provenance found");
    expect((await jarvis(["explain", "nonsense-xyz"])).code).toBe(1);
  });
});

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * End-to-end: `jarvis work` runs the built-in `sdd` workflow against a scripted model that plays
 * every agent. Exercises worktree isolation, the approval gate, back edges and the fix loop.
 */
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
  writeFileSync(join(sb.project, ".gitignore"), "node_modules/\n");
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
  review: { models: [flash] }
`,
  );
  sb.write(
    "project/.jarvis/project.yaml",
    "version: 1\ntools:\n  local: { check: 'test -f src/onboarding.ts' }\n",
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
  return /# Agent: (\w+)/.exec(system)?.[1] ?? "?";
}
function lastUser(req: CapturedRequest): string {
  const messages = req.body.messages as Array<{ role: string; content: string | null }>;
  return [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
}
function wantsResult(req: CapturedRequest): boolean {
  return !req.body.tools && /Produce the result document|did not match/.test(lastUser(req));
}
function toolCount(req: CapturedRequest): number {
  return ((req.body.messages as Array<{ role: string }>) ?? []).filter((m) => m.role === "tool").length;
}

const base = { summary: "s", sources: ["src/onboarding.ts"], reasons: [] as unknown[] };
const docs: Record<string, (reviewRound: number) => unknown> = {
  research: () => ({
    ...base,
    findings: [{ topic: "restart", detail: "returns false", sources: ["src/onboarding.ts:2"] }],
    affectedAreas: ["src"],
    existingImplementations: [],
    unknowns: [],
    outcome: "ok",
  }),
  specification: () => ({
    ...base,
    title: "Allow onboarding restart",
    goals: ["restart allowed"],
    nonGoals: [],
    requirements: [{ id: "R1", text: "canRestartOnboarding returns true", acceptance: ["unit test"] }],
    risks: [],
    openQuestions: [],
    outcome: "ok",
  }),
  impact: () => ({
    ...base,
    affected: [{ path: "src/onboarding.ts", kind: "code", reason: "flag" }],
    dependencies: [],
    risks: [],
    unknowns: [],
    outcome: "ok",
  }),
  plan: () => ({
    ...base,
    steps: [
      { id: "S1", description: "flip the flag", files: ["src/onboarding.ts"], verification: "project.check" },
    ],
    outcome: "ok",
  }),
  implementation: () => ({ ...base, changedFiles: ["src/onboarding.ts"], notes: [], outcome: "ok" }),
  test: () => ({ ...base, commandsRun: ["project.check"], passed: true, failures: [], outcome: "ok" }),
  review: (round) =>
    round === 1
      ? {
          ...base,
          findings: [
            {
              severity: "major",
              file: "src/onboarding.ts",
              issue: "missing comment",
              suggestion: "add a comment",
            },
          ],
          verdict: "fix_required",
          reasons: [{ kind: "finding", summary: "missing comment", sourceRefs: [] }],
          outcome: "fix_required",
        }
      : { ...base, findings: [], verdict: "approve", outcome: "ok" },
};

describe("sdd end to end", () => {
  it("runs research → spec → gate → impact → plan → implementation → verify → review with a fix loop", async () => {
    let reviewRounds = 0;
    let implRounds = 0;
    server.respond((req) => {
      const agent = agentOf(req);
      if (wantsResult(req)) {
        if (agent === "review") reviewRounds += 1;
        return completion(JSON.stringify(docs[agent]?.(reviewRounds)));
      }
      if (agent === "implementation" && toolCount(req) === 0) {
        implRounds += 1;
        return implRounds === 1
          ? toolCallCompletion("repo.edit", {
              path: "src/onboarding.ts",
              oldText: "return false;",
              newText: "return true;",
            })
          : toolCallCompletion("repo.edit", {
              path: "src/onboarding.ts",
              oldText: "export function",
              newText: "// restart allowed after rejection\nexport function",
            });
      }
      if (agent === "test" && toolCount(req) === 0) return toolCallCompletion("project.check", {});
      if (agent === "review" && toolCount(req) === 0) return toolCallCompletion("git.diff", {});
      if (agent === "research" && toolCount(req) === 0)
        return toolCallCompletion("repo.search", { pattern: "Onboarding" });
      return completion("done");
    });

    const first = await jarvis(["--json", "work", "ABC-42"]);
    expect(first.code).toBe(10); // approval gate on the spec
    const parked = JSON.parse(first.out) as {
      run: { id: string; workspace: { path: string } };
      pendingApprovals: Array<{ type: string }>;
    };
    expect(parked.pendingApprovals.map((a) => a.type)).toEqual(["spec"]);
    const runId = parked.run.id;

    const approved = await jarvis(["--json", "approve", runId, "--resume"]);
    expect(approved.code).toBe(0);
    const done = JSON.parse(approved.out) as {
      run: { state: string; iterations: Record<string, number> };
      steps: Array<{ stepId: string; status: string; outcome?: string }>;
    };
    expect(done.run.state).toBe("COMPLETED");
    expect(done.run.iterations).toEqual({ "review->implementation#fix_required": 1 });
    expect(done.steps.map((s) => s.stepId)).toEqual([
      "research",
      "spec",
      "approve-spec",
      "approve-spec",
      "impact",
      "plan",
      "implementation",
      "verify",
      "tests",
      "review",
      "implementation",
      "verify",
      "tests",
      "review",
    ]);
    expect(done.steps.find((s) => s.stepId === "review")?.outcome).toBe("fix_required");

    // The worktree holds both fixes; the main checkout is untouched until apply.
    const wt = readFileSync(join(parked.run.workspace.path, "src", "onboarding.ts"), "utf8");
    expect(wt).toContain("return true;");
    expect(wt).toContain("// restart allowed after rejection");
    expect(readFileSync(join(sb.project, "src", "onboarding.ts"), "utf8")).toContain("return false;");
    expect(git(["log", "--format=%s", "-n", "20"], parked.run.workspace.path)).toContain(
      "jarvis: implementation #2 success",
    );

    const status = await jarvis(["status", runId]);
    for (const t of [
      "research/research.json@1",
      "spec/spec.json@1",
      "impact/impact.json@1",
      "plan/plan.json@1",
      "implementation/implementation.json@2",
      "tests/tests.json@2",
      "review/review.json@2",
    ]) {
      expect(status.out).toContain(t);
    }
    expect(status.out).toMatch(/spec\/spec\.json@1.*approved/);

    const apply = await jarvis(["apply", runId]);
    expect(apply.code).toBe(0);
    expect(readFileSync(join(sb.project, "src", "onboarding.ts"), "utf8")).toContain("return true;");
    expect(existsSync(join(sb.project, ".jarvis"))).toBe(true);
  });
});

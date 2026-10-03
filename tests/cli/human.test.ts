import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
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
 * ADR-0019 end to end: clarification threads (answer / attach), human edits in the worktree,
 * Review Mode v1 (markers → package → analysis → fix), gates switched off by policy.
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

function project(extra = "") {
  sb.write(
    "project/.jarvis/project.yaml",
    `version: 1\ntools:\n  local: { check: 'test -f src/onboarding.ts' }\n${extra}`,
  );
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
  project();
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(async () => {
  await server.close();
  sb.cleanup();
});

async function jarvis(args: string[], stdin?: string) {
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
    ...(stdin !== undefined ? { stdin: Readable.from([stdin]) } : {}),
    context: { cwd: sb.project, homeDir: sb.home, env: { PATH: process.env.PATH ?? "", ...gitEnv } },
  });
  return { code, out, err };
}

function systemOf(req: CapturedRequest): string {
  return (req.body.messages as Array<{ content: string }>)[0]?.content ?? "";
}
function agentOf(req: CapturedRequest): string {
  if (systemOf(req).startsWith("# Jarvis clarification thread")) return "clarifier";
  return /# Agent: ([\w-]+)/.exec(systemOf(req))?.[1] ?? "?";
}
function lastUser(req: CapturedRequest): string {
  const messages = req.body.messages as Array<{ role: string; content: string | null }>;
  return [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
}
function userText(req: CapturedRequest): string {
  return (req.body.messages as Array<{ role: string; content: string | null }>)
    .filter((m) => m.role === "user")
    .map((m) => m.content ?? "")
    .join("\n");
}
function wantsResult(req: CapturedRequest): boolean {
  return (
    !req.body.tools &&
    /Produce the result document|did not match|Answer with the JSON document/.test(lastUser(req))
  );
}
function toolCount(req: CapturedRequest): number {
  return ((req.body.messages as Array<{ role: string }>) ?? []).filter((m) => m.role === "tool").length;
}

const base = { summary: "s", sources: ["src/onboarding.ts"], reasons: [] as unknown[] };
const docs: Record<string, () => unknown> = {
  research: () => ({
    ...base,
    findings: [],
    affectedAreas: ["src"],
    existingImplementations: [],
    unknowns: [],
    outcome: "ok",
  }),
  requirements: () => ({
    ...base,
    requirements: [{ id: "R1", text: "restart allowed", verifiable: true, sources: [] }],
    verdict: "READY",
    outcome: "ok",
  }),
  specification: () => ({
    ...base,
    title: "Allow onboarding restart",
    goals: ["restart allowed"],
    requirements: [{ id: "R1", text: "canRestartOnboarding returns true", acceptance: ["unit test"] }],
    outcome: "ok",
  }),
  impact: () => ({
    ...base,
    affected: [{ path: "src/onboarding.ts", kind: "code", reason: "flag" }],
    outcome: "ok",
  }),
  plan: () => ({
    ...base,
    steps: [{ id: "S1", description: "flip", files: ["src/onboarding.ts"], verification: "project.check" }],
    outcome: "ok",
  }),
  implementation: () => ({ ...base, changedFiles: ["src/onboarding.ts"], outcome: "ok" }),
  test: () => ({ ...base, commandsRun: ["project.check"], passed: true, outcome: "ok" }),
  review: () => ({ ...base, findings: [], verdict: "approve", outcome: "ok" }),
  docs: () => ({ ...base, updatedFiles: ["README.md"], sections: [], gaps: [], outcome: "ok" }),
  telemetry: () => ({
    ...base,
    events: [{ name: "onboarding_restarted", when: "restart", properties: [], status: "proposed" }],
    metrics: [],
    privacy: [],
    outcome: "ok",
  }),
  "release-notes": () => ({
    ...base,
    title: "Onboarding restart",
    audience: "both",
    highlights: ["restart allowed"],
    changes: [],
    breaking: [],
    migration: [],
    markdown: "# Onboarding restart\n- restart allowed",
    outcome: "ok",
  }),
};

/** A scripted model for the whole workflow; `overrides` answers specific agents first. */
function script(
  overrides: (req: CapturedRequest, agent: string) => ReturnType<typeof completion> | undefined,
) {
  let implEdits = 0;
  server.respond((req) => {
    const agent = agentOf(req);
    const custom = overrides(req, agent);
    if (custom) return custom;
    if (wantsResult(req)) return completion(JSON.stringify(docs[agent]?.()));
    if (agent === "implementation" && toolCount(req) === 0) {
      implEdits += 1;
      return toolCallCompletion("repo.edit", {
        path: "src/onboarding.ts",
        oldText: implEdits === 1 ? "return false;" : "return true;",
        newText: implEdits === 1 ? "return true;" : "return RESTART_ALLOWED;",
      });
    }
    if (agent === "test" && toolCount(req) === 0) return toolCallCompletion("project.check", {});
    return completion("done");
  });
}

describe("clarification threads", () => {
  it("parks on needs_clarification, answers asynchronously, resumes with the rule in context", async () => {
    let requirementsCalls = 0;
    const prompts: string[] = [];
    script((req, agent) => {
      if (agent === "requirements" && wantsResult(req)) {
        requirementsCalls += 1;
        prompts.push(userText(req));
        if (requirementsCalls === 1) {
          return completion(
            JSON.stringify({
              ...base,
              requirements: [],
              openQuestions: ["retry semantics"],
              verdict: "NEEDS_CLARIFICATION",
              clarification: {
                question: "What if the application was already re-submitted?",
                context: "idempotent vs reject",
              },
              outcome: "needs_clarification",
            }),
          );
        }
      }
      if (agent === "clarifier" && wantsResult(req)) {
        const thread = userText(req);
        return /Human: return the existing/.test(thread)
          ? completion(
              JSON.stringify({
                kind: "resolution",
                text: "Retry is idempotent.",
                proposal: {
                  rule: "Retry returns the existing application for PROCESSING and completed attempts.",
                  requirementCorrections: ["R2: retry is idempotent"],
                  assumptions: [],
                },
              }),
            )
          : completion(
              JSON.stringify({
                kind: "question",
                text: "Should this also apply while the first attempt is PROCESSING?",
              }),
            );
      }
      return undefined;
    });

    const first = await jarvis(["--json", "work", "ABC-50"]);
    expect(first.code).toBe(10);
    const parked = JSON.parse(first.out) as {
      run: { id: string; state: string; waitingFor?: { kind: string; interactionId?: string } };
      interactions: Array<{ id: string; kind: string; state: string }>;
    };
    expect(parked.run.waitingFor?.kind).toBe("clarification");
    const threadId = parked.run.waitingFor?.interactionId as string;
    expect(parked.interactions).toEqual([
      expect.objectContaining({ id: threadId, kind: "clarification", state: "open" }),
    ]);
    const runId = parked.run.id;

    const threads = await jarvis(["threads"]);
    expect(threads.out).toContain(`${threadId}  clarification  open`);
    expect(threads.out).toContain("What if the application was already re-submitted?");

    // first human turn → Jarvis asks a follow-up
    const a1 = await jarvis(["answer", runId, "reject the duplicate"]);
    expect(a1.code).toBe(0);
    expect(a1.out).toContain("Should this also apply while the first attempt is PROCESSING?");

    // second turn → proposal
    const a2 = await jarvis(["--json", "answer", threadId, "return the existing application"]);
    const r2 = JSON.parse(a2.out) as { thread: { state: string }; reply: { proposal?: { rule: string } } };
    expect(r2.thread.state).toBe("ready_for_review");
    expect(r2.reply.proposal?.rule).toContain("Retry returns the existing application");

    // nothing to accept before a proposal is a clear error; accepting resolves and resumes
    const accepted = await jarvis(["--json", "answer", threadId, "--accept", "--resume"]);
    expect(accepted.code).toBe(10); // now parked at approve-spec
    const after = JSON.parse(accepted.out) as {
      run: { waitingFor?: { kind: string } };
      artifacts: Array<{ type: string; name: string }>;
      steps: Array<{ stepId: string; status: string; outcome?: string }>;
    };
    expect(after.run.waitingFor?.kind).toBe("approval");
    expect(after.artifacts.map((a) => a.type)).toEqual(
      expect.arrayContaining(["clarification", "requirements", "spec"]),
    );
    expect(after.steps.map((s) => `${s.stepId}:${s.status}`)).toEqual([
      "discover:success",
      "research:success",
      "requirements:suspended",
      "requirements:success",
      "spec:success",
      "approve-spec:suspended",
    ]);
    expect(requirementsCalls).toBe(2);
    expect(prompts[1]).toContain("# Clarifications decided with a human (binding)");
    expect(prompts[1]).toContain(
      "Rule: Retry returns the existing application for PROCESSING and completed attempts.",
    );
    expect(prompts[1]).toContain("Requirement correction: R2: retry is idempotent");

    const all = await jarvis(["--json", "threads", "--all"]);
    const list = JSON.parse(all.out) as { threads: Array<{ id: string; state: string; turns: number }> };
    expect(list.threads.find((t) => t.id === threadId)).toMatchObject({ state: "resolved", turns: 2 });
  });

  it("attach runs the mini-chat on stdin and accepts an edited rule", async () => {
    let calls = 0;
    script((req, agent) => {
      if (agent === "requirements" && wantsResult(req)) {
        calls += 1;
        if (calls === 1)
          return completion(
            JSON.stringify({
              ...base,
              requirements: [],
              verdict: "NEEDS_CLARIFICATION",
              clarification: { question: "Q1?" },
              outcome: "needs_clarification",
            }),
          );
      }
      if (agent === "clarifier" && wantsResult(req))
        return completion(
          JSON.stringify({
            kind: "resolution",
            text: "Proposed.",
            proposal: { rule: "draft rule", requirementCorrections: [], assumptions: ["a1"] },
          }),
        );
      return undefined;
    });
    const first = await jarvis(["--json", "work", "ABC-51"]);
    const runId = (JSON.parse(first.out) as { run: { id: string } }).run.id;
    const attached = await jarvis(
      ["attach", runId, "--no-resume"],
      "idempotent\ne Retry is idempotent for every state.\n",
    );
    expect(attached.code).toBe(0);
    expect(attached.out).toContain("Q1?");
    expect(attached.out).toContain("Proposed rule: draft rule");
    expect(attached.out).toContain("resolved →");
    const status = await jarvis(["--json", "status", runId]);
    const detail = JSON.parse(status.out) as {
      run: { state: string; waitingFor?: unknown };
      interactions: unknown[];
    };
    expect(detail.run.state).toBe("WAITING_HUMAN");
    expect(detail.run.waitingFor).toBeUndefined();
    expect(detail.interactions).toEqual([]);
    const resumed = await jarvis(["--json", "resume", runId]);
    expect(resumed.code).toBe(10);
    const art = (
      JSON.parse(resumed.out) as { artifacts: Array<{ type: string; contentRef: string }> }
    ).artifacts.find((a) => a.type === "clarification");
    expect(art).toBeDefined();
  });

  it("respects the turn budget and reports it", async () => {
    project("human: { clarification: { maxTurns: 1 } }\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "policy"]);
    script((req, agent) => {
      if (agent === "requirements" && wantsResult(req))
        return completion(
          JSON.stringify({
            ...base,
            requirements: [],
            verdict: "NEEDS_CLARIFICATION",
            clarification: { question: "Q?" },
            outcome: "needs_clarification",
          }),
        );
      if (agent === "clarifier" && wantsResult(req))
        return completion(JSON.stringify({ kind: "question", text: "more?" }));
      return undefined;
    });
    const first = await jarvis(["--json", "work", "ABC-52"]);
    const runId = (JSON.parse(first.out) as { run: { id: string } }).run.id;
    expect((await jarvis(["answer", runId, "one"])).out).toContain("more?");
    const second = await jarvis(["answer", runId, "two"]);
    expect(second.out).toContain("turn budget of the thread is used up");
    const forced = await jarvis(["--json", "answer", runId, "--accept", "--rule", "my rule"]);
    expect((JSON.parse(forced.out) as { resolved?: string }).resolved).toMatch(/@1$/);
  });
});

describe("human edits and gates", () => {
  it("commits uncommitted human edits in the worktree as a human checkpoint instead of resetting them", async () => {
    script(() => undefined);
    const first = await jarvis(["--json", "work", "ABC-53"]);
    expect(first.code).toBe(10);
    const parked = JSON.parse(first.out) as { run: { id: string; workspace: { path: string } } };
    const wt = parked.run.workspace.path;
    writeFileSync(join(wt, "src", "notes.md"), "human note\n");
    writeFileSync(
      join(wt, "src", "onboarding.ts"),
      "// edited by a human\nexport function canRestartOnboarding() {\n  return false;\n}\n",
    );
    const resumed = await jarvis(["--json", "approve", parked.run.id, "--resume"]);
    expect(resumed.code).toBe(10);
    expect(readFileSync(join(wt, "src", "notes.md"), "utf8")).toBe("human note\n");
    expect(readFileSync(join(wt, "src", "onboarding.ts"), "utf8")).toContain("// edited by a human");
    expect(readFileSync(join(wt, "src", "onboarding.ts"), "utf8")).toContain("return true;");
    const log = git(["log", "--format=%s%n%b", "-n", "30"], wt);
    expect(log).toContain("human edit");
    expect(log).toContain("Jarvis-Kind: human-edit");
    expect(log).toContain("Jarvis-Actor: me@corp");
    const log2 = git(["log", "--format=%s", "-n", "40"], wt);
    // the human checkpoint sits right after the suspend checkpoint of the gate, before any later step
    const lines = log2.trim().split("\n").reverse();
    expect(lines.indexOf("human edit")).toBeGreaterThan(lines.findIndex((l) => l.includes("approve-spec")));
  });

  it("skips a gate the project switched off", async () => {
    project("human: { gates: { spec: { required: false } } }\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "policy"]);
    script(() => undefined);
    const first = await jarvis(["--json", "work", "ABC-54"]);
    expect(first.code).toBe(10);
    const parked = JSON.parse(first.out) as {
      run: { waitingFor?: { detail?: string } };
      steps: Array<{ stepId: string; status: string }>;
    };
    expect(parked.run.waitingFor?.detail).toBe("implementation");
    expect(parked.steps.find((s) => s.stepId === "approve-spec")?.status).toBe("success");
  });
});

describe("review mode v1", () => {
  it("turns REVIEW markers into a package, analysis, a fix loop and clean code on apply", async () => {
    let analysisPrompt = "";
    script((req, agent) => {
      if (agent === "review-analysis" && wantsResult(req)) {
        analysisPrompt = userText(req);
        return completion(
          JSON.stringify({
            ...base,
            comments: [
              {
                id: "R-1",
                class: "CODE",
                action: "use a named constant",
                file: "src/onboarding.ts",
                line: 2,
              },
              { id: "R-2", class: "KNOWLEDGE_CANDIDATE", action: "record it" },
            ],
            verdict: "fix_code",
            candidates: [
              {
                kind: "knowledge",
                title: "Flags are named constants",
                rationale: "R-2",
                evidence: ["src/onboarding.ts:2"],
              },
            ],
            reasons: [
              {
                kind: "finding",
                summary: "R-1 src/onboarding.ts:2 use a named constant",
                sourceRefs: ["src/onboarding.ts:2"],
              },
            ],
            outcome: "fix_required",
          }),
        );
      }
      if (agent === "review-analysis" && toolCount(req) === 0)
        return toolCallCompletion("repo.read", { path: "src/onboarding.ts" });
      return undefined;
    });

    const first = await jarvis(["--json", "work", "ABC-55"]);
    const runId = (JSON.parse(first.out) as { run: { id: string } }).run.id;
    const gate = await jarvis(["--json", "approve", runId, "--resume"]);
    expect(gate.code).toBe(10);
    const parked = JSON.parse(gate.out) as {
      run: { workspace: { path: string }; waitingFor?: { detail?: string } };
    };
    expect(parked.run.waitingFor?.detail).toBe("implementation");
    const wt = parked.run.workspace.path;

    // the developer annotates the code
    const file = join(wt, "src", "onboarding.ts");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "  return true;",
        "  // REVIEW: use a named constant\n  return true; // REVIEW: and record the convention",
      ),
    );
    const empty = await jarvis(["review", "submit", "nope"]);
    expect(empty.code).toBe(1);

    const submitted = await jarvis(["--json", "review", "submit", runId]);
    expect(submitted.code).toBe(0);
    const pkg = JSON.parse(submitted.out) as {
      package: string;
      comments: Array<{ id: string; line: number; text: string }>;
      rewritten: string[];
    };
    expect(pkg.comments).toEqual([
      { id: "R-1", file: "src/onboarding.ts", line: 2, text: "use a named constant" },
      { id: "R-2", file: "src/onboarding.ts", line: 3, text: "and record the convention" },
    ]);
    expect(pkg.rewritten).toEqual(["src/onboarding.ts"]);
    expect(readFileSync(file, "utf8")).toContain("// REVIEW(R-1): use a named constant");
    expect(readFileSync(file, "utf8")).toContain("// REVIEW(R-2): and record the convention");
    const threadsOut = await jarvis(["threads"]);
    expect(threadsOut.out).toContain("review         open");
    const st0 = JSON.parse((await jarvis(["--json", "review", "status", runId])).out) as {
      sessions: Array<{ state: string; comments: Array<{ id: string; state: string; class?: string }> }>;
    };
    expect(st0.sessions[0]?.comments.map((c) => [c.id, c.state])).toEqual([
      ["R-1", "open"],
      ["R-2", "open"],
    ]);

    const resumed = await jarvis(["--json", "resume", runId]);
    expect(resumed.code).toBe(10); // back at the gate after the fix
    const detail = JSON.parse(resumed.out) as {
      run: { iterations: Record<string, number> };
      steps: Array<{ stepId: string; outcome?: string }>;
      artifacts: Array<{ type: string }>;
    };
    expect(detail.run.iterations).toEqual({
      "approve-impl->review-analysis#review_submitted": 1,
      "review-analysis->implementation#fix_required": 1,
    });
    expect(detail.steps.map((s) => s.stepId).slice(-11)).toEqual([
      "approve-impl",
      "approve-impl",
      "review-analysis",
      "implementation",
      "verify",
      "tests",
      "standards",
      "docs",
      "telemetry",
      "review",
      "approve-impl",
    ]);
    expect(detail.artifacts.map((a) => a.type)).toEqual(
      expect.arrayContaining(["review-package", "review-analysis", "candidate"]),
    );
    expect(analysisPrompt).toContain("## Artifact review-package/review-package.json@1");
    expect(analysisPrompt).toContain("R-1");
    // the human edit (markers with ids) was committed, the fix applied on top
    expect(readFileSync(file, "utf8")).toContain("return RESTART_ALLOWED;");
    expect(git(["log", "--format=%b", "-n", "40"], wt)).toContain("Jarvis-Kind: human-edit");
    const implPrompt = server.requests
      .filter((r) => agentOf(r) === "implementation")
      .map(userText)
      .find((t) => t.includes("# Why this step runs again"));
    expect(implPrompt).toContain('review-analysis returned "fix_required"');
    expect(implPrompt).toContain("R-1 src/onboarding.ts:2 use a named constant");

    // ADR-0019 §5 lifecycle: classified → applied by the fix → ready at the gate → resolved on approval
    const st1 = JSON.parse((await jarvis(["--json", "review", "status", runId])).out) as {
      sessions: Array<{
        state: string;
        comments: Array<{ id: string; state: string; class?: string; history: unknown[] }>;
      }>;
    };
    expect(st1.sessions[0]?.state).toBe("ready_for_review");
    expect(st1.sessions[0]?.comments.map((c) => [c.id, c.class, c.state])).toEqual([
      ["R-1", "CODE", "ready_for_review"],
      ["R-2", "KNOWLEDGE_CANDIDATE", "resolved"],
    ]);
    expect(st1.sessions[0]?.comments[0]?.history.map((h) => (h as { state: string }).state)).toEqual([
      "open",
      "acknowledged",
      "applied",
      "ready_for_review",
    ]);
    const text = await jarvis(["review", "status", runId]);
    expect(text.out).toContain("R-1   ready_for_review  CODE");
    expect(text.out).toContain("→ use a named constant");

    expect((await jarvis(["--json", "approve", runId, "--resume"])).code).toBe(0);
    const st2 = JSON.parse((await jarvis(["--json", "review", "status", runId])).out) as {
      sessions: Array<{ state: string; comments: Array<{ state: string }> }>;
    };
    expect(st2.sessions[0]?.state).toBe("resolved");
    expect(st2.sessions[0]?.comments.every((c) => c.state === "resolved")).toBe(true);
    const applied = await jarvis(["apply", runId]);
    expect(applied.code).toBe(0);
    const main = readFileSync(join(sb.project, "src", "onboarding.ts"), "utf8");
    expect(main).not.toContain("REVIEW");
    expect(main).toContain("return RESTART_ALLOWED;");
    const candidates = await jarvis(["--json", "candidates", "list"]);
    expect(
      (JSON.parse(candidates.out) as { candidates: Array<{ title: string }> }).candidates.map((c) => c.title),
    ).toEqual(["Flags are named constants"]);
  });
});

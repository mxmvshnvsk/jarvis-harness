import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/main.ts";
import { diffResults, type SuiteResult } from "../../src/evals/runner.ts";
import {
  type CapturedRequest,
  completion,
  type FakeOpenAi,
  startFakeOpenAi,
  toolCallCompletion,
} from "../helpers/fakeOpenAi.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

/** ADR-0012: a workflow-tier case recorded once against the scripted model, then replayed with no model at all. */
let sb: Sandbox;
let server: FakeOpenAi;

beforeEach(async () => {
  sb = sandbox();
  server = await startFakeOpenAi();
  sb.write(
    "home/.jarvis/config.yaml",
    `version: 1
models:
  flash: { provider: openai-compatible, baseUrl: ${server.baseUrl}, model: flash, egress: private, contextWindow: 32000, maxOutput: 2000, supports: { tools: true, jsonMode: true } }
roles:
  research: { models: [flash] }
  implementation: { models: [flash] }
  review: { models: [flash] }
`,
  );
  // the case: a fixture repository, gold, and an (initially empty) cassette directory
  const caseDir = join(sb.project, "evals", "smoke", "restart-flag");
  mkdirSync(join(caseDir, "fixture", "src"), { recursive: true });
  writeFileSync(
    join(caseDir, "fixture", "src", "onboarding.ts"),
    "export function canRestartOnboarding() {\n  return false;\n}\n",
  );
  writeFileSync(
    join(caseDir, "case.yaml"),
    `task: ABC-80
project:
  version: 1
  tools: { local: { check: "grep -q 'return true' src/onboarding.ts" } }
gold:
  files: [src/onboarding.ts]
  tests: "grep -q 'return true' src/onboarding.ts"
  acceptance: ["unit test"]
`,
  );
  const base = { summary: "s", sources: ["src/onboarding.ts"], reasons: [] };
  const docs: Record<string, unknown> = {
    research: { ...base, findings: [], outcome: "ok" },
    requirements: { ...base, requirements: [], verdict: "READY", outcome: "ok" },
    specification: {
      ...base,
      title: "t",
      goals: ["g"],
      requirements: [{ id: "R1", text: "x", acceptance: ["unit test"] }],
      outcome: "ok",
    },
    impact: {
      ...base,
      affected: [{ path: "src/onboarding.ts", kind: "code", reason: "flag" }],
      outcome: "ok",
    },
    plan: { ...base, steps: [{ id: "S1", description: "d", verification: "project.check" }], outcome: "ok" },
    implementation: { ...base, changedFiles: ["src/onboarding.ts"], outcome: "ok" },
    test: { ...base, commandsRun: ["project.check"], passed: true, outcome: "ok" },
    review: { ...base, findings: [], verdict: "approve", outcome: "ok" },
    docs: { ...base, updatedFiles: [], outcome: "ok" },
    telemetry: { ...base, events: [], outcome: "ok" },
    "release-notes": { ...base, title: "t", highlights: ["h"], markdown: "# t", outcome: "ok" },
  };
  server.respond((req: CapturedRequest) => {
    const system = (req.body.messages as Array<{ content: string }>)[0]?.content ?? "";
    const agent = /# Agent: ([\w-]+)/.exec(system)?.[1] ?? "?";
    const tools = (req.body.messages as Array<{ role: string }>).filter((m) => m.role === "tool").length;
    if (!req.body.tools) return completion(JSON.stringify(docs[agent]));
    if (agent === "implementation" && tools === 0)
      return toolCallCompletion("repo.edit", {
        path: "src/onboarding.ts",
        oldText: "return false;",
        newText: "return true;",
      });
    return completion("done");
  });
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
    context: {
      cwd: sb.project,
      homeDir: sb.home,
      env: {
        PATH: process.env.PATH ?? "",
        JARVIS_ACTOR: "me@corp",
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    },
  });
  return { code, out, err };
}

describe("jarvis evals", () => {
  it("records a suite, replays it without the model, pins a baseline and detects regressions", async () => {
    const recorded = await jarvis(["--json", "evals", "run", "--suite", "smoke", "--mode", "record"]);
    expect(recorded.code).toBe(0);
    expect(recorded.code).toBe(0);
    const r = JSON.parse(recorded.out) as SuiteResult & { file: string };
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0]).toMatchObject({
      id: "restart-flag",
      state: "COMPLETED",
      success: true,
      testsPassed: true,
      fileRecall: 1,
      acceptanceCoverage: 1,
      loops: 0,
      changedFiles: ["src/onboarding.ts"],
    });
    expect(r.cases[0]?.outputTokens).toBeGreaterThan(0);
    expect(r.summary.successPer10k).toBeGreaterThan(0);
    expect(existsSync(r.file)).toBe(true);
    const cassette = join(sb.project, "evals", "smoke", "restart-flag", "cassette");
    expect(readdirSync(cassette).length).toBeGreaterThan(5);
    const callsAfterRecord = server.requests.length;

    // replay: same result, not a single model call
    const replayed = await jarvis(["--json", "evals", "run", "--suite", "smoke"]);
    expect(replayed.code).toBe(0);
    const p = JSON.parse(replayed.out) as SuiteResult;
    expect(p.mode).toBe("replay");
    expect(p.cases[0]).toMatchObject({ success: true, outputTokens: r.cases[0]?.outputTokens });
    expect(server.requests.length).toBe(callsAfterRecord);

    const baseline = await jarvis(["evals", "baseline", "smoke"]);
    expect(baseline.code).toBe(0);
    expect(existsSync(join(sb.project, "evals", "baseline", "smoke.json"))).toBe(true);
    const same = await jarvis(["evals", "diff", "smoke"]);
    expect(same.code).toBe(0);
    expect(same.out).toContain("no regression beyond tolerance");

    // a variant that breaks the case (gate off is fine; an impossible command fails the tests)
    const worse = await jarvis([
      "--json",
      "evals",
      "run",
      "--suite",
      "smoke",
      "--variant",
      "tools.local.check=false",
      "--out",
      "evals/results/worse.json",
    ]);
    expect(worse.code).toBe(1);
    const w = JSON.parse(worse.out) as SuiteResult;
    expect(w.variant).toEqual({ "tools.local.check": "false" });
    const regressed = await jarvis(["evals", "diff", "smoke", "--from", "evals/results/worse.json"]);
    expect(regressed.code).toBe(1);
    expect(regressed.out).toContain("REGRESSION");
  });

  it("diffResults tolerates small drops and flags large ones", () => {
    const mk = (successRate: number, per10k: number): SuiteResult =>
      ({
        suite: "s",
        mode: "replay",
        variant: {},
        at: "",
        cases: [],
        summary: {
          cases: 10,
          successes: successRate * 10,
          successRate,
          meanFileRecall: 1,
          meanAcceptanceCoverage: 1,
          outputTokens: 1000,
          successPer10k: per10k,
        },
      }) as SuiteResult;
    expect(diffResults(mk(0.9, 5), mk(0.88, 4.9)).ok).toBe(true);
    const bad = diffResults(mk(0.9, 5), mk(0.7, 5));
    expect(bad.ok).toBe(false);
    expect(bad.regressions).toEqual(["successRate: 0.9 → 0.7"]);
  });

  it("run-to-case turns a finished run into a case that records and replays", async () => {
    // a real run in a git repository, with a human-edited spec so required sources come from it
    const { execFileSync } = await import("node:child_process");
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: sb.project,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    mkdirSync(join(sb.project, "src"), { recursive: true });
    writeFileSync(
      join(sb.project, "src", "onboarding.ts"),
      "export function canRestartOnboarding() {\n  return false;\n}\n",
    );
    sb.write(
      "project/.jarvis/project.yaml",
      "version: 1\ntools: { local: { check: \"grep -q 'return true' src/onboarding.ts\" } }\nhuman: { gates: { spec: { required: false }, implementation: { required: false } } }\n",
    );
    git(["init", "-q", "-b", "main"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "init"]);
    const work = await jarvis(["--json", "work", "ABC-81"]);
    expect(work.code).toBe(0);
    const runId = (JSON.parse(work.out) as { run: { id: string } }).run.id;

    const made = await jarvis(["--json", "evals", "run-to-case", runId, "--suite", "derived"]);
    expect(made.code).toBe(0);
    const r = JSON.parse(made.out) as {
      caseDir: string;
      files: string[];
      acceptance: string[];
      fixture: boolean;
    };
    expect(r.files).toEqual(["src/onboarding.ts"]);
    expect(r.acceptance).toEqual(["unit test"]);
    expect(r.fixture).toBe(true);
    expect(existsSync(join(r.caseDir, "fixture", "src", "onboarding.ts"))).toBe(true);
    expect(existsSync(join(r.caseDir, "case.yaml"))).toBe(true);
    const again = await jarvis(["evals", "run-to-case", runId, "--suite", "derived"]);
    expect(again.code).toBe(1);

    const recorded = await jarvis(["--json", "evals", "run", "--suite", "derived", "--mode", "record"]);
    expect(recorded.code).toBe(0);
    const result = JSON.parse(recorded.out) as SuiteResult;
    expect(result.cases[0]).toMatchObject({
      id: "abc-81",
      success: true,
      fileRecall: 1,
      acceptanceCoverage: 1,
      testsPassed: true,
    });
    const replayed = await jarvis(["--json", "evals", "run", "--suite", "derived"]);
    expect((JSON.parse(replayed.out) as SuiteResult).cases[0]?.success).toBe(true);
  });
});

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
    context: { cwd: sb.project, homeDir: sb.home, env: { PATH: process.env.PATH ?? "" } },
  });
  return { code, out, err };
}

describe("jarvis evals", () => {
  it("records a suite, replays it without the model, pins a baseline and detects regressions", async () => {
    const recorded = await jarvis(["--json", "evals", "run", "--suite", "smoke", "--mode", "record"]);
    expect(recorded.err).toBe("");
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
});

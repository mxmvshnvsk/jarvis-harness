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

/** ADR-0009: the same workflow in CI, the bundle round trip, committed approvals. */
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

function userConfig(home: string) {
  writeFileSync(
    join(home, ".jarvis", "config.yaml"),
    `version: 1
actor: { id: me@corp }
models:
  flash: { provider: openai-compatible, baseUrl: ${server.baseUrl}, model: flash, egress: private, contextWindow: 32000, maxOutput: 2000, supports: { tools: true, jsonMode: true } }
roles:
  research: { models: [flash] }
  implementation: { models: [flash] }
  review: { models: [flash] }
`,
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
  mkdirSync(join(sb.home, ".jarvis"), { recursive: true });
  userConfig(sb.home);
  sb.write(
    "project/.jarvis/project.yaml",
    `version: 1
tools: { local: { check: 'test -f src/onboarding.ts' } }
profiles:
  ci:
    interactive: false
    workspace: { mode: cwd, allowWrites: false }
    humanGate: artifact
  ci-skip:
    interactive: false
    workspace: { mode: cwd, allowWrites: false }
    humanGate: skip-if-approved
`,
  );
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);

  const base = { summary: "s", sources: [], reasons: [] };
  const docs: Record<string, unknown> = {
    research: { ...base, findings: [], outcome: "ok" },
    requirements: { ...base, requirements: [], verdict: "READY", outcome: "ok" },
    specification: {
      ...base,
      title: "t",
      goals: ["g"],
      requirements: [{ id: "R1", text: "x", acceptance: ["a"] }],
      outcome: "ok",
    },
    impact: { ...base, affected: [], outcome: "ok" },
    plan: { ...base, steps: [{ id: "S1", description: "d", verification: "project.check" }], outcome: "ok" },
    implementation: { ...base, changedFiles: [], outcome: "ok" },
    test: { ...base, commandsRun: [], passed: true, outcome: "ok" },
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

async function jarvis(
  args: string[],
  overrides: { cwd?: string; homeDir?: string; env?: NodeJS.ProcessEnv } = {},
) {
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
      cwd: overrides.cwd ?? sb.project,
      homeDir: overrides.homeDir ?? sb.home,
      env: { PATH: process.env.PATH ?? "", ...gitEnv, ...overrides.env },
    },
  });
  return { code, out, err };
}

describe("jarvis ci", () => {
  it("parks at the spec gate with exit 10, a job summary, an approval request and a bundle", async () => {
    const summary = join(sb.root, "summary.md");
    const bundle = join(sb.root, "run.jarvis.json.gz");
    const ci = await jarvis(["--json", "ci", "ABC-60", "--summary", summary, "--bundle", bundle]);
    expect(ci.code).toBe(10);
    const parked = JSON.parse(ci.out) as {
      run: { id: string; profile?: string; workspace: { mode: string }; waitingFor?: { detail?: string } };
    };
    expect(parked.run.profile).toBe("ci");
    expect(parked.run.workspace.mode).toBe("cwd");
    expect(parked.run.waitingFor?.detail).toBe("spec");
    const md = readFileSync(summary, "utf8");
    expect(md).toContain("## Jarvis run");
    expect(md).toContain("| state | **WAITING_HUMAN**");
    expect(md).toContain("### Awaiting approval");
    expect(md).toContain("`spec/spec.json@1`");
    const request = JSON.parse(
      readFileSync(join(sb.home, ".jarvis", "runs", parked.run.id, "approval-request.json"), "utf8"),
    ) as { pending: Array<{ type: string }>; bundle: string };
    expect(request.pending.map((p) => p.type)).toEqual(["spec"]);
    expect(request.bundle).toBe(bundle);
    expect(existsSync(bundle)).toBe(true);
    // the ci profile keeps the checkout untouched (read-only, cwd mode)
    expect(git(["status", "--porcelain"]).trim()).toBe("");
  });

  it("fails fast with exit 12 when humanGate is fail", async () => {
    sb.write(
      "project/.jarvis/project.yaml",
      "version: 1\ntools: { local: { check: 'true' } }\nprofiles:\n  strict: { interactive: false, workspace: { mode: cwd }, humanGate: fail }\n",
    );
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "p"]);
    const ci = await jarvis(["--json", "--profile", "strict", "ci", "ABC-61"]);
    expect(ci.code).toBe(12);
    expect((JSON.parse(ci.out) as { run: { stateReason?: string } }).run.stateReason).toContain(
      "human_gate_in_ci",
    );
  });
});

describe("export / import / committed approvals", () => {
  it("moves a parked run to another home, continues it there and skips the gate in CI once committed", async () => {
    // Developer side: a worktree run parked at the spec gate, with code already changed? No — park first.
    const first = await jarvis(["--json", "work", "ABC-62"]);
    expect(first.code).toBe(10);
    const runId = (JSON.parse(first.out) as { run: { id: string } }).run.id;

    const bundle = join(sb.root, "dev.jarvis.json.gz");
    const exported = await jarvis(["--json", "export", runId, "--out", bundle]);
    expect(exported.err).toBe("");
    expect(exported.code).toBe(0);
    const stats = JSON.parse(exported.out) as { artifacts: number; blobs: number };
    expect(stats.artifacts).toBeGreaterThanOrEqual(3);
    expect(stats.blobs).toBe(stats.artifacts);

    // Second machine: fresh home, same repository clone.
    const home2 = join(sb.root, "home2");
    mkdirSync(join(home2, ".jarvis"), { recursive: true });
    userConfig(home2);
    const clone = join(sb.root, "clone");
    git(["clone", "-q", sb.project, clone]);
    const dup = await jarvis(["import", bundle]);
    expect(dup.code).toBe(1);
    expect(dup.err).toContain("already exists locally");
    const imported = await jarvis(["--json", "import", bundle], { cwd: clone, homeDir: home2 });
    expect(imported.code).toBe(0);
    const result = JSON.parse(imported.out) as {
      runId: string;
      workspace: string;
      state: string;
      workspacePath: string;
    };
    expect(result).toMatchObject({ runId, workspace: "worktree", state: "WAITING_HUMAN" });
    expect(result.workspacePath).toContain(home2);
    const status = await jarvis(["--json", "status", runId], { cwd: clone, homeDir: home2 });
    const detail = JSON.parse(status.out) as {
      artifacts: Array<{ type: string }>;
      pendingApprovals: Array<{ type: string }>;
      interactions: Array<{ kind: string }>;
    };
    expect(detail.artifacts.map((a) => a.type)).toEqual(
      expect.arrayContaining(["research", "requirements", "spec"]),
    );
    expect(detail.pendingApprovals.map((a) => a.type)).toEqual(["spec"]);
    expect(detail.interactions.map((i) => i.kind)).toEqual(["approval"]);

    // Approve with --commit on the second machine and continue there to the next gate.
    const approved = await jarvis(["--json", "approve", runId, "--commit", "--resume"], {
      cwd: clone,
      homeDir: home2,
    });
    expect(approved.code).toBe(10);
    const file = join(clone, ".jarvis", "approvals", "ABC-62", "spec.json");
    expect(existsSync(file)).toBe(true);
    expect(git(["log", "--format=%s", "-n", "1"], clone)).toContain("jarvis: approve spec for ABC-62");
    const content = JSON.parse(readFileSync(file, "utf8")) as { decision: string; contentRef: string };
    expect(content.decision).toBe("approve");

    // CI on that commit with skip-if-approved passes the spec gate without a human.
    const home3 = join(sb.root, "home3");
    mkdirSync(join(home3, ".jarvis"), { recursive: true });
    userConfig(home3);
    const ci = await jarvis(["--json", "--profile", "ci-skip", "ci", "ABC-62"], {
      cwd: clone,
      homeDir: home3,
    });
    expect(ci.code).toBe(10); // parks later, at the implementation gate
    const parked = JSON.parse(ci.out) as {
      run: { waitingFor?: { detail?: string } };
      steps: Array<{ stepId: string; status: string }>;
    };
    expect(parked.run.waitingFor?.detail).toBe("implementation");
    expect(parked.steps.find((s) => s.stepId === "approve-spec")?.status).toBe("success");
  });
});

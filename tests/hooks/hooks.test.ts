import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run as cli } from "../../src/cli/main.ts";
import { HOOK_MARKER, hookScript } from "../../src/hooks/gitHooks.ts";
import { parsePushRefs, rangesForPush } from "../../src/hooks/range.ts";
import { completion, type FakeOpenAi, startFakeOpenAi } from "../helpers/fakeOpenAi.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let server: FakeOpenAi;
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(args: string[], cwd = sb.project, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv, ...env } });
}

function write(rel: string, content: string) {
  mkdirSync(join(sb.project, rel, ".."), { recursive: true });
  writeFileSync(join(sb.project, rel), content);
}

function commit(message: string) {
  git(["add", "-A"]);
  git(["commit", "-q", "-m", message]);
}

const REVIEW_DOC = (verdict: string, findings: unknown[]) =>
  JSON.stringify({
    summary: "reviewed",
    sources: ["src/util/money.ts"],
    reasons: [],
    standardsChecked: [],
    candidates: [],
    findings,
    verdict,
    outcome: verdict === "approve" ? "ok" : "fix_required",
  });

function project(yaml = "") {
  sb.write(
    "project/.jarvis/project.yaml",
    `version: 1\nworkspace: { mode: cwd }\ntools: { local: { fail: 'exit 3', pass: 'true' } }\n${yaml}`,
  );
}

beforeEach(async () => {
  sb = sandbox();
  server = await startFakeOpenAi();
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
  review: { models: [flash] }
`,
  );
  writeFileSync(join(sb.project, "tsconfig.json"), "{}");
  write("src/util/money.ts", "export function format(n: number) { return String(n); }\n");
  write(
    "src/orders/order.ts",
    "import { format } from '../util/money';\nexport class Order { total() { return format(1); } }\n",
  );
  write(
    "src/orders/order.test.ts",
    "import { Order } from './order';\nimport { describe } from 'vitest';\ndescribe('order', () => new Order());\n",
  );
  project();
  // the sandbox pre-creates an empty .git directory: start over with a real repository
  execFileSync("rm", ["-rf", join(sb.project, ".git")]);
  git(["init", "-q", "-b", "main"]);
  commit("init");
});

afterEach(async () => {
  await server.close();
  sb.cleanup();
});

async function jarvis(args: string[], env: NodeJS.ProcessEnv = {}) {
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
    context: { cwd: sb.project, homeDir: sb.home, env: { PATH: process.env.PATH ?? "", ...env } },
  });
  return { code, out, err };
}

describe("jarvis hooks install / uninstall / status", () => {
  it("installs an executable shim, updates it in place and removes it", async () => {
    const hook = join(sb.project, ".git", "hooks", "pre-push");
    expect((await jarvis(["hooks", "status"])).out).toContain("pre-push hook: missing");
    const first = await jarvis(["hooks", "install"]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("installed");
    const script = readFileSync(hook, "utf8");
    expect(script).toContain(HOOK_MARKER);
    expect(script).toContain('jarvis prepush --hook "$@"');
    expect(execFileSync("test", ["-x", hook])).toBeDefined();
    expect((await jarvis(["hooks", "install"])).out).toContain("updated");
    expect((await jarvis(["hooks", "status"])).out).toContain("pre-push hook: managed");
    const removed = await jarvis(["hooks", "uninstall"]);
    expect(removed.out).toContain("removed");
    expect(existsSync(hook)).toBe(false);
    expect((await jarvis(["hooks", "uninstall"])).out).toContain("no pre-push hook");
  });

  it("never overwrites a foreign hook without --force, backs it up and restores it", async () => {
    const hook = join(sb.project, ".git", "hooks", "pre-push");
    mkdirSync(join(sb.project, ".git", "hooks"), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\necho mine\n");
    chmodSync(hook, 0o755);
    const refused = await jarvis(["hooks", "install"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--force");
    expect(readFileSync(hook, "utf8")).toContain("echo mine");
    expect((await jarvis(["hooks", "uninstall"])).code).toBe(1);
    expect((await jarvis(["hooks", "status"])).out).toContain("foreign");

    const forced = await jarvis(["hooks", "install", "--force"]);
    expect(forced.code).toBe(0);
    expect(forced.out).toContain("pre-jarvis");
    expect(readFileSync(hook, "utf8")).toContain(HOOK_MARKER);
    const removed = await jarvis(["hooks", "uninstall"]);
    expect(removed.out).toContain("previous hook was restored");
    expect(readFileSync(hook, "utf8")).toContain("echo mine");
  });

  it("writes into core.hooksPath when git is configured with one", async () => {
    git(["config", "core.hooksPath", ".githooks"]);
    const result = await jarvis(["hooks", "install", "--json"]);
    const doc = JSON.parse(result.out);
    expect(doc.customHooksPath).toBe(true);
    expect(existsSync(join(sb.project, ".githooks", "pre-push"))).toBe(true);
    expect(existsSync(join(sb.project, ".git", "hooks", "pre-push"))).toBe(false);
  });

  it("the script passes when jarvis cannot be found, and honours JARVIS_SKIP_HOOKS", () => {
    const script = join(sb.root, "hook.sh");
    writeFileSync(script, hookScript());
    chmodSync(script, 0o755);
    const run = (env: Record<string, string>) =>
      execFileSync("/bin/sh", [script], { encoding: "utf8", env: { PATH: "/nonexistent", ...env } });
    expect(() => run({})).not.toThrow();
    expect(() => run({ JARVIS_SKIP_HOOKS: "1" })).not.toThrow();
  });
});

describe("push ranges", () => {
  it("parses git's stdin and skips deletions and non-branch refs", async () => {
    const head = git(["rev-parse", "HEAD"]).trim();
    const zero = "0".repeat(40);
    const refs = parsePushRefs(
      [
        `refs/heads/feat ${head} refs/heads/feat ${zero}`,
        `(delete) ${zero} refs/heads/gone ${head}`,
        `refs/tags/v1 ${head} refs/tags/v1 ${zero}`,
      ].join("\n"),
    );
    expect(refs).toHaveLength(3);
    const ranges = await rangesForPush(sb.project, refs);
    // a new branch on a repository whose only commit is its own tip: compared with the empty tree
    expect(ranges.map((r) => r.branch)).toEqual(["feat"]);
  });

  it("uses the remote tip as the base when the remote already has it", async () => {
    const base = git(["rev-parse", "HEAD"]).trim();
    write("src/a.ts", "export const a = 1;\n");
    commit("a");
    const head = git(["rev-parse", "HEAD"]).trim();
    const [range] = await rangesForPush(sb.project, [
      { localRef: "refs/heads/main", localSha: head, remoteRef: "refs/heads/main", remoteSha: base },
    ]);
    expect(range).toMatchObject({ branch: "main", base, head, baseLabel: "remote tip" });
  });
});

describe("jarvis prepush — deterministic part", () => {
  beforeEach(() => {
    sb.write(
      "project/.jarvis/standards/no-console.md",
      "---\nid: no-console\ntitle: No console\nscope: { paths: ['src/**'] }\nverification:\n  kind: deterministic\n  check: { pattern: { glob: 'src/**/*.ts', mustNot: 'console\\.log' } }\n---\nNo console output.",
    );
    commit("standards");
    git(["branch", "base"]);
    git(["checkout", "-q", "-b", "feature"]);
  });

  it("blocks on a required standard violation and reports the range", async () => {
    write("src/a.ts", "console.log('x');\n");
    commit("add a");
    const result = await jarvis(["prepush", "--base", "base", "--no-semantic", "--json"]);
    expect(result.code).toBe(1);
    const doc = JSON.parse(result.out);
    expect(doc.ok).toBe(false);
    expect(doc.ranges[0].files).toEqual(["src/a.ts"]);
    expect(doc.ranges[0].standards.violations[0]).toMatchObject({
      standardId: "no-console",
      file: "src/a.ts",
    });
    expect(doc.ranges[0].review.decision).toBe("disabled");
    expect(doc.ranges[0].blocking[0]).toContain("no-console");
  });

  it("passes a clean change, and shows the human report", async () => {
    write("src/a.ts", "export const a = 1;\n");
    commit("add a");
    const result = await jarvis(["prepush", "--base", "base", "--no-semantic"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("1 file(s)");
    expect(result.out).toContain("pre-push checks passed");
  });

  it("advisory mode reports but does not block", async () => {
    project("hooks:\n  prePush: { mode: advisory }\n");
    write("src/a.ts", "console.log('x');\n");
    commit("add a");
    const result = await jarvis(["prepush", "--base", "base", "--no-semantic"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("would block (advisory mode)");
  });

  it("runs configured project checks and blocks on a failing one", async () => {
    project("hooks:\n  prePush: { checks: [pass, fail] }\n");
    write("src/a.ts", "export const a = 1;\n");
    commit("add a");
    const result = await jarvis(["prepush", "--base", "base", "--no-semantic", "--json"]);
    expect(result.code).toBe(1);
    const checks = JSON.parse(result.out).ranges[0].checks;
    expect(checks.map((c: { name: string; ok: boolean }) => [c.name, c.ok])).toEqual([
      ["pass", true],
      ["fail", false],
    ]);
  });

  it("checks the pushed commit in a temporary worktree when it is not the checked-out one", async () => {
    write("src/a.ts", "console.log('x');\n");
    commit("add a");
    git(["checkout", "-q", "base"]);
    const result = await jarvis([
      "prepush",
      "--base",
      "base",
      "--head",
      "feature",
      "--no-semantic",
      "--json",
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).ranges[0].standards.violations).toHaveLength(1);
    expect(git(["worktree", "list"]).trim().split("\n")).toHaveLength(1);
  });

  it("skips branches matched by skipBranches", async () => {
    project("hooks:\n  prePush: { skipBranches: ['feat*'] }\n");
    write("src/a.ts", "console.log('x');\n");
    commit("add a");
    const result = await jarvis(["prepush", "--base", "base", "--no-semantic"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("skipped");
  });

  it("does nothing under JARVIS_SKIP_HOOKS", async () => {
    write("src/a.ts", "console.log('x');\n");
    commit("add a");
    const result = await jarvis(["prepush", "--base", "base"], { JARVIS_SKIP_HOOKS: "1" });
    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(0);
  });
});

describe("jarvis prepush — semantic review only when warranted", () => {
  beforeEach(() => {
    git(["branch", "base"]);
    git(["checkout", "-q", "-b", "feature"]);
  });

  it("does not call a model when nothing asks for it", async () => {
    write("docs/note.md", "# note\n");
    commit("docs");
    const result = await jarvis(["prepush", "--base", "base", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).ranges[0].review.decision).toBe("not-needed");
    expect(server.requests).toHaveLength(0);
  });

  it("calls the review agent when the graph shows impacted code and tests left untouched; blockers block", async () => {
    server.respond(() =>
      completion(
        REVIEW_DOC("fix_required", [
          { severity: "blocker", file: "src/util/money.ts", line: 1, issue: "format drops the currency" },
          { severity: "nit", issue: "naming" },
        ]),
      ),
    );
    write("src/util/money.ts", "export function format(n: number) { return n.toFixed(2); }\n");
    commit("change money");
    const result = await jarvis(["prepush", "--base", "base", "--json"]);
    const doc = JSON.parse(result.out);
    const range = doc.ranges[0];
    expect(range.impact.available).toBe(true);
    expect(range.impact.untouchedTests).toContain("src/orders/order.test.ts");
    expect(range.review.decision).toBe("ran");
    expect(range.review.reasons.join(" ")).toContain("test file(s) cover the change");
    expect(range.review.findings).toHaveLength(2);
    expect(result.code).toBe(1);
    expect(range.blocking[0]).toContain("review blocker");
    expect(server.requests.length).toBeGreaterThan(0);
  });

  it("an approving review lets the push through; only findings at blockOn block", async () => {
    server.respond(() =>
      completion(REVIEW_DOC("approve", [{ severity: "major", issue: "consider a test" }])),
    );
    write("src/util/money.ts", "export function format(n: number) { return n.toFixed(2); }\n");
    commit("change money");
    const result = await jarvis(["prepush", "--base", "base"]);
    expect(result.code).toBe(0);
    project("hooks:\n  prePush: { blockOn: major }\n");
    const strict = await jarvis(["prepush", "--base", "base"]);
    expect(strict.code).toBe(1);
  });

  it("an unavailable review (no model for the role) never blocks the push", async () => {
    sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
    write("src/util/money.ts", "export function format(n: number) { return n.toFixed(2); }\n");
    commit("change money");
    const result = await jarvis(["prepush", "--base", "base", "--json"]);
    expect(result.code).toBe(0);
    const review = JSON.parse(result.out).ranges[0].review;
    expect(review.decision).toBe("unavailable");
  });

  it("--semantic forces the review, semanticReview: never and --no-semantic disable it", async () => {
    server.respond(() => completion(REVIEW_DOC("approve", [])));
    write("docs/note.md", "# note\n");
    commit("docs");
    const forced = JSON.parse((await jarvis(["prepush", "--base", "base", "--semantic", "--json"])).out);
    expect(forced.ranges[0].review.decision).toBe("ran");
    const before = server.requests.length;
    project("hooks:\n  prePush: { semanticReview: never }\n");
    write("src/util/money.ts", "export function format(n: number) { return n.toFixed(2); }\n");
    commit("change money");
    const never = JSON.parse((await jarvis(["prepush", "--base", "base", "--json"])).out);
    expect(never.ranges[0].review.decision).toBe("disabled");
    expect(server.requests.length).toBe(before);
  });

  it("deterministic failures skip the paid review", async () => {
    sb.write(
      "project/.jarvis/standards/no-console.md",
      "---\nid: no-console\ntitle: No console\nverification:\n  kind: deterministic\n  check: { pattern: { glob: 'src/**/*.ts', mustNot: 'console\\.log' } }\n---\nNo console output.",
    );
    write(
      "src/util/money.ts",
      "console.log(1);\nexport function format(n: number) { return n.toFixed(2); }\n",
    );
    commit("change money");
    const doc = JSON.parse((await jarvis(["prepush", "--base", "base", "--json"])).out);
    expect(doc.ranges[0].review.decision).toBe("skipped");
    expect(server.requests).toHaveLength(0);
  });
});

describe("the installed hook in a real git push", () => {
  it("blocks a push that violates a required standard and lets a clean one through", async () => {
    // a `jarvis` on PATH that runs this checkout's CLI
    const bin = join(sb.root, "bin");
    mkdirSync(bin, { recursive: true });
    const shim = join(bin, "jarvis");
    writeFileSync(
      shim,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolve("src/cli/main.ts"))} "$@"\n`,
    );
    chmodSync(shim, 0o755);
    sb.write(
      "project/.jarvis/standards/no-console.md",
      "---\nid: no-console\ntitle: No console\nverification:\n  kind: deterministic\n  check: { pattern: { glob: 'src/**/*.ts', mustNot: 'console\\.log' } }\n---\nNo console output.",
    );
    commit("standards");
    const remote = join(sb.root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    git(["remote", "add", "origin", remote]);
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      JARVIS_HOME: join(sb.home, ".jarvis"),
    };
    expect((await jarvis(["hooks", "install"])).code).toBe(0);
    // first push: everything is new
    git(["push", "-q", "origin", "main"], sb.project, env);

    git(["checkout", "-q", "-b", "feature"]);
    write("src/a.ts", "console.log('x');\n");
    commit("bad");
    let message = "";
    try {
      git(["push", "origin", "feature"], sb.project, env);
    } catch (error) {
      message = String((error as { stderr?: string; stdout?: string }).stderr ?? "");
    }
    expect(message).toContain("failed to push");
    expect(git(["ls-remote", "--heads", "origin"], sb.project)).not.toContain("refs/heads/feature");

    // bypass once
    git(["push", "-q", "--no-verify", "origin", "feature"], sb.project, env);
    expect(git(["ls-remote", "--heads", "origin"])).toContain("refs/heads/feature");

    write("src/a.ts", "export const a = 1;\n");
    commit("fix");
    git(["push", "-q", "origin", "feature"], sb.project, env);
    expect(git(["rev-parse", "feature"]).trim()).toBe(
      git(["ls-remote", "origin", "refs/heads/feature"]).split("\t")[0],
    );
  }, 60_000);
});

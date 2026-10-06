import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app/runtime.ts";
import { HeldLease } from "../../src/orchestration/lease.ts";
import { PathPolicy, Redactor } from "../../src/security/redactor.ts";
import { LocalToolProvider } from "../../src/tools/local/provider.ts";
import { capabilityMatches, ToolRegistry } from "../../src/tools/registry.ts";
import { type BoundTools, ToolRouter } from "../../src/tools/router.ts";
import { createRun, testRuntime } from "../helpers/engine.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let rt: Runtime;
let lease: HeldLease;

function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function initRepo(dir: string): void {
  sh(dir, "git", ["init", "-q", "-b", "main"]);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "index.ts"),
    "export const answer = 42;\nexport function canRestartOnboarding() {\n  return true;\n}\n",
  );
  writeFileSync(join(dir, "README.md"), "# demo\n");
  writeFileSync(join(dir, ".env"), "TOKEN=AKIAIOSFODNN7EXAMPLE\n");
  writeFileSync(join(dir, "config.ts"), 'export const key = "AKIAIOSFODNN7EXAMPLE";\n');
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-q", "-m", "init"]);
}

async function setup(
  projectYaml = "version: 1\ntools:\n  local: { echo: 'echo hello-from-project' }\n",
  env: NodeJS.ProcessEnv = {},
) {
  sb.write("project/.jarvis/project.yaml", projectYaml);
  initRepo(sb.project);
  rt = await testRuntime(sb, env);
  const run = createRun(rt, "smoke");
  rt.runs.transition(run.id, "RUNNING");
  const held = HeldLease.acquire(rt.runs, run.id, "cli:test", { heartbeatMs: 0 });
  if (!held) throw new Error("lease");
  lease = held;
  const registry = new ToolRegistry();
  registry.register(new LocalToolProvider(rt.loaded.config));
  const router = new ToolRouter({
    runtime: rt,
    registry,
    redactor: new Redactor({ salt: "t" }),
    pathPolicy: new PathPolicy(),
  });
  const bind = (caps: string[] = ["*"]): BoundTools =>
    router.bind({
      run: rt.runs.require(run.id),
      stepId: "impl",
      iteration: 1,
      lease,
      workspacePath: sb.project,
      agentCapabilities: caps,
      env: { PATH: process.env.PATH ?? "" },
    });
  return { run, router, registry, bind };
}

beforeEach(() => {
  sb = sandbox();
});
afterEach(async () => {
  lease?.release();
  await rt?.close();
  sb.cleanup();
});

describe("capabilityMatches", () => {
  it("supports exact names and globs", () => {
    expect(capabilityMatches("jira.comment", "jira.*")).toBe(true);
    expect(capabilityMatches("jira.comment", "*.comment")).toBe(true);
    expect(capabilityMatches("jira.comment", "jira.get")).toBe(false);
    expect(capabilityMatches("repo.read", "*")).toBe(true);
  });
});

describe("local tools", () => {
  it("lists, reads, searches, writes and edits inside the workspace", async () => {
    const { bind } = await setup();
    const tools = bind();
    const list = await tools.invoke("repo.list");
    expect(list.ok).toBe(true);
    expect(list.text.split("\n")).toEqual(expect.arrayContaining(["src/index.ts", "README.md", "config.ts"]));
    expect(list.text).not.toContain(".env");

    const read = await tools.invoke("repo.read", { path: "src/index.ts", startLine: 2, endLine: 3 });
    expect(read.ok).toBe(true);
    expect(read.text).toContain("    2  export function canRestartOnboarding()");
    expect(read.text).not.toContain("answer");

    const search = await tools.invoke("repo.search", { pattern: "canRestartOnboarding" });
    expect(search.ok).toBe(true);
    expect(search.text).toContain("src/index.ts:2:");
    const literal = await tools.invoke("repo.search", { pattern: "answer = 42", literal: true });
    expect(literal.text).toContain("src/index.ts:1:");
    // a file as `path` (pilot: spawn ENOTDIR) and a directory: hits keep their path from the root
    const inFile = await tools.invoke("repo.search", {
      pattern: "canRestartOnboarding",
      path: "src/index.ts",
    });
    expect(inFile.ok).toBe(true);
    expect(inFile.text).toContain("src/index.ts:2:");
    const inDir = await tools.invoke("repo.search", { pattern: "canRestartOnboarding", path: "src" });
    expect(inDir.text).toContain("src/index.ts:2:");

    const write = await tools.invoke("repo.write", {
      path: "src/new/file.ts",
      content: "export const x = 1;\n",
    });
    expect(write.ok).toBe(true);
    const edit = await tools.invoke("repo.edit", {
      path: "src/index.ts",
      oldText: "answer = 42",
      newText: "answer = 43",
    });
    expect(edit.ok).toBe(true);
    expect((await tools.invoke("repo.read", { path: "src/index.ts" })).text).toContain("answer = 43");
    const missing = await tools.invoke("repo.edit", { path: "src/index.ts", oldText: "nope", newText: "x" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("fragment not found");

    const status = await tools.invoke("git.status");
    expect(status.text).toContain("src/new/");
    const diff = await tools.invoke("git.diff");
    expect(diff.text).toContain("-export const answer = 42");
  });

  it("refuses paths outside the workspace and secret locations, and redacts secrets in output", async () => {
    const { bind } = await setup();
    const tools = bind();
    const outside = await tools.invoke("repo.read", { path: "../../etc/passwd" });
    expect(outside.ok).toBe(false);
    expect(outside.error).toContain("outside the workspace");
    const env = await tools.invoke("repo.read", { path: ".env" });
    expect(env.ok).toBe(false);
    expect(env.error).toContain("secret location");
    expect(rt.events.list({ kind: "security.pathDenied" })).toHaveLength(1);

    const config = await tools.invoke("repo.read", { path: "config.ts" });
    expect(config.ok).toBe(true);
    expect(config.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(config.text).toMatch(/\[REDACTED:aws-access-key:/);
    expect(rt.events.list({ kind: "security.redaction" })).toHaveLength(1);
    const search = await tools.invoke("repo.search", { pattern: "AKIA" });
    expect(search.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(search.text).not.toContain(".env");
  });

  it("caps output and keeps the full redacted text as a blob", async () => {
    const { bind } = await setup("version: 1\ntools:\n  maxOutputBytes: 200\n");
    writeFileSync(join(sb.project, "big.txt"), "x".repeat(2000));
    const r = await bind().invoke("repo.read", { path: "big.txt" });
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(400);
    expect(r.fullRef).toBeDefined();
    expect(rt.blobs.getText(r.fullRef as string).length).toBeGreaterThan(2000);
    const event = rt.events.list({ kind: "tool.call" })[0];
    expect(event?.payload).toMatchObject({ capability: "repo.read", truncated: true });
  });

  it("runs project commands from tools.local and exposes shell.run only when enabled", async () => {
    const { bind, registry } = await setup();
    expect(registry.get("shell.run")).toBeUndefined();
    const r = await bind().invoke("project.echo", { args: "extra" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("hello-from-project extra");
    expect(r.text).toContain("[exit 0");
    lease.release();
    rt.close();
    const withShell = await setup("version: 1\ntools: { shell: true }\n");
    const s = await withShell.bind().invoke("shell.run", { command: "exit 3" });
    expect(s.ok).toBe(false);
    expect(s.error).toBe("exit 3");
  });
});

describe("ToolRouter policy", () => {
  it("filters by agent capability set, profile denies, writes and egress", async () => {
    const { bind, router } = await setup(
      "version: 1\nprofiles:\n  ci: { interactive: false, workspace: { mode: cwd, allowWrites: false }, tools: { deny: ['git.*'] } }\n",
      { JARVIS_PROFILE: "ci" },
    );
    const names = router.allowed(["*"]).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["repo.read", "repo.list", "repo.search"]));
    expect(names).not.toContain("repo.write");
    expect(names).not.toContain("git.status");
    const tools = bind(["repo.read"]);
    expect(tools.list().map((c) => c.name)).toEqual(["repo.read"]);
    const denied = await tools.invoke("repo.search", { pattern: "x" });
    expect(denied.denied).toContain("not in the agent's capability set");
    const write = await bind(["*"]).invoke("repo.write", { path: "a.txt", content: "x" });
    expect(write.denied).toContain("writes are disabled");
    const gitDenied = await bind(["*"]).invoke("git.status");
    expect(gitDenied.denied).toContain('denied by profile "ci"');
    expect(rt.events.list({ kind: "tool.denied" })).toHaveLength(3);
  });

  it("journals effects: git.push runs once and is verified on repeat", async () => {
    const { bind } = await setup();
    const bare = join(sb.root, "remote.git");
    sh(sb.root, "git", ["init", "-q", "--bare", bare]);
    sh(sb.project, "git", ["remote", "add", "origin", bare]);
    const tools = bind();
    writeFileSync(join(sb.project, "pushed.txt"), "1");
    expect((await tools.invoke("git.commit", { message: "add pushed.txt" })).ok).toBe(true);
    const first = await tools.invoke("git.push", { branch: "jarvis/test" });
    expect(first.ok).toBe(true);
    expect(first.source).toBe("executed");
    // A resumed step binds tools afresh (seq restarts) and must not push twice.
    const resumed = bind();
    const again = await resumed.invoke("git.push", { branch: "jarvis/test" });
    expect(again.source).toBe("journal");
    expect(rt.effects.byRun(rt.runs.list()[0]?.id as string).map((e) => e.status)).toEqual(["done"]);
    expect(sh(bare, "git", ["rev-parse", "refs/heads/jarvis/test"]).trim()).toHaveLength(40);
  });
});

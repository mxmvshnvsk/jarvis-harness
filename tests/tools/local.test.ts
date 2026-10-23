import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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
  const bind = (caps: string[] = ["*"], writePaths?: string[]): BoundTools =>
    router.bind({
      run: rt.runs.require(run.id),
      stepId: "impl",
      iteration: 1,
      lease,
      workspacePath: sb.project,
      agentCapabilities: caps,
      ...(writePaths ? { writePaths } : {}),
      env: { PATH: process.env.PATH ?? "" },
    });
  return { run, router, registry, bind };
}

const FIXER = `import { readFileSync, writeFileSync } from "node:fs";
const fix = process.argv.includes("--fix");
let bad = false;
for (const f of process.argv.slice(2).filter((a) => !a.startsWith("--"))) {
  let s = readFileSync(f, "utf8");
  if (fix) { s = s.replace(/\\{(\\w+)\\}/g, "{ $1 }"); writeFileSync(f, s); }
  if (/\\{\\w+\\}/.test(s) || s.includes("BAD")) { console.log(f + ": error, cannot fix"); bad = true; }
}
process.exit(bad ? 1 : 0);
`;

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
    // one level: folders with their file counts, then files; recursive lists them all
    expect(list.text.split("\n")).toEqual(
      expect.arrayContaining(["src/ (1 file)", "README.md", "config.ts"]),
    );
    expect(list.text).not.toContain(".env");
    const all = await tools.invoke("repo.list", { recursive: true });
    expect(all.text.split("\n")).toEqual(expect.arrayContaining(["src/index.ts", "README.md"]));

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
    // the model's arguments lose a trailing newline: the file still ends with one (eol-last)
    await tools.invoke("repo.write", { path: "src/new/no-eol.ts", content: "export const y = 2;" });
    expect(readFileSync(join(sb.project, "src/new/no-eol.ts"), "utf8")).toBe("export const y = 2;\n");
    await tools.invoke("repo.edit", { path: "src/new/no-eol.ts", oldText: "y = 2;\n", newText: "y = 3;" });
    expect(readFileSync(join(sb.project, "src/new/no-eol.ts"), "utf8")).toBe("export const y = 3;\n");
    // a scratch file is refused: the workspace holds only the change (pilot: tmp-nl-probe*.txt in commits)
    const probe = await tools.invoke("repo.write", { path: "tmp-nl-probe2.txt", content: "abc" });
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain("looks like a scratch file");
    const missing = await tools.invoke("repo.edit", { path: "src/index.ts", oldText: "nope", newText: "x" });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("fragment not found");

    const status = await tools.invoke("git.status");
    expect(status.text).toContain("src/new/");
    const diff = await tools.invoke("git.diff");
    expect(diff.text).toContain("-export const answer = 42");
    expect(diff.text).toContain("src/index.ts |");
    expect(diff.text).toContain(
      "[new files not committed yet, not in a diff — repo.read them: src/new/file.ts",
    );
    // tests and snapshots by name only; their path shows them
    writeFileSync(join(sb.project, "src/index.test.ts"), "old\n");
    sh(sb.project, "git", ["add", "-A"]);
    sh(sb.project, "git", ["commit", "-q", "-m", "t"]);
    writeFileSync(join(sb.project, "src/index.test.ts"), "new\n");
    const named = await tools.invoke("git.diff", { base: "HEAD" });
    expect(named.text).toContain(
      "[tests, snapshots, lockfiles — git.diff with their path: src/index.test.ts]",
    );
    expect(named.text).not.toContain("+new");
    expect((await tools.invoke("git.diff", { base: "HEAD", path: "src/index.test.ts" })).text).toContain(
      "+new",
    );
  });

  it("repo.delete removes a file or a folder; an emptied file is said not to be removed", async () => {
    const { bind } = await setup();
    const tools = bind();
    await tools.invoke("repo.write", { path: "src/banner/banner.tsx", content: "export {};\n" });
    await tools.invoke("repo.write", { path: "src/banner/banner.css", content: "a{}\n" });
    // pilot: "" and "null" written to «remove» files, round after round
    const emptied = await tools.invoke("repo.write", { path: "src/banner/banner.tsx", content: "null" });
    expect(emptied.text).toContain("is emptied, not removed");
    const folder = await tools.invoke("repo.delete", { path: "src/banner" });
    expect(folder.ok).toBe(false);
    expect(folder.error).toContain("pass recursive=true");
    const gone = await tools.invoke("repo.delete", { path: "src/banner", recursive: true });
    expect(gone.ok).toBe(true);
    expect(gone.text).toBe("removed src/banner (2 files)");
    expect(existsSync(join(sb.project, "src/banner"))).toBe(false);
    expect((await tools.invoke("repo.delete", { path: "README.md" })).text).toBe("removed README.md");
    expect((await tools.invoke("repo.delete", { path: "README.md" })).error).toContain("removed already");
    expect((await tools.invoke("repo.delete", { path: "." })).ok).toBe(false);
    expect((await tools.invoke("repo.delete", { path: ".env" })).error).toContain("secret location");
    expect((await tools.invoke("repo.delete", { path: "../x" })).error).toContain("outside the workspace");
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
    const redactions = rt.events.list({ kind: "security.redaction" });
    expect(redactions).toHaveLength(1);
    expect(redactions[0]?.payload).toMatchObject({
      boundary: "tool",
      capability: "repo.read",
      count: 1,
      byType: { "aws-access-key": 1 },
    });
    expect(JSON.stringify(redactions[0])).not.toContain("AKIA");
    const search = await tools.invoke("repo.search", { pattern: "AKIA" });
    expect(search.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(search.text).not.toContain(".env");
  });

  it("knowledge.search finds code by symbol and knowledge.read reads the hit (ADR-0015 §2 v0.4)", async () => {
    const { bind } = await setup();
    const tools = bind();
    const found = await tools.invoke("knowledge.search", { query: "restart onboarding", kinds: ["code"] });
    expect(found.ok).toBe(true);
    expect(found.text).toContain("1. src/index.ts:2-4  [code] src/index.ts — canRestartOnboarding");
    const read = await tools.invoke("knowledge.read", { ref: "src/index.ts:2-4" });
    expect(read.text).toBe(
      "src/index.ts:2-4\n    2  export function canRestartOnboarding() {\n    3    return true;\n    4  }",
    );
    // a key in a source file is redacted before it is indexed
    const key = await tools.invoke("knowledge.search", { query: "AKIAIOSFODNN7EXAMPLE", kinds: ["code"] });
    expect(key.text).toBe("no matches");
    const denied = await tools.invoke("knowledge.read", { ref: ".env:1-1" });
    expect(denied.ok).toBe(false);
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

  it("code.diagnostics: the typecheck's and lint's errors in the files asked, as facts", async () => {
    const tsc = [
      "src/index.ts(2,17): error TS2322: Type string is not assignable to type number.",
      "src/other.ts(9,1): error TS2304: Cannot find name 'x'.",
    ].join("\\n");
    const { bind, registry } = await setup(
      `version: 1\ntools:\n  local:\n    typecheck: "printf '${tsc}\\n'; exit 2"\n    lint: "printf 'src/index.ts:3:1: warning: no-console Unexpected console\\n'"\n`,
    );
    expect(registry.get("code.diagnostics")).toBeDefined();
    const r = await bind().invoke("code.diagnostics", { files: ["index.ts"] });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("typecheck: failed · lint: passed");
    expect(r.text).toContain("1 error(s), 1 other in 1 file(s)");
    expect(r.text).toContain(
      "src/index.ts:2:17 error TS2322 Type string is not assignable to type number. (typecheck)",
    );
    expect(r.text).toContain("src/index.ts:3:1 warning no-console Unexpected console (lint)");
    expect(r.text).not.toContain("other.ts");
  });

  it("code.diagnostics does not run the checkers again for a workspace that did not change", async () => {
    const { bind } = await setup(
      `version: 1\ntools:\n  local:\n    typecheck: "echo run >> ../count.txt; true"\n`,
    );
    const count = () =>
      readFileSync(join(sb.project, "..", "count.txt"), "utf8")
        .split("\n")
        .filter(Boolean).length;
    const tools = bind();
    await tools.invoke("code.diagnostics", {});
    const again = await tools.invoke("code.diagnostics", { files: ["index.ts"] });
    expect(count()).toBe(1);
    expect(again.text).toContain("nothing changed since its last run");
    writeFileSync(join(sb.project, "src/index.ts"), "export const answer = 43;\n");
    await tools.invoke("code.diagnostics", {});
    expect(count()).toBe(2);
  });

  it("runs project commands from tools.local and exposes shell.run only when enabled", async () => {
    const { bind, registry } = await setup();
    expect(registry.get("shell.run")).toBeUndefined();
    const r = await bind().invoke("project.echo", { args: "extra" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("hello-from-project extra");
    expect(r.text).toContain("[exit 0");
    // the agent's args are words for the command, not shell (pilot: `2>&1 | tail -120`)
    const quoted = await bind().invoke("project.echo", { args: "x; touch pwned" });
    expect(quoted.text).toContain("hello-from-project 'x;' touch pwned");
    expect(() => readFileSync(join(sb.project, "pwned"))).toThrow();
    const piped = await bind().invoke("project.echo", { args: '--testPathPattern="a|b" 2>&1 | tail -5' });
    expect(piped.ok).toBe(false);
    expect(piped.error).toContain('"2>&1" is not run');
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

describe("builds the checks read (tools.rebuild)", () => {
  it("a check first rebuilds what changed since the last build, once; a rebuild run by hand counts", async () => {
    const { bind } = await setup(
      [
        "version: 1",
        "tools:",
        "  local:",
        '    build-lib: "echo built >> ../build.log"',
        '    typecheck-app: "echo typecheck"',
        "  rebuild:",
        '    - { when: ["lib/**"], run: build-lib }',
      ].join("\n"),
    );
    const tools = bind();
    const builds = () => {
      try {
        return readFileSync(join(sb.root, "build.log"), "utf8").split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    };
    // nothing of the library changed: nothing to rebuild
    expect((await tools.invoke("project.typecheck-app")).text).not.toContain("rebuilt first");
    expect(builds()).toBe(0);
    await tools.invoke("repo.write", { path: "lib/a.ts", content: "export const a = 1;\n" });
    const first = await tools.invoke("project.typecheck-app");
    expect(first.text).toContain("[rebuilt first: build-lib]");
    expect(builds()).toBe(1);
    expect((await tools.invoke("project.typecheck-app")).text).not.toContain("rebuilt first");
    expect(builds()).toBe(1);
    // the library changed again
    utimesSync(join(sb.project, "lib/a.ts"), new Date(), new Date(Date.now() + 5_000));
    expect((await tools.invoke("project.typecheck-app")).text).toContain("rebuilt first");
    expect(builds()).toBe(2);
    // a rebuild run on its own (project.checks does so) makes the next check skip it
    utimesSync(join(sb.project, "lib/a.ts"), new Date(), new Date(Date.now() + 10_000));
    await tools.invoke("project.build-lib");
    expect((await tools.invoke("project.typecheck-app")).text).not.toContain("rebuilt first");
    expect(builds()).toBe(3);
  });

  it("the project's fixer runs on each file an agent writes; what it cannot fix comes back (tools.fix)", async () => {
    const { bind, registry } = await setup(
      [
        "version: 1",
        "tools:",
        "  local:",
        '    fix-src: "cd src && node ../fixer.mjs --fix"',
        "  fix:",
        '    - { when: ["src/**/*.ts"], run: fix-src }',
      ].join("\n"),
    );
    writeFileSync(join(sb.project, "fixer.mjs"), FIXER);
    const tools = bind();
    const fixed = await tools.invoke("repo.write", { path: "src/b.ts", content: "import {a} from './a';\n" });
    expect(fixed.ok).toBe(true);
    expect(fixed.text).toContain(
      "[fix-src: reformatted lines 1–1, which now read as below (the rest is as you wrote it); no problems left]\n    1  import { a } from './a';",
    );
    expect(readFileSync(join(sb.project, "src/b.ts"), "utf8")).toBe("import { a } from './a';\n");
    const edited = await tools.invoke("repo.edit", {
      path: "src/b.ts",
      oldText: "import",
      newText: "BAD import",
    });
    expect(edited.text).toContain(
      "[fix-src found what it cannot fix — correct it:]\nb.ts: error, cannot fix",
    );
    // a file no rule covers: no fixer
    const readme = await tools.invoke("repo.write", { path: "README.md", content: "# x\n" });
    expect(readme.text).toBe("wrote README.md (4 bytes)");
    expect(registry.get("repo.write")?.description).toContain("the project's fixer");
  });

  it("knowledge.read takes an input as the task message names it, a short blob ref, a document without its prefix", async () => {
    const { bind, run } = await setup();
    const tools = bind();
    const design = rt.artifacts.put({
      runId: run.id,
      type: "design",
      name: "design.md",
      content: "# Frames\n",
      provenance: { kind: "tool", capability: "sources.collect" },
    });
    for (const ref of [
      "design/design.md@1",
      "artifact:design/design.md@1",
      "design.md@1",
      `${design.artifactId}@1`,
    ]) {
      const r = await tools.invoke("knowledge.read", { ref });
      expect(r.ok, ref).toBe(true);
      expect(r.text).toContain("# Frames");
    }
    const blob = rt.blobs.put("the original result", "text/plain").contentRef;
    expect((await tools.invoke("knowledge.read", { ref: `blob:${blob.slice(0, 12)}` })).text).toBe(
      "the original result",
    );
    expect((await tools.invoke("knowledge.read", { ref: "blob:abc" })).ok).toBe(false);
    expect((await tools.invoke("knowledge.read", { ref: "design/design.md@7" })).ok).toBe(false);
  });

  it("an agent with write paths cannot write outside them", async () => {
    const { bind } = await setup();
    const tools = bind(["*"], ["**/*.test.ts", "**/__mocks__/**"]);
    const code = await tools.invoke("repo.write", { path: "src/index.ts", content: "export {};\n" });
    expect(code.ok).toBe(false);
    expect(code.denied).toContain("this agent writes only **/*.test.ts, **/__mocks__/**");
    expect(code.denied).toContain("report the defect in your result");
    expect(readFileSync(join(sb.project, "src/index.ts"), "utf8")).toContain("answer = 42");
    expect((await tools.invoke("repo.write", { path: "./src/index.test.ts", content: "test;\n" })).ok).toBe(
      true,
    );
    expect((await tools.invoke("repo.write", { path: "src/__mocks__/api.ts", content: "x;\n" })).ok).toBe(
      true,
    );
  });
});

describe("repo.read of a long file", () => {
  // a Java class of ~450 lines: two methods among filler
  const LONG = [
    "package a;",
    "@Service",
    "public class OrderService implements Orders {",
    "  private final OrderRepository repo;",
    "  @Transactional",
    "  public Order find(String id) {",
    "    return repo.find(id);",
    "  }",
    ...Array.from({ length: 440 }, (_, i) => `  // filler ${i}`),
    "  void cancel(Order o, String why) {",
    "    repo.save(o);",
    "  }",
    "}",
  ].join("\n");

  it("comes as its outline; a symbol as its lines; full as all of it", async () => {
    const { bind } = await setup();
    writeFileSync(join(sb.project, "src", "OrderService.java"), LONG);
    const tools = bind();
    const outline = await tools.invoke("repo.read", { path: "src/OrderService.java" });
    expect(outline.text.split("\n")).toEqual([
      "src/OrderService.java: 452 lines — its outline (read whole only if you need all of it):",
      "@Service class OrderService implements Orders  [2-452]",
      "  fields: repo: OrderRepository",
      "  @Transactional find(String): Order  [5-8]",
      "  cancel(Order, String): void  [449-451]",
      'Read a part: repo.read with symbol (e.g. "OrderService.find") or startLine/endLine; full: true for the whole file.',
    ]);
    const find = await tools.invoke("repo.read", {
      path: "src/OrderService.java",
      symbol: "OrderService.find",
    });
    expect(find.text.split("\n")).toEqual([
      "OrderService.find/1 (src/OrderService.java:5-8)",
      "    5    @Transactional",
      "    6    public Order find(String id) {",
      "    7      return repo.find(id);",
      "    8    }",
    ]);
    expect(
      (await tools.invoke("repo.read", { path: "src/OrderService.java", symbol: "cancel" })).text,
    ).toContain("  450      repo.save(o);");
    const missing = await tools.invoke("repo.read", { path: "src/OrderService.java", symbol: "refund" });
    expect(missing).toMatchObject({ ok: false });
    expect(missing.error).toContain("it has: OrderService, OrderService.find, OrderService.cancel");
    const full = await tools.invoke("repo.read", { path: "src/OrderService.java", full: true });
    expect(full.text.split("\n")).toHaveLength(452);
    // a short file or a range reads as before
    expect(
      (await tools.invoke("repo.read", { path: "src/OrderService.java", startLine: 6, endLine: 6 })).text,
    ).toBe("    6    public Order find(String id) {");
  });
});

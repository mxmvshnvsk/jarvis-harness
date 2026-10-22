import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime } from "../../src/app/runtime.ts";
import { run } from "../../src/cli/main.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import { branchNameFor, WorktreeWorkspace } from "../../src/orchestration/worktree.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
const gitEnv = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function sh(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } });
}

beforeEach(() => {
  sb = sandbox();
  sh(sb.project, ["init", "-q", "-b", "main"]);
  writeFileSync(join(sb.project, "README.md"), "# demo\n");
  writeFileSync(join(sb.project, ".gitignore"), ".setup-ran\n");
  sb.write("home/.jarvis/config.yaml", "version: 1\nactor: { id: me@corp }\n");
  sb.write(
    "project/.jarvis/project.yaml",
    "version: 1\nworkspace:\n  setup: 'echo setup > .setup-ran'\ntools:\n  local: { lines: 'wc -l README.md' }\n",
  );
  sb.write(
    "project/.jarvis/workflows/touch.yaml",
    `name: touch
entry: write
steps:
  - id: write
    kind: deterministic
    tool: repo.write
    args: { path: "src/generated.ts", content: "export const generated = true;\\n" }
    transitions: { onSuccess: count }
  - id: count
    kind: deterministic
    tool: project.lines
    transitions: { onSuccess: DONE }
`,
  );
  sh(sb.project, ["add", "-A"]);
  sh(sb.project, ["commit", "-q", "-m", "init"]);
});
afterEach(() => sb.cleanup());

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

describe("worktree workspace end to end (ADR-0003)", () => {
  it("runs in a worktree, commits checkpoints with trailers, diffs, applies and gcs", async () => {
    const r = await jarvis(["--json", "work", "ABC-9", "--workflow", "touch"]);
    expect(r.code).toBe(0);
    const detail = JSON.parse(r.out) as {
      run: { id: string; workspace: { mode: string; path: string; branch: string; baseCommit: string } };
      checkpoint: { headCommit: string };
    };
    const ws = detail.run.workspace;
    expect(ws.mode).toBe("worktree");
    expect(ws.branch).toBe(branchNameFor("ABC-9", detail.run.id));
    // a path a person can tell apart: <repository>/<run>-<task>
    expect(ws.path).toMatch(/\/worktrees\/project\/[0-9a-f]{8}-ABC-9$/);
    expect(existsSync(join(ws.path, ".setup-ran"))).toBe(true);
    expect(existsSync(join(ws.path, "src", "generated.ts"))).toBe(true);
    // The main checkout is untouched (ADR-0003 §4).
    expect(existsSync(join(sb.project, "src", "generated.ts"))).toBe(false);
    const log = sh(ws.path, ["log", "--format=%s%n%b", "-n", "3"]);
    expect(log).toContain("jarvis: write #1 success");
    expect(log).toContain(`Jarvis-Run: ${detail.run.id}`);
    expect(detail.checkpoint.headCommit).not.toBe(ws.baseCommit);
    // A tool-output artifact captured the project command.
    const status = await jarvis(["status", detail.run.id]);
    expect(status.out).toContain("tool-output/count.txt@1");

    const diff = await jarvis(["diff", detail.run.id]);
    expect(diff.code).toBe(0);
    expect(diff.out).toContain("+export const generated = true;");

    const apply = await jarvis(["apply", detail.run.id]);
    expect(apply.code).toBe(0);
    expect(apply.out).toContain("applied 1 file(s)");
    expect(readFileSync(join(sb.project, "src", "generated.ts"), "utf8")).toContain("generated = true");
    expect(sh(sb.project, ["log", "--format=%s", "-n", "1"])).toContain("ABC-9: apply jarvis run");

    const gcKeep = await jarvis(["--json", "gc"]);
    expect(JSON.parse(gcKeep.out)).toMatchObject({ removed: [], kept: [detail.run.id] });
    const gcNow = await jarvis(["--json", "gc", "--days", "0", "--prune-branches"]);
    expect(JSON.parse(gcNow.out)).toMatchObject({ removed: [detail.run.id] });
    expect(existsSync(ws.path)).toBe(false);
    expect(gcNow.err).toContain("removing its checkout and branch");
    expect(sh(sb.project, ["branch", "--list", "jarvis/*"]).trim()).toBe("");
    // the files go in the background: the folder set aside disappears too
    for (let i = 0; i < 100 && readdirSync(dirname(ws.path)).some((n) => n.includes(".removing-")); i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(dirname(ws.path)).filter((n) => n.includes(".removing-"))).toEqual([]);
    expect(sh(sb.project, ["worktree", "list"]).trim().split("\n")).toHaveLength(1);
  });

  it("checkout: clone — a shared clone with its own .git; its branch in the repository, diffs, applies and gcs", async () => {
    sb.write(
      "project/.jarvis/project.yaml",
      "version: 1\nworkspace:\n  checkout: clone\n  setup: 'echo setup > .setup-ran'\ntools:\n  local: { lines: 'wc -l README.md' }\n",
    );
    sh(sb.project, ["add", "-A"]);
    sh(sb.project, ["commit", "-q", "-m", "clone"]);
    const r = await jarvis(["--json", "work", "ABC-10", "--workflow", "touch"]);
    expect(r.code).toBe(0);
    const detail = JSON.parse(r.out) as {
      run: { id: string; workspace: { path: string; branch: string; checkout?: string } };
    };
    const ws = detail.run.workspace;
    expect(ws.checkout).toBe("clone");
    // a .git directory of its own (tools that read git with JGit), the objects borrowed
    expect(statSync(join(ws.path, ".git")).isDirectory()).toBe(true);
    expect(readFileSync(join(ws.path, ".git", "objects", "info", "alternates"), "utf8")).toContain(
      sb.project,
    );
    expect(sh(sb.project, ["worktree", "list"]).trim().split("\n")).toHaveLength(1);
    // every commit of the run is on its branch in the repository
    expect(sh(sb.project, ["rev-parse", ws.branch]).trim()).toBe(sh(ws.path, ["rev-parse", "HEAD"]).trim());
    expect((await jarvis(["diff", detail.run.id])).out).toContain("+export const generated = true;");
    expect((await jarvis(["apply", detail.run.id])).code).toBe(0);
    expect(readFileSync(join(sb.project, "src", "generated.ts"), "utf8")).toContain("generated = true");
    const gc = await jarvis(["--json", "gc", "--days", "0", "--prune-branches"]);
    expect(JSON.parse(gc.out)).toMatchObject({ removed: [detail.run.id] });
    expect(existsSync(ws.path)).toBe(false);
    expect(sh(sb.project, ["branch", "--list", "jarvis/*"]).trim()).toBe("");
  });

  it("refuses to apply onto a dirty main checkout and reports conflicts", async () => {
    const r = await jarvis(["--json", "work", "ABC-10", "--workflow", "touch"]);
    const detail = JSON.parse(r.out) as { run: { id: string } };
    writeFileSync(join(sb.project, "README.md"), "# dirty\n");
    const dirty = await jarvis(["apply", detail.run.id]);
    expect(dirty.code).toBe(1);
    expect(dirty.err).toContain("uncommitted changes");
    sh(sb.project, ["checkout", "--", "README.md"]);
    mkdirSync(join(sb.project, "src"), { recursive: true });
    writeFileSync(join(sb.project, "src", "generated.ts"), "export const generated = false;\n");
    sh(sb.project, ["add", "-A"]);
    sh(sb.project, ["commit", "-q", "-m", "conflicting"]);
    const conflict = await jarvis(["apply", detail.run.id]);
    expect(conflict.code).toBe(1);
    expect(conflict.err).toContain("conflicts");
    expect(sh(sb.project, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("applies the run's own changes even when the branch's commit was amended after the run started (pilot)", async () => {
    const r = await jarvis(["--json", "work", "ABC-11", "--workflow", "touch"]);
    const detail = JSON.parse(r.out) as { run: { id: string } };
    // the person amends the commit the run started from: the run's base is no longer in the branch
    writeFileSync(join(sb.project, "README.md"), "# demo, amended\n");
    sh(sb.project, ["commit", "-q", "-a", "--amend", "--no-edit"]);
    const apply = await jarvis(["apply", detail.run.id]);
    expect(apply.err).toBe("");
    expect(apply.code).toBe(0);
    expect(existsSync(join(sb.project, "src", "generated.ts"))).toBe(true);
    expect(readFileSync(join(sb.project, "README.md"), "utf8")).toBe("# demo, amended\n");
    expect(sh(sb.project, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("says what it prepares, and a failed setup leaves no worktree or branch behind (pilot)", async () => {
    sb.write("project/.jarvis/project.yaml", "version: 1\nworkspace:\n  setup: 'echo boom >&2; exit 3'\n");
    sh(sb.project, ["add", "-A"]);
    sh(sb.project, ["commit", "-q", "-m", "broken setup"]);
    const r = await jarvis(["work", "T-1", "--workflow", "smoke"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("◌ own checkout");
    expect(r.err).toContain("◌ workspace.setup echo boom >&2; exit 3");
    expect(r.err).toContain("error[J006]: workspace.setup failed (exit 3): boom");
    expect(r.err).toContain("JARVIS_WORKSPACE__MODE=cwd");
    expect(sh(sb.project, ["worktree", "list"]).trim().split("\n")).toHaveLength(1);
    expect(sh(sb.project, ["branch", "--list", "jarvis/*"]).trim()).toBe("");
  });

  it("names the branch readably: ticket key, Cyrillic in Latin letters, no punctuation (pilot)", () => {
    expect(branchNameFor("ABC-123 fix the form", "run_6e744e0a434e")).toBe("jarvis/ABC-123/6e744e0a");
    expect(
      branchNameFor("Баг: в компактном режиме (web-app, compact) при включении…", "run_6e744e0a434e"),
    ).toBe("jarvis/bag-v-kompaktnom-rezhime-web-app-compact/6e744e0a");
    expect(branchNameFor("¿…?", "run_6e744e0a434e")).toBe("jarvis/task/6e744e0a");
  });

  it("project.checks runs the package's test/typecheck commands for what changed, without a model", async () => {
    sb.write(
      "project/.jarvis/project.yaml",
      [
        "version: 1",
        "workspace: { mode: cwd, allowWrites: true }",
        "tools:",
        "  local:",
        '    test-pkg: "cd pkg && echo tests ran in pkg && exit 3"',
        '    test-jest: "cd pkg && echo jest"',
        '    test-long: "cd pkg && seq 1 60 && exit 4"',
        '    typecheck-other: "cd other && echo never"',
        '    lint: "echo not a check"',
      ].join("\n"),
    );
    sb.write(
      "project/.jarvis/workflows/chk.yaml",
      `name: chk
entry: change
steps:
  - id: change
    kind: deterministic
    tool: repo.write
    args: { path: "pkg/a.ts", content: "export const a = 1;\\n" }
    transitions: { onSuccess: checks }
  - id: checks
    kind: deterministic
    tool: project.checks
    outputs: [checks]
    transitions: { onSuccess: DONE, onOutcome: { defects_found: { to: change, maxIterations: 1 } } }
`,
    );
    sh(sb.project, ["add", "-A"]);
    sh(sb.project, ["commit", "-q", "-m", "checks"]);
    const r = await jarvis(["work", "T-2", "--workflow", "chk"]);
    expect(r.err).toContain("✓ [2/2] checks");
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    const runId = rt.runs.list({ includeTerminal: true })[0]?.id as string;
    const checks = JSON.parse(rt.artifacts.text(rt.artifacts.listLatest(runId, "checks")[0] as never)) as {
      changed: string[];
      results: Array<{ check: string; command: string; ok: boolean; skipped?: string; tail?: string }>;
      reasons: Array<{ summary: string }>;
    };
    const logs = rt.artifacts.listLatest(runId, "check-log");
    const logText = logs[0] ? rt.artifacts.text(logs[0]) : "";
    rt.close();
    expect(logs.map((l) => l.name)).toEqual(["test-long.log"]);
    expect(logText).toContain("\n1\n2\n");
    expect(logText).toContain("[exit 4");
    expect(checks.changed).toEqual(["pkg/a.ts"]);
    expect(checks.results.map((r) => [r.check, r.ok, r.skipped ?? ""])).toEqual([
      ["test-pkg", false, ""],
      ["test-jest", true, ""],
      ["test-long", false, ""],
      ["typecheck-other", true, "no changed code in its scope"],
      ["lint", true, ""],
    ]);
    expect(checks.results[4]?.command).toBe("echo not a check pkg/a.ts");
    // a long failed output: its tail for the reasons, the whole of it kept as a log
    const long = checks.results[2] as { tail?: string; log?: string };
    expect(long.tail?.split("\n")).toHaveLength(40);
    expect(long.log).toMatch(/^art_\w+@\d+$/);
    expect((checks.results[0] as { log?: string }).log).toBeUndefined();
    // jest on the related tests only, and no related test is not a failure
    expect(checks.results[1]?.command).toBe("cd pkg && echo jest --passWithNoTests --findRelatedTests a.ts");
    // what the command printed, not only its last lines: the agent's reason
    expect(checks.reasons[0]?.summary).toContain(
      "test-pkg failed:\n$ cd pkg && echo tests ran in pkg && exit 3\ntests ran in pkg",
    );
  });

  it("project.checks gives a Gradle test task the test classes the project graph says cover the change", async () => {
    const main = "src/main/java/com/example/orders";
    const test = "src/test/groovy/com/example/orders";
    sb.write(
      "project/.jarvis/project.yaml",
      [
        "version: 1",
        "workspace: { mode: cwd, allowWrites: true }",
        "tools:",
        "  local:",
        '    test: "echo ./gradlew test"',
        '    test-slots: "cd slots && echo ./gradlew test"',
      ].join("\n"),
    );
    sb.write("project/build.gradle", "plugins { id 'java' }\n");
    sb.write(`project/${main}/Order.java`, "package com.example.orders;\npublic class Order {}\n");
    sb.write(
      `project/${main}/OrderRepository.java`,
      "package com.example.orders;\npublic interface OrderRepository { Order find(); }\n",
    );
    sb.write(`project/${main}/Unrelated.java`, "package com.example.orders;\npublic class Unrelated {}\n");
    sb.write(
      `project/${test}/BaseOrderSpecification.groovy`,
      "package com.example.orders\nabstract class BaseOrderSpecification { OrderRepository repo }\n",
    );
    sb.write(
      `project/${test}/FindOrderSpecification.groovy`,
      "package com.example.orders\nclass FindOrderSpecification extends BaseOrderSpecification {}\n",
    );
    sb.write(
      "project/slots/src/test/java/com/example/slots/SlotTest.java",
      "package com.example.slots;\nclass SlotTest { Order o; }\n",
    );
    sb.write(
      "project/.jarvis/workflows/chk.yaml",
      `name: chk
entry: discover
steps:
  - id: discover
    kind: deterministic
    tool: project.discover
    transitions: { onSuccess: change }
  - id: change
    kind: deterministic
    tool: repo.write
    args: { path: "${main}/Order.java", content: "package com.example.orders;\\npublic class Order { int total; }\\n" }
    transitions: { onSuccess: added }
  - id: added
    kind: deterministic
    tool: repo.write
    args: { path: "${test}/NewOrderTest.groovy", content: "package com.example.orders\\nclass NewOrderTest {}\\n" }
    transitions: { onSuccess: checks }
  - id: checks
    kind: deterministic
    tool: project.checks
    outputs: [checks]
    transitions: { onSuccess: DONE }
`,
    );
    sh(sb.project, ["add", "-A"]);
    sh(sb.project, ["commit", "-q", "-m", "jvm"]);
    const r = await jarvis(["work", "T-5", "--workflow", "chk"]);
    expect(r.err).toContain("✓ [4/4] checks");
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    const runId = rt.runs.list({ includeTerminal: true })[0]?.id as string;
    const checks = JSON.parse(rt.artifacts.text(rt.artifacts.listLatest(runId, "checks")[0] as never)) as {
      results: Array<{ check: string; command: string; ok: boolean; skipped?: string }>;
    };
    rt.close();
    // through the base test class, and the new test of the run itself; not the other module's
    expect(checks.results.map((x) => [x.check, x.command, x.skipped ?? ""])).toEqual([
      [
        "test",
        "echo ./gradlew test --tests com.example.orders.FindOrderSpecification --tests com.example.orders.NewOrderTest",
        "",
      ],
      ["test-slots", "cd slots && echo ./gradlew test", "no changed code in its scope"],
    ]);
  });

  it("project.checks says why JavaScript tests failed: the runner's JSON report, else its printed output", async () => {
    sb.write(
      "project/.jarvis/project.yaml",
      [
        "version: 1",
        "workspace: { mode: cwd, allowWrites: true }",
        "tools:",
        "  local:",
        '    test-app: "cd app && npm test"',
        '    test-old: "cd old && npm test"',
      ].join("\n"),
    );
    // jest behind `npm test`: writes its JSON report where --outputFile says
    sb.write("project/app/package.json", JSON.stringify({ name: "app", scripts: { test: "jest" } }));
    sb.write(
      "project/app/node_modules/.bin/jest",
      [
        "#!/bin/sh",
        'for a in "$@"; do case "$a" in --outputFile=*) out="${a#--outputFile=}";; esac; done',
        'echo "Tests: 1 failed, 2 total"',
        `printf '%s' '${JSON.stringify({
          numTotalTests: 2,
          testResults: [
            {
              name: "__APP__/src/a.test.js",
              status: "failed",
              assertionResults: [
                {
                  status: "failed",
                  title: "adds",
                  ancestorTitles: ["math"],
                  failureMessages: [
                    "Error: expect(received).toBe(expected)\n\nExpected: 3\nReceived: 4\n    at Object.<anonymous> (__APP__/src/a.test.js:4:15)",
                  ],
                },
              ],
            },
          ],
        })}' | sed "s#__APP__#$PWD#g" > "$out"`,
        "exit 1",
      ].join("\n"),
    );
    // an old jest that knows no --json: refuses it, then prints its failure
    sb.write("project/old/package.json", JSON.stringify({ name: "old", scripts: { test: "jest" } }));
    sb.write(
      "project/old/node_modules/.bin/jest",
      [
        "#!/bin/sh",
        'case "$*" in *--json*) echo "Unknown option: --json"; exit 1;; esac',
        "printf 'FAIL src/b.test.js\\n  ● b › subtracts\\n\\n    Expected: 1\\n    Received: 2\\n\\n      at Object.<anonymous> (src/b.test.js:7:3)\\n\\nTests: 1 failed\\n'",
        "exit 1",
      ].join("\n"),
    );
    execFileSync("chmod", [
      "+x",
      join(sb.project, "app/node_modules/.bin/jest"),
      join(sb.project, "old/node_modules/.bin/jest"),
    ]);
    sb.write("project/.gitignore", "node_modules/\n");
    sb.write("project/app/src/a.js", "module.exports = 1;\n");
    sb.write("project/app/src/a.test.js", "test('adds', () => {});\n");
    sb.write("project/old/src/b.js", "module.exports = 1;\n");
    sb.write(
      "project/.jarvis/workflows/chk.yaml",
      `name: chk
entry: a
steps:
  - id: a
    kind: deterministic
    tool: repo.write
    args: { path: "app/src/a.js", content: "module.exports = 2;\\n" }
    transitions: { onSuccess: b }
  - id: b
    kind: deterministic
    tool: repo.write
    args: { path: "old/src/b.js", content: "module.exports = 2;\\n" }
    transitions: { onSuccess: checks }
  - id: checks
    kind: deterministic
    tool: project.checks
    outputs: [checks]
    transitions: { onSuccess: DONE, onOutcome: { defects_found: { to: DONE } } }
`,
    );
    sh(sb.project, ["add", "-A"]);
    sh(sb.project, ["commit", "-q", "-m", "js"]);
    await jarvis(["work", "T-9", "--workflow", "chk"]);
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    const runId = rt.runs.list({ includeTerminal: true })[0]?.id as string;
    const checks = JSON.parse(rt.artifacts.text(rt.artifacts.listLatest(runId, "checks")[0] as never)) as {
      results: Array<{
        check: string;
        command: string;
        ok: boolean;
        failures?: Array<Record<string, unknown>>;
        tests?: unknown;
      }>;
    };
    rt.close();
    const [app, old] = checks.results;
    expect(app).toMatchObject({
      check: "test-app",
      // jest behind the npm script: on the tests related to the change, its arguments after `--`
      command: "cd app && npm test -- --passWithNoTests --findRelatedTests src/a.js",
      ok: false,
      tests: { failed: 1, total: 2 },
    });
    expect(app?.failures?.[0]).toMatchObject({
      suite: "math",
      name: "adds",
      file: "app/src/a.test.js",
      expected: "3",
      actual: "4",
    });
    expect((app?.failures?.[0]?.stack as Array<{ file: string }> | undefined)?.[0]?.file).toBe(
      "app/src/a.test.js",
    );
    expect(old?.failures?.[0]).toMatchObject({ suite: "b", name: "subtracts", expected: "1", actual: "2" });
    // the reasons the implementation goes back with: the test, what was expected, where
    const reasons = (checks as unknown as { reasons: Array<{ summary: string; sourceRefs: string[] }> })
      .reasons;
    expect(reasons[0]?.summary).toBe(
      'test-app: test "math › adds" failed: Error: expect(received).toBe(expected); expected 3, got 4 — at app/src/a.test.js:4',
    );
    expect(reasons[0]?.sourceRefs).toEqual(["check:test-app", "app/src/a.test.js:4"]);
  });

  // a Gradle stand-in: runs the classes of `--tests` (or all of all.txt), fails those listed in fails.txt
  const FAKE_GRADLEW = [
    "#!/bin/sh",
    "shift",
    'classes=""',
    'while [ $# -gt 0 ]; do if [ "$1" = "--tests" ]; then classes="$classes $2"; shift; fi; shift; done',
    '[ -z "$classes" ] && classes=$(cat all.txt)',
    "mkdir -p build/test-results/test",
    "code=0",
    "for c in $classes; do",
    '  f=0; grep -qx "$c" fails.txt && f=1 && code=1',
    '  if [ $f = 1 ]; then tc="<testcase classname=\\"$c\\" name=\\"works()\\"><failure message=\\"expected: &lt;1&gt; but was: &lt;2&gt;\\">expected: &lt;1&gt; but was: &lt;2&gt;&#10;	at $c.works(T.java:12)</failure></testcase>"; else tc="<testcase classname=\\"$c\\" name=\\"works()\\"/>"; fi',
    '  echo "<testsuite name=\\"$c\\" tests=\\"1\\" failures=\\"$f\\" errors=\\"0\\">$tc</testsuite>" > "build/test-results/test/TEST-$c.xml"',
    '  [ $f = 1 ] && echo "$c > works() FAILED"',
    "done",
    "exit $code",
  ].join("\n");

  async function baselineRun(
    task: string,
    fails: string,
  ): Promise<
    Array<{ check: string; ok: boolean; preexisting?: string[]; tail?: string; failures?: unknown[] }>
  > {
    sb.write(
      "project/.jarvis/project.yaml",
      [
        "version: 1",
        "workspace: { mode: cwd, allowWrites: true }",
        "tools:",
        "  local:",
        '    test: "./gradlew test"',
      ].join("\n"),
    );
    sb.write("project/.gitignore", "build/\n.setup-ran\n");
    sb.write("project/gradlew", FAKE_GRADLEW);
    execFileSync("chmod", ["+x", join(sb.project, "gradlew")]);
    sb.write("project/all.txt", "a.OldTest\na.NewTest\n");
    sb.write("project/fails.txt", "a.OldTest\n");
    sb.write("project/src/main/java/a/A.java", "package a;\npublic class A {}\n");
    sb.write(
      "project/.jarvis/workflows/chk.yaml",
      `name: chk
entry: change
steps:
  - id: change
    kind: deterministic
    tool: repo.write
    args: { path: "src/main/java/a/A.java", content: "package a;\\npublic class A { int x; }\\n" }
    transitions: { onSuccess: fails }
  - id: fails
    kind: deterministic
    tool: repo.write
    args: { path: "fails.txt", content: "${fails}" }
    transitions: { onSuccess: checks }
  - id: checks
    kind: deterministic
    tool: project.checks
    outputs: [checks]
    transitions: { onSuccess: DONE, onOutcome: { defects_found: { to: DONE } } }
`,
    );
    sh(sb.project, ["add", "-A"]);
    sh(sb.project, ["commit", "-q", "-m", "gradle"]);
    const r = await jarvis(["work", task, "--workflow", "chk"]);
    if (!r.err.includes("checks")) throw new Error(r.err + r.out);
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    const runId = rt.runs.list({ includeTerminal: true })[0]?.id as string;
    const checks = JSON.parse(rt.artifacts.text(rt.artifacts.listLatest(runId, "checks")[0] as never)) as {
      results: Array<{ check: string; ok: boolean; preexisting?: string[]; tail?: string }>;
    };
    rt.close();
    return checks.results;
  }

  it("project.checks excuses test classes that fail on the base commit too, and only those", async () => {
    // the base fails a.OldTest already; the run fails nothing new: no defect
    expect(await baselineRun("T-6", "a.OldTest\\n")).toEqual([
      { check: "test", command: "./gradlew test", ok: true, preexisting: ["a.OldTest"] },
    ]);
    // no checkout of the base is left behind
    expect(sh(sb.project, ["worktree", "list"]).trim().split("\n")).toHaveLength(1);
  });

  it("project.checks fails on a test the run broke, naming the ones broken before it", async () => {
    const [test] = await baselineRun("T-7", "a.OldTest\\na.NewTest\\n");
    expect(test).toMatchObject({ check: "test", ok: false, preexisting: ["a.OldTest"] });
    expect(test?.tail).toContain("a.NewTest > works() FAILED");
    // why: each failed test from the reports, the one failing on the base too marked so
    const failures = (test as { failures?: Array<Record<string, unknown>> }).failures ?? [];
    expect(failures.map((f) => [f.suite, f.name, f.expected, f.actual, f.preexisting ?? false])).toEqual([
      ["a.NewTest", "works()", "1", "2", false],
      ["a.OldTest", "works()", "1", "2", true],
    ]);
    expect((test as { tests?: unknown }).tests).toEqual({ failed: 2, total: 2 });
  });

  it("project.checks fixes first, lints the changed files and runs a check its files call for (tools.fix, tools.checks)", async () => {
    sb.write(
      "project/.jarvis/project.yaml",
      [
        "version: 1",
        "workspace: { mode: cwd, allowWrites: true }",
        "tools:",
        "  local:",
        '    fix-pkg: "cd pkg && node ../fixer.mjs --fix"',
        '    lint-pkg: "cd pkg && node ../fixer.mjs"',
        '    snap-check: "echo snapshot checked"',
        '    never-check: "echo never"',
        "  fix:",
        '    - { when: ["pkg/**/*.ts"], run: fix-pkg }',
        "  checks:",
        '    - { when: ["pkg/**"], run: snap-check }',
        '    - { when: ["other/**"], run: never-check }',
      ].join("\n"),
    );
    sb.write("project/fixer.mjs", FIXER);
    sb.write(
      "project/.jarvis/workflows/chk.yaml",
      `name: chk
entry: change
steps:
  - id: change
    kind: deterministic
    tool: repo.write
    args: { path: "pkg/a.ts", content: "import {a} from './b';\\n" }
    transitions: { onSuccess: checks }
  - id: checks
    kind: deterministic
    tool: project.checks
    outputs: [checks]
    transitions: { onSuccess: DONE, onOutcome: { defects_found: { to: change, maxIterations: 1 } } }
`,
    );
    sh(sb.project, ["add", "-A"]);
    sh(sb.project, ["commit", "-q", "-m", "checks"]);
    // a file the agent did not write through repo.write: the fixer before the checks takes it
    sb.write("project/pkg/c.ts", "export {x} from './a';\n");
    const r = await jarvis(["work", "T-4", "--workflow", "chk"]);
    expect(r.err).toContain("✓ [2/2] checks");
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    const runId = rt.runs.list({ includeTerminal: true })[0]?.id as string;
    const checks = JSON.parse(rt.artifacts.text(rt.artifacts.listLatest(runId, "checks")[0] as never)) as {
      results: Array<{ check: string; command: string; ok: boolean; skipped?: string; fixed?: string[] }>;
    };
    rt.close();
    expect(checks.results.map((x) => [x.check, x.ok, x.fixed ?? []])).toEqual([
      ["fix:fix-pkg", true, ["pkg/c.ts"]],
      ["lint-pkg", true, []],
      ["snap-check", true, []],
    ]);
    expect(checks.results[1]?.command).toBe("cd pkg && node ../fixer.mjs a.ts c.ts");
    expect(readFileSync(join(sb.project, "pkg/a.ts"), "utf8")).toBe("import { a } from './b';\n");
  });

  it("project.checks rebuilds what a package reads built, then typechecks its dependents (tools.rebuild)", async () => {
    sb.write(
      "project/.jarvis/project.yaml",
      [
        "version: 1",
        "workspace: { mode: cwd, allowWrites: true }",
        "tools:",
        "  local:",
        '    build-lib: "echo lib built"',
        '    build-docs: "echo docs && exit 4"',
        '    typecheck-app: "cd app && echo typecheck app"',
        '    test-app: "cd app && echo never"',
        "  rebuild:",
        '    - { when: ["lib/**"], run: build-lib }',
        '    - { when: ["lib/**/*.ts"], run: build-lib }',
        '    - { when: ["docs/**"], run: build-docs }',
      ].join("\n"),
    );
    sb.write("project/app/index.ts", "export {};\n");
    sb.write(
      "project/.jarvis/workflows/chk.yaml",
      `name: chk
entry: change
steps:
  - id: change
    kind: deterministic
    tool: repo.write
    args: { path: "lib/a.ts", content: "export const a = 1;\\n" }
    transitions: { onSuccess: checks }
  - id: checks
    kind: deterministic
    tool: project.checks
    outputs: [checks]
    transitions: { onSuccess: DONE, onOutcome: { defects_found: { to: change, maxIterations: 1 } } }
`,
    );
    sh(sb.project, ["add", "-A"]);
    sh(sb.project, ["commit", "-q", "-m", "checks"]);
    await jarvis(["work", "T-3", "--workflow", "chk"]);
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const rt = createRuntime(loaded, { env: {} });
    const runId = rt.runs.list({ includeTerminal: true })[0]?.id as string;
    const checks = JSON.parse(rt.artifacts.text(rt.artifacts.listLatest(runId, "checks")[0] as never)) as {
      results: Array<{ check: string; command: string; ok: boolean; skipped?: string }>;
    };
    rt.close();
    // once per command; the docs build is not called for; the app is typechecked with no file of its own changed
    expect(checks.results.map((r) => [r.check, r.ok, r.skipped ?? ""])).toEqual([
      ["rebuild:build-lib", true, ""],
      ["typecheck-app", true, ""],
      ["test-app", true, "no changed code in its scope"],
    ]);
  });

  it("restores the worktree to the last checkpoint on resume", async () => {
    const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env: {} });
    const wt = await WorktreeWorkspace.create({
      repoRoot: sb.project,
      worktreesDir: loaded.home.worktreesDir,
      runId: "run_restoretest00000",
      task: "T",
      env: gitEnv,
    });
    writeFileSync(join(wt.ref.path, "a.txt"), "1");
    const c1 = await wt.checkpoint("step one", { "Jarvis-Run": "x" });
    writeFileSync(join(wt.ref.path, "a.txt"), "2");
    writeFileSync(join(wt.ref.path, "junk.txt"), "junk");
    await wt.restore(c1);
    expect(readFileSync(join(wt.ref.path, "a.txt"), "utf8")).toBe("1");
    expect(existsSync(join(wt.ref.path, "junk.txt"))).toBe(false);
    expect(await wt.checkpoint("nothing changed")).toBe(c1);
    const rt = createRuntime(loaded, { env: {} });
    rt.close();
  });

  it("keeps dependencies between worktrees with the same lockfile (workspace.cache)", async () => {
    writeFileSync(join(sb.project, "yarn.lock"), "lock v1\n");
    writeFileSync(join(sb.project, ".gitignore"), ".setup-ran\nnode_modules\n");
    sh(sb.project, ["add", "-A"]);
    sh(sb.project, ["commit", "-q", "-m", "lockfile"]);
    const cacheDir = join(sb.root, "cache", "deps");
    // the setup installs only when node_modules is missing, like a package manager with nothing to do
    const setup =
      "if [ -d node_modules ]; then echo kept >> .setup-ran; else mkdir -p node_modules/dep packages/a/node_modules && echo installed > node_modules/dep/index.js && echo installed >> .setup-ran; fi";
    const stages: string[] = [];
    const create = (runId: string) =>
      WorktreeWorkspace.create({
        repoRoot: sb.project,
        worktreesDir: join(sb.root, "wt"),
        runId,
        task: "T",
        setup,
        env: gitEnv,
        cache: { dir: cacheDir, key: ["yarn.lock"], paths: ["node_modules", "packages/*/node_modules"] },
        onStage: (stage, detail) => {
          if (stage === "cache") stages.push(detail);
        },
      });
    const first = await create("run_cachefirst000000");
    expect(readFileSync(join(first.ref.path, ".setup-ran"), "utf8")).toBe("installed\n");
    expect(stages).toEqual(["kept node_modules, packages/a/node_modules for the next run"]);

    const second = await create("run_cachesecond00000");
    expect(readFileSync(join(second.ref.path, "node_modules/dep/index.js"), "utf8")).toBe("installed\n");
    expect(readFileSync(join(second.ref.path, ".setup-ran"), "utf8")).toBe("kept\n");
    expect(stages[1]).toMatch(/^restored node_modules, packages\/a\/node_modules \(key [0-9a-f]{8}\)$/);

    // a changed lockfile is a miss
    writeFileSync(join(sb.project, "yarn.lock"), "lock v2\n");
    sh(sb.project, ["commit", "-q", "-am", "lockfile v2"]);
    const third = await create("run_cachethird000000");
    expect(readFileSync(join(third.ref.path, ".setup-ran"), "utf8")).toBe("installed\n");
  });
});

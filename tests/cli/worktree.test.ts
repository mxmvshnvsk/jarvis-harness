import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
      results: Array<{ check: string; ok: boolean; skipped?: string; tail?: string }>;
      reasons: Array<{ summary: string }>;
    };
    rt.close();
    expect(checks.changed).toEqual(["pkg/a.ts"]);
    expect(checks.results.map((r) => [r.check, r.ok, r.skipped ?? ""])).toEqual([
      ["test-pkg", false, ""],
      ["typecheck-other", true, "no changed code in its scope"],
    ]);
    expect(checks.reasons[0]?.summary).toContain(
      "test-pkg failed: $ cd pkg && echo tests ran in pkg && exit 3 | tests ran in pkg",
    );
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

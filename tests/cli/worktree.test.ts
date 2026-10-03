import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
});

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorktreeWorkspace, worktreePathFor } from "../../src/orchestration/worktree.ts";
import { isScratchFile } from "../../src/tools/local/scratch.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
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

describe("scratch files", () => {
  it("knows a file made to try something out from a real one", () => {
    for (const f of [
      "tmp-eol-test.txt",
      "tmp-nl-probe7.txt",
      "probe.txt",
      "src/x/eol-probe2.txt",
      "scratch_1.js",
      "temp.ts",
      "tmp",
    ])
      expect(isScratchFile(f), f).toBe(true);
    for (const f of [
      "template.ts",
      "src/temperature.ts",
      "probes/index.ts",
      "tmpl.html",
      "README.md",
      "prober.ts",
    ])
      expect(isScratchFile(f), f).toBe(false);
  });

  it("a worktree deletes the untracked ones and keeps tracked and ignored files", () => {
    const dir = sb.project;
    git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, ".gitignore"), "tmp-ignored.txt\n");
    writeFileSync(join(dir, "tmp-tracked.txt"), "kept\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "init"]);
    for (const f of ["tmp-eol-test.txt", "tmp-ignored.txt", "new.ts"]) writeFileSync(join(dir, f), "x\n");
    const ws = new WorktreeWorkspace({ mode: "worktree", repoRoot: dir, path: dir, baseRef: "HEAD" });
    return ws.sweepScratch().then((swept) => {
      expect(swept).toEqual(["tmp-eol-test.txt"]);
      expect(existsSync(join(dir, "tmp-eol-test.txt"))).toBe(false);
      for (const f of ["tmp-tracked.txt", "tmp-ignored.txt", "new.ts"])
        expect(existsSync(join(dir, f)), f).toBe(true);
    });
  });

  it("worktrees are named by repository, run and task", () => {
    expect(
      worktreePathFor("/h/.jarvis/worktrees", "/src/web-app", "Форма: компактный режим", "run_1a2b3c4d5e6f"),
    ).toBe("/h/.jarvis/worktrees/web-app/1a2b3c4d-forma-kompaktnyy-rezhim");
    expect(worktreePathFor("/w", "/src/web-app", "ABC-12 fix it", "run_1a2b3c4d5e6f")).toBe(
      "/w/web-app/1a2b3c4d-ABC-12",
    );
  });
});

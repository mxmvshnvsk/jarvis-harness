import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedFilesOf, commentFromTemplate, editorTemplate, reasonsOf } from "../../src/cli/gate.ts";
import type { Run } from "../../src/core/domain/run.ts";
import { sandbox } from "../helpers/tmp.ts";

describe("a comment written in $EDITOR", () => {
  const questions = ["Ever show them?", "Which forms?"];

  it("starts from a template with the open questions", () => {
    const t = editorTemplate("spec/spec.json@1", questions);
    expect(t).toContain("# Send spec/spec.json@1 back with changes.");
    expect(t).toContain("# 1) Ever show them?");
    expect(t).toContain("# 2) Which forms?");
    expect(t).toContain("# What else to change:");
    expect(commentFromTemplate(t, questions)).toBe("");
  });

  it("keys the answers to their questions and keeps the rest, dropping # lines", () => {
    const filled = editorTemplate("x", questions)
      .replace("# 2) Which forms?\n", "# 2) Which forms?\nonly compact\nand the checkout\n")
      .replace("# What else to change:\n", "# What else to change:\nkeep it small\n# a note to myself\n");
    expect(commentFromTemplate(filled, questions)).toBe(
      "Answers to the open questions:\n2) Which forms?\n   → only compact\n     and the checkout\n\nkeep it small",
    );
  });
});

describe("the card of an implementation", () => {
  it("lists the files the run changed against its base, most changed first", async () => {
    const sb = sandbox();
    try {
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      };
      const g = (...args: string[]) =>
        execFileSync("git", args, { cwd: sb.project, env, encoding: "utf8" }).trim();
      writeFileSync(join(sb.project, "a.ts"), "a\n");
      writeFileSync(join(sb.project, "b.ts"), "b\n");
      g("init", "-q");
      g("add", "-A");
      g("commit", "-q", "-m", "base");
      const base = g("rev-parse", "HEAD");
      writeFileSync(join(sb.project, "a.ts"), "a\nmore\nand more\n");
      writeFileSync(join(sb.project, "b.ts"), "");
      const run = {
        workspace: { mode: "cwd", repoRoot: sb.project, path: sb.project, baseRef: "HEAD", baseCommit: base },
      } as unknown as Run;
      expect(await changedFilesOf(run)).toEqual([
        { path: "a.ts", added: 2, removed: 0 },
        { path: "b.ts", added: 0, removed: 1 },
      ]);
    } finally {
      sb.cleanup();
    }
  });
});

describe("the reasons of a used-up loop", () => {
  it("one per kind; a '; ' inside a reason stays", () => {
    expect(reasonsOf("lint_error: exit 1; eol-last at x.ts:113; stray_files: tmp-a.txt\n tmp-b.txt")).toEqual(
      [
        { kind: "lint_error", text: "exit 1; eol-last at x.ts:113" },
        { kind: "stray_files", text: "tmp-a.txt tmp-b.txt" },
      ],
    );
    expect(reasonsOf("tests failed")).toEqual([{ text: "tests failed" }]);
    expect(reasonsOf("")).toEqual([]);
  });
});

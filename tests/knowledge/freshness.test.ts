import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { branchOf, changedSinceCode, codeAtOf, commitsSinceCode } from "../../src/knowledge/freshness.ts";
import { renderModuleDoc } from "../../src/onboarding/render.ts";

let dir: string;
const git = (...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd: dir })
    .toString()
    .trim();
const commit = (file: string, text: string) => {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
  git("add", "-A");
  git("commit", "-q", "-m", file);
  return git("rev-parse", "HEAD");
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fresh-"));
  git("init", "-q", "-b", "dev");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a map's freshness, by the code it was made from", () => {
  it("records the commit and branch, and counts the commits under its paths since", async () => {
    const at = commit("src/billing/form.ts", "export const a = 1;\n");
    const doc = renderModuleDoc(
      {
        module: "src/billing",
        purpose: "Billing.",
        publicApi: [],
        responsibilities: [],
        rules: [],
        terms: [],
        unknowns: [],
        dropped: [],
      },
      undefined,
      { commit: at, branch: await branchOf(dir) },
    );
    expect(codeAtOf(doc)).toEqual({ commit: at, branch: "dev" });
    expect(await commitsSinceCode(dir, at, ["src/billing/**"])).toBe(0);
    commit("src/billing/form.ts", "export const a = 2;\n");
    commit("src/other/x.ts", "export const b = 1;\n");
    expect(await commitsSinceCode(dir, at, ["src/billing/**"])).toBe(1);
    expect(await changedSinceCode(dir, at, ["src/billing/**"])).toEqual(["src/billing/form.ts"]);
    // a commit this repository does not have says nothing
    expect(
      await commitsSinceCode(dir, "0123456789abcdef0123456789abcdef01234567", ["src/billing/**"]),
    ).toBeUndefined();
    expect(codeAtOf("---\ncommit: not-a-sha\n---\n")).toBeUndefined();
  });
});

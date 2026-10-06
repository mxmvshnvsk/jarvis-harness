import { execSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSuite } from "../../src/evals/runner.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

const SUITE = fileURLToPath(new URL("../../evals/regressions", import.meta.url));
let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => sb.cleanup());

const passes = (command: string, cwd: string) => {
  try {
    execSync(command, { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
};

describe("the regressions suite", () => {
  it("loads, and its gold catches the bug and accepts the fix", () => {
    const [c] = loadSuite(SUITE);
    expect(c).toMatchObject({ id: "compact-form-fields", workflow: "fix" });
    const gold = c?.gold.tests as string;
    const repo = join(sb.root, "repo");
    cpSync(join(c?.dir as string, "fixture"), repo, { recursive: true });
    expect(passes("node --test", repo)).toBe(true); // the fixture's own tests pass with the bug
    expect(passes(gold, repo)).toBe(false); // the gold sees the bug
    const file = join(repo, "src/shared/delivery-fields.ts");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "return props.hasAddress;",
        'return props.mode === "full" && props.hasAddress;',
      ),
    );
    expect(passes(gold, repo)).toBe(true);
  });
});

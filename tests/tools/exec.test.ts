import { describe, expect, it } from "vitest";
import { runShell } from "../../src/tools/local/exec.ts";

describe("runShell output lines", () => {
  it("hands over each non-empty line, without colours, as it comes", async () => {
    const seen: string[] = [];
    const r = await runShell("printf 'one\\n\\033[32mtwo\\033[0m\\n\\n' ; printf 'three\\n' >&2", {
      cwd: process.cwd(),
      onLine: (l) => seen.push(l),
    });
    expect(r.code).toBe(0);
    expect(seen.sort()).toEqual(["one", "three", "two"]);
  });
});

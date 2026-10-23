import { describe, expect, it } from "vitest";
import { failureDigest } from "../../src/tools/local/failure.ts";

const P = "@acme/common-lib:lint: ";
/** A lint of many warnings and two errors, as turbo prints it (pilot: 517 problems, 2 errors). */
function lint(): string {
  const lines: string[] = [];
  for (let f = 0; f < 40; f++) {
    lines.push(`${P}/w/packages/common-lib/src/pages/p${f}.tsx`);
    for (let i = 1; i <= 5; i++)
      lines.push(`${P}  ${i}:16  warning  Unexpected any  @typescript-eslint/no-explicit-any`);
    lines.push(P.trimEnd());
  }
  lines.splice(
    100,
    0,
    `${P}/w/packages/common-lib/src/pages/form/__tests__/form.test.tsx`,
    `${P}  7:8    error  Expected a line break after this opening brace   object-curly-newline`,
    `${P}  7:119  error  Expected a line break before this closing brace  object-curly-newline`,
  );
  lines.push(`${P}✖ 202 problems (2 errors, 200 warnings)`, `${P}ERROR: command finished with error`);
  for (let i = 0; i < 10; i++) lines.push(` ERROR  run failed: command  exited (1) ${i}`);
  return lines.join("\n");
}

describe("a failed command's digest", () => {
  it("puts the error lines, under their file, and the end first", () => {
    const d = failureDigest(lint()) as string;
    const lines = d.split("\n");
    expect(lines[0]).toMatch(/^\[failed — the lines that say error \(2 of \d+ lines\):\]$/);
    expect(lines[1]).toBe(`${P}/w/packages/common-lib/src/pages/form/__tests__/form.test.tsx`);
    expect(lines[2]).toContain("7:8    error  Expected a line break");
    expect(lines[3]).toContain("7:119  error");
    expect(lines[4]).toBe("[…its end:]");
    expect(d).toContain("✖ 202 problems (2 errors, 200 warnings)");
    expect(d.slice(0, d.indexOf("[…its end:]"))).not.toContain("no-explicit-any");
    expect(lines.at(-1)).toBe("[the whole output:]");
  });

  it("a short output needs none; one with no error line shows its end", () => {
    expect(failureDigest("$ yarn lint\nboom\n[exit 1 in 3 ms]")).toBeUndefined();
    const quiet = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const d = failureDigest(quiet) as string;
    expect(d.split("\n")[0]).toBe("[failed — no line says error; the end of the 100 lines below]");
    expect(d).toContain("line 99");
    expect(d).not.toContain("line 10\n");
  });

  it("«0 errors» is not an error line", () => {
    const out = [
      ...Array.from({ length: 70 }, (_, i) => `ok ${i}`),
      "✔ 0 errors, 3 warnings",
      "Tests: 1 failed",
    ].join("\n");
    expect(failureDigest(out)?.split("\n")[0]).toContain("no line says error");
  });
});

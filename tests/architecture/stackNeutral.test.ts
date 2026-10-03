import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ADR-0021 §1 fitness rule: the core knows no stack. Stack-specific words and imports from
 * `src/adapters` may live only in adapters, capability packs, profiles and templates.
 */
const ROOT = join(import.meta.dirname, "..", "..", "src");
const CORE = [
  "core",
  "orchestration",
  "agents",
  "artifacts",
  "budget",
  "models",
  "knowledge",
  "storage",
  "security",
  "tools",
];
const FORBIDDEN = /\b(react|csharp|dotnet|roslyn|ts-morph|vitest|eslint|tsc)\b/i;
const ALLOWED_LINES = [/ADR-0021/, /^\s*\/\//, /^\s*\*/];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("stack-neutral core", () => {
  it("mentions no stack by name and never imports adapters", () => {
    const offenders: string[] = [];
    for (const area of CORE) {
      for (const file of walk(join(ROOT, area))) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (ALLOWED_LINES.some((re) => re.test(line))) return;
          if (FORBIDDEN.test(line) || /from "[^"]*\/adapters\//.test(line)) {
            offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});

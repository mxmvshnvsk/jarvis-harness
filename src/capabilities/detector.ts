import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Stack detection (ADR-0021 §3): bootstrap and verification for `stack` in project config. Explicit
 * configuration wins; detection fills the gap and lets `doctor` flag disagreements.
 */
export function detectStacks(root: string): string[] {
  const stacks = new Set<string>();
  const has = (f: string) => existsSync(join(root, f));
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  if (has("package.json")) {
    stacks.add("node");
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.typescript || has("tsconfig.json")) stacks.add("typescript");
      if (deps.react) stacks.add("react");
      if (deps.next) stacks.add("nextjs");
      if (deps.vue) stacks.add("vue");
    } catch {
      // unreadable package.json — node only
    }
  } else if (has("tsconfig.json")) stacks.add("typescript");
  if (
    entries.some((e) => /\.(sln|csproj|fsproj)$/.test(e)) ||
    entries.some((e) => /^Directory\.Build\./.test(e))
  ) {
    stacks.add("dotnet");
    stacks.add("csharp");
  }
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) stacks.add("python");
  if (has("go.mod")) stacks.add("go");
  if (has("Cargo.toml")) stacks.add("rust");
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) stacks.add("java");
  return [...stacks].sort();
}

/** Explicit `stack` from config when set, otherwise detection. */
export function effectiveStacks(configured: readonly string[], root: string | undefined): string[] {
  if (configured.length > 0) return [...configured];
  return root ? detectStacks(root) : [];
}

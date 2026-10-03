import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globMatches } from "../knowledge/frontmatter.ts";

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

/**
 * ADR-0021 §9: a repository may hold several stacks. Explicit `stackScopes` win; otherwise every
 * top-level directory with its own markers becomes a scope. Returns `glob → stacks`.
 */
export function detectStackScopes(
  root: string,
  configured: Readonly<Record<string, readonly string[]>> = {},
): Record<string, string[]> {
  if (Object.keys(configured).length > 0)
    return Object.fromEntries(Object.entries(configured).map(([k, v]) => [k, [...v]]));
  const scopes: Record<string, string[]> = {};
  let entries: string[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith(".") &&
          !["node_modules", "dist", "coverage"].includes(e.name),
      )
      .map((e) => e.name);
  } catch {
    return scopes;
  }
  for (const dir of entries) {
    const stacks = detectStacks(join(root, dir));
    if (stacks.length > 0) scopes[`${dir}/**`] = stacks;
  }
  return scopes;
}

/** Stacks of the affected paths: union over matching scopes, else the project-wide stacks. */
export function stacksForPaths(
  affectedPaths: readonly string[],
  scopes: Readonly<Record<string, readonly string[]>>,
  fallback: readonly string[],
): string[] {
  if (affectedPaths.length === 0 || Object.keys(scopes).length === 0) return [...fallback];
  const out = new Set<string>();
  let matched = false;
  for (const path of affectedPaths) {
    for (const [glob, stacks] of Object.entries(scopes)) {
      if (globMatches(path, [glob])) {
        matched = true;
        for (const s of stacks) out.add(s);
      }
    }
  }
  return matched ? [...out].sort() : [...fallback];
}

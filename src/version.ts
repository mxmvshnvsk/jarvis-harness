import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageJson {
  readonly name: string;
  readonly version: string;
}

let cached: PackageJson | undefined;

/** Reads name and version from the package's own package.json (works from src/ and dist/). */
export function packageInfo(): PackageJson {
  if (!cached) {
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PackageJson;
    cached = { name: parsed.name, version: parsed.version };
  }
  return cached;
}

/** What `pnpm build` wrote next to the compiled code (scripts/build-info.ts). */
export interface BuildInfo {
  readonly commit: string;
  readonly builtAt: string;
}

/** The build this code was compiled from; undefined when running from source. */
export function buildInfoIn(dir: string): BuildInfo | undefined {
  const file = join(dir, "build-info.json");
  if (!existsSync(file)) return undefined;
  try {
    const info = JSON.parse(readFileSync(file, "utf8")) as Partial<BuildInfo>;
    return typeof info.commit === "string" && typeof info.builtAt === "string"
      ? { commit: info.commit, builtAt: info.builtAt }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The commit checked out in `root`, read from .git without running git. */
export function checkoutHead(root: string): string | undefined {
  const gitDir = join(root, ".git");
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
    const ref = head.slice(5);
    const loose = join(gitDir, ref);
    if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
    const packed = readFileSync(join(gitDir, "packed-refs"), "utf8");
    return packed
      .split("\n")
      .find((l) => l.endsWith(` ${ref}`))
      ?.split(" ")[0];
  } catch {
    return undefined;
  }
}

/**
 * The compiled code is older than the checkout it lives in: `bin/jarvis` runs `dist`, and after a
 * pull or an applied bundle it kept running the previous build until someone remembered
 * `pnpm build` (pilot). Undefined when up to date, running from source, or not a git checkout.
 */
export function staleBuildIn(
  distDir: string,
  root: string,
): { readonly built: string; readonly head: string } | undefined {
  const build = buildInfoIn(distDir);
  if (!build) return undefined;
  const head = checkoutHead(root);
  if (!head || head === build.commit) return undefined;
  return { built: build.commit, head };
}

const here = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/[/]+$/, "");

/** `0.0.1 (3f8baa6, built 2026-10-06 15:40)`, or `0.0.1 (source)`. */
export function versionText(): string {
  const build = buildInfoIn(here);
  if (!build) return `${packageInfo().version} (source)`;
  const at = new Date(build.builtAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const when = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return `${packageInfo().version} (${build.commit.slice(0, 7)}, built ${when})`;
}

export function staleBuild():
  | { readonly built: string; readonly head: string; readonly root: string }
  | undefined {
  const stale = staleBuildIn(here, packageRoot);
  return stale ? { ...stale, root: packageRoot } : undefined;
}

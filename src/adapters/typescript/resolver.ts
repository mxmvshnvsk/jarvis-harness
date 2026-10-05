import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { ts } from "ts-morph";
import type { SpecifierResolver } from "../../core/capabilities/contracts.ts";
import { globMatches } from "../../knowledge/frontmatter.ts";

/**
 * Tree-level resolution of TypeScript import specifiers the core cannot know (ADR-0008 §1,
 * ADR-0021 §6): `paths`/`baseUrl` of the tsconfig nearest to the importing file, and the packages
 * of a workspace monorepo mapped back to their sources. Pilot (a yarn monorepo): `#/src/billing`
 * inside the shared library became the external package `#`, and the imports of
 * `@acme/shared-lib/billing` from the apps pointed nowhere, so impact analysis
 * never saw an app affected by a library change.
 */
export const TS_RESOLVER_VERSION = 1;

const SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".d.ts",
  ".js",
  ".jsx",
  ".mjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];
/** Directories build output usually lands in; an export into one is mapped back to `src`. */
const BUILD_DIRS = new Set([".publish", "dist", "build", "lib", "out", "esm", "cjs"]);

interface PathsConfig {
  /** Repository-relative directory the patterns resolve against. */
  readonly base: string;
  readonly paths: ReadonlyArray<readonly [pattern: string, targets: readonly string[]]>;
  readonly hasBaseUrl: boolean;
}

interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  readonly exports?: unknown;
  readonly main?: string;
  readonly types?: string;
}

const posixify = (p: string) => p.split("\\").join("/");

export class TypeScriptResolver implements SpecifierResolver {
  private readonly root: string;
  private readonly files: ReadonlySet<string>;
  private readonly tsconfigOfDir = new Map<string, PathsConfig | undefined>();
  private packages: WorkspacePackage[] | undefined;

  constructor(root: string, files: ReadonlySet<string>) {
    this.root = root;
    this.files = files;
  }

  resolve(from: string, spec: string): string | undefined {
    if (spec.startsWith(".") || spec.startsWith("/")) return undefined;
    return this.viaPaths(from, spec) ?? this.viaWorkspace(spec);
  }

  /** `path` with the usual suffixes, as a file of the tree. */
  private file(path: string): string | undefined {
    const base = posix.normalize(path);
    if (base.startsWith("..")) return undefined;
    const stripped = base.replace(/\.[cm]?[jt]sx?$/, "");
    for (const candidate of [base, ...SUFFIXES.map((s) => `${stripped}${s}`)]) {
      if (this.files.has(candidate)) return candidate;
    }
    return undefined;
  }

  private viaPaths(from: string, spec: string): string | undefined {
    const config = this.configFor(posix.dirname(posixify(from)));
    if (!config) return undefined;
    for (const [pattern, targets] of config.paths) {
      const star = pattern.indexOf("*");
      let captured: string | undefined;
      if (star < 0) captured = pattern === spec ? "" : undefined;
      else {
        const head = pattern.slice(0, star);
        const tail = pattern.slice(star + 1);
        if (spec.startsWith(head) && spec.endsWith(tail) && spec.length >= head.length + tail.length)
          captured = spec.slice(head.length, spec.length - tail.length);
      }
      if (captured === undefined) continue;
      for (const target of targets) {
        const hit = this.file(posix.join(config.base, target.replace("*", captured)));
        if (hit) return hit;
      }
    }
    // a bare baseUrl also resolves non-relative names against itself
    return config.hasBaseUrl ? this.file(posix.join(config.base, spec)) : undefined;
  }

  /** The tsconfig.json nearest to `dir` (inside the repository), parsed once with its `extends`. */
  private configFor(dir: string): PathsConfig | undefined {
    if (this.tsconfigOfDir.has(dir)) return this.tsconfigOfDir.get(dir);
    let found: PathsConfig | undefined;
    const file = join(this.root, dir, "tsconfig.json");
    if (existsSync(file)) found = this.parse(file);
    else if (dir !== "." && dir !== "")
      found = this.configFor(posix.dirname(dir) === dir ? "." : posix.dirname(dir));
    this.tsconfigOfDir.set(dir, found);
    return found;
  }

  private parse(file: string): PathsConfig | undefined {
    try {
      const read = ts.readConfigFile(file, ts.sys.readFile);
      if (read.error || !read.config) return undefined;
      // `extends` may point into node_modules that a fresh worktree lacks: errors are ignored,
      // whatever was resolved is used
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(file), undefined, file);
      const options = parsed.options;
      if (!options.paths && !options.baseUrl) return undefined;
      const baseAbs =
        options.baseUrl ?? (options as { pathsBasePath?: string }).pathsBasePath ?? dirname(file);
      const base = posixify(relative(this.root, baseAbs)) || ".";
      return {
        base,
        paths: Object.entries(options.paths ?? {}).map(([p, t]) => [p, t] as const),
        hasBaseUrl: options.baseUrl !== undefined,
      };
    } catch {
      return undefined;
    }
  }

  private viaWorkspace(spec: string): string | undefined {
    const pkg = this.workspace().find((p) => spec === p.name || spec.startsWith(`${p.name}/`));
    if (!pkg) return undefined;
    const sub = spec === pkg.name ? "" : spec.slice(pkg.name.length + 1);
    for (const target of exportTargets(pkg, sub)) {
      const hit = this.file(posix.join(pkg.dir, target)) ?? this.file(posix.join(pkg.dir, toSource(target)));
      if (hit) return hit;
    }
    // no usable exports: the sources by the usual layout
    const guesses = sub ? [`src/${sub}`, sub] : [pkg.types, pkg.main, "src/index", "index"];
    for (const g of guesses) {
      if (!g) continue;
      const hit = this.file(posix.join(pkg.dir, g)) ?? this.file(posix.join(pkg.dir, toSource(g)));
      if (hit) return hit;
    }
    return undefined;
  }

  /** Packages of the workspace (`workspaces` in the root package.json), longest name first. */
  private workspace(): WorkspacePackage[] {
    if (this.packages) return this.packages;
    const out: WorkspacePackage[] = [];
    try {
      const root = JSON.parse(readFileSync(join(this.root, "package.json"), "utf8")) as {
        workspaces?: string[] | { packages?: string[] };
      };
      const globs = Array.isArray(root.workspaces) ? root.workspaces : (root.workspaces?.packages ?? []);
      const manifests = [...this.files].filter(
        (f) =>
          f.endsWith("/package.json") && !f.includes("node_modules/") && globMatches(posix.dirname(f), globs),
      );
      for (const m of manifests.sort()) {
        try {
          const pkg = JSON.parse(readFileSync(join(this.root, m), "utf8")) as Record<string, unknown>;
          if (typeof pkg.name !== "string") continue;
          out.push({
            name: pkg.name,
            dir: posix.dirname(m),
            exports: pkg.exports,
            ...(typeof pkg.main === "string" ? { main: pkg.main } : {}),
            ...(typeof pkg.types === "string" ? { types: pkg.types } : {}),
          });
        } catch {
          // an unreadable manifest is not a package
        }
      }
    } catch {
      // no root package.json: not a workspace
    }
    this.packages = out.sort((a, b) => b.name.length - a.name.length);
    return this.packages;
  }
}

/** Targets of `exports` for a subpath (`""` = the package itself), including `./*` patterns. */
function exportTargets(pkg: WorkspacePackage, sub: string): string[] {
  const exp = pkg.exports;
  if (exp === undefined || exp === null) return [];
  const key = sub ? `./${sub}` : ".";
  const pick = (v: unknown): string[] => {
    if (typeof v === "string") return [v];
    if (Array.isArray(v)) return v.flatMap(pick);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return ["types", "import", "require", "default"].flatMap((k) => (k in o ? pick(o[k]) : []));
    }
    return [];
  };
  if (typeof exp === "string" || Array.isArray(exp)) return key === "." ? pick(exp) : [];
  const map = exp as Record<string, unknown>;
  if (key in map) return pick(map[key]);
  for (const [pattern, value] of Object.entries(map)) {
    const star = pattern.indexOf("*");
    if (star < 0) continue;
    const head = pattern.slice(0, star);
    const tail = pattern.slice(star + 1);
    if (key.startsWith(head) && key.endsWith(tail)) {
      const captured = key.slice(head.length, key.length - tail.length);
      return pick(value).map((t) => t.replace("*", captured));
    }
  }
  return [];
}

/** `./.publish/billing/index.js` → `src/billing/index`: build output back to its sources. */
function toSource(target: string): string {
  const parts = posix.normalize(target).split("/");
  if (parts[0] && BUILD_DIRS.has(parts[0])) parts[0] = "src";
  return parts
    .join("/")
    .replace(/\.d\.ts$/, "")
    .replace(/\.[cm]?[jt]sx?$/, "");
}

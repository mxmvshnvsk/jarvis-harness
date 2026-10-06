import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/**
 * Dependencies of a worktree, kept between runs (`workspace.cache`): every run's checkout used to
 * install from scratch — minutes before the first step (pilot: `yarn install` in a monorepo). After a
 * setup the configured paths (`node_modules`, …) are copied into `~/.jarvis/cache/deps/<project>/<key>`,
 * the key being the hash of the lockfiles; the next worktree with the same lockfiles gets them back
 * before its setup, which then has little to do. Copies are copy-on-write clones where the file
 * system can (APFS: `cp -c`, btrfs/xfs: `--reflink`), so they cost neither time nor disk there.
 */
export interface DepsCacheConfig {
  /** Files whose content decides whether cached dependencies fit: lockfiles. */
  readonly key: readonly string[];
  /** Paths to keep, relative to the checkout; a `*` segment matches one directory level. */
  readonly paths: readonly string[];
}

const run = promisify(execFile);
/** Keys kept per project: a lockfile change makes a new one, the oldest go. */
export const KEEP_KEYS = 3;

/** The hash of the key files' content; a missing file counts as its own value. */
export function cacheKey(root: string, files: readonly string[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort()) {
    const p = join(root, f);
    h.update(`${f}\0`);
    h.update(existsSync(p) ? readFileSync(p) : "\0missing\0");
  }
  return h.digest("hex").slice(0, 16);
}

/** Existing paths matching the patterns (`node_modules`, `packages/*\/node_modules`). */
export function expandPaths(root: string, patterns: readonly string[]): string[] {
  const out = new Set<string>();
  const walk = (base: string, segments: readonly string[]) => {
    const [head, ...rest] = segments;
    if (head === undefined) {
      if (base && existsSync(join(root, base))) out.add(base);
      return;
    }
    if (head === "*") {
      const dir = join(root, base);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
          walk(base ? `${base}/${entry.name}` : entry.name, rest);
      }
      return;
    }
    walk(base ? `${base}/${head}` : head, rest);
  };
  for (const pattern of patterns) walk("", pattern.split("/").filter(Boolean));
  return [...out].sort();
}

/** `cp` that clones where it can and copies where it cannot. */
async function copy(from: string, to: string): Promise<void> {
  mkdirSync(dirname(to), { recursive: true });
  const attempts: string[][] =
    process.platform === "darwin"
      ? [["-c", "-R"], ["-R"]]
      : process.platform === "linux"
        ? [["-R", "--reflink=auto"], ["-R"]]
        : [["-R"]];
  let last: unknown;
  for (const flags of attempts) {
    try {
      rmSync(to, { recursive: true, force: true });
      await run("cp", [...flags, from, to], { maxBuffer: 1 << 20 });
      return;
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

/** Brings cached paths into the checkout; undefined when nothing is cached for this key. */
export async function restoreDeps(
  cacheDir: string,
  key: string,
  checkout: string,
): Promise<string[] | undefined> {
  const entry = join(cacheDir, key);
  const manifest = join(entry, "manifest.json");
  if (!existsSync(manifest)) return undefined;
  const paths = JSON.parse(readFileSync(manifest, "utf8")) as string[];
  for (const p of paths) await copy(join(entry, "files", p), join(checkout, p));
  writeFileSync(manifest, JSON.stringify(paths)); // touch: recently used keys stay
  return paths;
}

/** Keeps the checkout's paths under the key; the oldest keys beyond KEEP_KEYS go. */
export async function saveDeps(
  cacheDir: string,
  key: string,
  checkout: string,
  patterns: readonly string[],
): Promise<string[]> {
  const paths = expandPaths(checkout, patterns);
  if (paths.length === 0) return [];
  const entry = join(cacheDir, key);
  const staging = `${entry}.tmp-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  try {
    for (const p of paths) await copy(join(checkout, p), join(staging, "files", p));
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(paths));
    rmSync(entry, { recursive: true, force: true });
    renameSync(staging, entry);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  pruneDeps(cacheDir, KEEP_KEYS);
  return paths;
}

export function pruneDeps(cacheDir: string, keep: number): void {
  if (!existsSync(cacheDir)) return;
  const keys = readdirSync(cacheDir)
    .filter((k) => existsSync(join(cacheDir, k, "manifest.json")))
    .map((k) => ({ k, at: statSync(join(cacheDir, k, "manifest.json")).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { k } of keys.slice(keep)) rmSync(join(cacheDir, k), { recursive: true, force: true });
}

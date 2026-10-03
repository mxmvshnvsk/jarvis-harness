import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { git } from "../tools/local/exec.ts";

/**
 * Installing the pre-push hook (ADR-0001 §16). The script is a thin shim: it hands the refs git
 * writes to stdin to `jarvis prepush`, so all logic lives in the CLI and updates with it. A hook
 * we did not write is never overwritten without `--force`, and is restored on uninstall.
 */
export const HOOK_MARKER = "# jarvis-managed: pre-push";
export const BACKUP_SUFFIX = ".pre-jarvis";

export class HookError extends Error {}

export type HookState = "missing" | "managed" | "foreign";

export interface HookLocation {
  readonly repoRoot: string;
  /** Directory git reads hooks from (honours `core.hooksPath` and linked worktrees). */
  readonly hooksDir: string;
  readonly hookPath: string;
  readonly customHooksPath: boolean;
}

export async function locateHook(cwd: string, env?: NodeJS.ProcessEnv): Promise<HookLocation> {
  const options = env ? { env } : {};
  const top = await git(["rev-parse", "--show-toplevel"], cwd, options);
  if (top.code !== 0) throw new HookError("not a git repository");
  const repoRoot = top.stdout.trim();
  const dir = await git(["rev-parse", "--git-path", "hooks"], repoRoot, options);
  if (dir.code !== 0) throw new HookError(`git could not locate the hooks directory: ${dir.stderr.trim()}`);
  const raw = dir.stdout.trim();
  const hooksDir = isAbsolute(raw) ? raw : resolve(repoRoot, raw);
  const configured = await git(["config", "--get", "core.hooksPath"], repoRoot, options);
  return {
    repoRoot,
    hooksDir,
    hookPath: join(hooksDir, "pre-push"),
    customHooksPath: configured.code === 0 && configured.stdout.trim().length > 0,
  };
}

export function hookState(path: string): HookState {
  if (!existsSync(path)) return "missing";
  return readFileSync(path, "utf8").includes(HOOK_MARKER) ? "managed" : "foreign";
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * `entry` is the absolute path of this installation's CLI, used when `jarvis` is not on PATH at
 * push time (an IDE's git, a GUI client). A missing CLI never blocks a push: the hook says so and passes.
 */
export function hookScript(entry?: { node: string; script: string }): string {
  const fallback = entry
    ? [
        `if [ -f ${quote(entry.script)} ]; then`,
        `  exec ${quote(entry.node)} ${quote(entry.script)} prepush --hook "$@"`,
        "fi",
      ]
    : [];
  return [
    "#!/bin/sh",
    HOOK_MARKER,
    "# Installed by `jarvis hooks install`; remove with `jarvis hooks uninstall`.",
    "# Skip once: JARVIS_SKIP_HOOKS=1 git push   (or git push --no-verify)",
    'if [ -n "$JARVIS_SKIP_HOOKS" ]; then exit 0; fi',
    "if command -v jarvis >/dev/null 2>&1; then",
    '  exec jarvis prepush --hook "$@"',
    "fi",
    ...fallback,
    'echo "jarvis: pre-push hook skipped — the jarvis command was not found (jarvis hooks uninstall removes this hook)" >&2',
    "exit 0",
    "",
  ].join("\n");
}

export interface InstallResult {
  readonly path: string;
  readonly action: "installed" | "updated" | "replaced";
  readonly backup?: string;
}

export function installHook(
  location: HookLocation,
  options: { force?: boolean; entry?: { node: string; script: string } },
): InstallResult {
  const state = hookState(location.hookPath);
  let backup: string | undefined;
  if (state === "foreign") {
    if (!options.force)
      throw new HookError(
        `${location.hookPath} exists and was not written by jarvis; rerun with --force to back it up and replace it`,
      );
    backup = `${location.hookPath}${BACKUP_SUFFIX}`;
    if (existsSync(backup)) backup = `${backup}.${Date.now()}`;
    renameSync(location.hookPath, backup);
  }
  mkdirSync(location.hooksDir, { recursive: true });
  writeFileSync(location.hookPath, hookScript(options.entry));
  chmodSync(location.hookPath, 0o755);
  return {
    path: location.hookPath,
    action: state === "managed" ? "updated" : state === "foreign" ? "replaced" : "installed",
    ...(backup ? { backup } : {}),
  };
}

export interface UninstallResult {
  readonly path: string;
  readonly removed: boolean;
  readonly restored?: string;
}

export function uninstallHook(location: HookLocation): UninstallResult {
  const state = hookState(location.hookPath);
  if (state === "missing") return { path: location.hookPath, removed: false };
  if (state === "foreign")
    throw new HookError(`${location.hookPath} was not written by jarvis; leaving it alone`);
  rmSync(location.hookPath);
  const backup = `${location.hookPath}${BACKUP_SUFFIX}`;
  if (existsSync(backup)) {
    renameSync(backup, location.hookPath);
    return { path: location.hookPath, removed: true, restored: location.hookPath };
  }
  return { path: location.hookPath, removed: true };
}

/** Is an executable called `jarvis` reachable through the given PATH? */
export function jarvisOnPath(env: NodeJS.ProcessEnv): boolean {
  const names = process.platform === "win32" ? ["jarvis.cmd", "jarvis.exe", "jarvis"] : ["jarvis"];
  return (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => names.some((n) => existsSync(join(dir, n))));
}

/** This installation's CLI entry, when the process was started from one. */
export function currentEntry(): { node: string; script: string } | undefined {
  const script = process.argv[1];
  if (!script || !/[\\/](jarvis\.js|main\.(ts|js))$/.test(script)) return undefined;
  return { node: process.execPath, script: resolve(script) };
}

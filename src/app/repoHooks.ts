import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { HOOK_MARKER } from "../hooks/gitHooks.ts";
import { git, runCommand } from "../tools/local/exec.ts";

/**
 * The repository's own git hooks (husky, lint-staged, commitlint): what a person's commit and push go
 * through, Jarvis's go through too. `pre-commit` and `pre-push` run with the project's checks, before
 * the person's review — what they find goes back to the implementation like a failed check; `commit-msg`
 * there only warns (the message is the team's format, not the code). The PR's commit and Apply are
 * real commits: the hooks run again, a failure is said with its output.
 */

export type HookName = "pre-commit" | "commit-msg" | "pre-push";

export interface HookRun {
  readonly hook: HookName;
  readonly ok: boolean;
  readonly output: string;
}

/** Where git takes the hooks from, for a checkout: `core.hooksPath` (relative — from the checkout), else .git/hooks. */
async function hooksDirOf(checkout: string): Promise<string | undefined> {
  const configured = await git(["config", "--get", "core.hooksPath"], checkout);
  const raw = configured.code === 0 ? configured.stdout.trim() : "";
  if (raw) return isAbsolute(raw) ? raw : resolve(checkout, raw);
  const dir = await git(["rev-parse", "--git-path", "hooks"], checkout);
  if (dir.code !== 0) return undefined;
  const path = dir.stdout.trim();
  return isAbsolute(path) ? path : resolve(checkout, path);
}

/** The repository's hooks that would run: present, executable, not Jarvis's own pre-push shim. */
export async function repoHooksOf(checkout: string): Promise<Partial<Record<HookName, string>>> {
  const dir = await hooksDirOf(checkout);
  if (!dir) return {};
  const out: Partial<Record<HookName, string>> = {};
  for (const name of ["pre-commit", "commit-msg", "pre-push"] as const) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      accessSync(path, constants.X_OK);
    } catch {
      continue; // git skips a hook that is not executable
    }
    if (name === "pre-push" && readFileSync(path, "utf8").includes(HOOK_MARKER)) continue;
    out[name] = path;
  }
  return out;
}

const tail = (r: { stdout: string; stderr: string }) =>
  `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-40).join("\n");

/** One hook run as git would run it: in the checkout, with its arguments and input. */
export async function runHook(
  checkout: string,
  hook: HookName,
  path: string,
  options: {
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    message?: string;
    push?: { branch: string; remote: string };
  },
): Promise<HookRun> {
  let args: string[] = [];
  let input: string | undefined;
  let dir: string | undefined;
  try {
    if (hook === "commit-msg") {
      dir = mkdtempSync(join(tmpdir(), "jarvis-msg-"));
      const file = join(dir, "COMMIT_EDITMSG");
      writeFileSync(file, `${options.message ?? ""}\n`);
      args = [file];
    }
    if (hook === "pre-push") {
      const head = (await git(["rev-parse", "HEAD"], checkout)).stdout.trim();
      const remote = options.push?.remote ?? "origin";
      const url = (await git(["remote", "get-url", remote], checkout)).stdout.trim();
      args = [remote, url];
      input = `HEAD ${head} refs/heads/${options.push?.branch ?? "jarvis"} ${"0".repeat(40)}\n`;
    }
    const r = await runCommand(path, args, {
      cwd: checkout,
      // the checkout's own git, not a caller's GIT_DIR or index
      env: Object.fromEntries(
        Object.entries(options.env ?? process.env).filter(([k]) => k !== "GIT_DIR" && k !== "GIT_INDEX_FILE"),
      ),
      timeoutMs: options.timeoutMs ?? 600_000,
      ...(input ? { input } : {}),
    });
    return {
      hook,
      ok: r.code === 0 && !r.timedOut,
      output: r.timedOut ? `${tail(r)}\n(timed out)` : tail(r),
    };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A real commit of the checkout's whole state onto `base`, its hooks run: the run's branch becomes
 * `base` + this one commit (its history before is kept under `refs/jarvis/history/<branch>`). The
 * same tree, message and date give the same commit. On a hook's refusal the branch is as it was.
 */
export async function commitWithHooks(
  checkout: string,
  branch: string,
  base: string,
  message: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true; commit: string } | { ok: false; output: string }> {
  const head = (await git(["rev-parse", "HEAD"], checkout)).stdout.trim();
  const parent = (await git(["rev-parse", "HEAD^"], checkout)).stdout.trim();
  const subject = (await git(["log", "-1", "--format=%B", "HEAD"], checkout)).stdout.trim();
  // made already (the card, then the PR): the same commit, nothing runs again
  if (
    parent === base &&
    subject === message.trim() &&
    (await git(["status", "--porcelain"], checkout)).stdout.trim() === ""
  )
    return { ok: true, commit: head };
  await git(["update-ref", `refs/jarvis/history/${branch}`, head], checkout);
  await git(["add", "-A"], checkout);
  await git(["reset", "-q", "--soft", base], checkout);
  const dir = mkdtempSync(join(tmpdir(), "jarvis-msg-"));
  try {
    const file = join(dir, "MSG");
    writeFileSync(file, `${message}\n`);
    const r = await git(["commit", "-q", "--allow-empty", "-F", file], checkout, { env, timeoutMs: 600_000 });
    if (r.code !== 0) {
      await git(["reset", "-q", "--soft", head], checkout);
      return { ok: false, output: tail(r) };
    }
    return { ok: true, commit: (await git(["rev-parse", "HEAD"], checkout)).stdout.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

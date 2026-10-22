import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { WorkspaceRef } from "../core/domain/run.ts";
import { git, runShell } from "../tools/local/exec.ts";
import { isScratchFile } from "../tools/local/scratch.ts";
import { cacheKey, type DepsCacheConfig, restoreDeps, saveDeps } from "./depsCache.ts";
import { CwdWorkspace, type Workspace, type WorkspaceFactory } from "./workspace.ts";

/**
 * Git worktree per run (ADR-0003): `jarvis/<task>/<runShort>` from `baseCommit`, checkpoint = commit
 * with `Jarvis-*` trailers, restore = reset + clean, delivery via `jarvis apply`.
 */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

export interface CreateWorktreeOptions {
  readonly repoRoot: string;
  readonly worktreesDir: string;
  readonly runId: string;
  readonly task: string;
  readonly baseRef?: string;
  readonly setup?: string;
  readonly setupTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  /** `clone`: a `git clone --shared` instead of a git worktree (`workspace.checkout`). */
  readonly checkout?: "worktree" | "clone";
  /** Dependencies kept between worktrees: where, and what (`workspace.cache`). */
  readonly cache?: { readonly dir: string } & DepsCacheConfig;
  /** Told when the worktree exists and before `setup` runs (it can take minutes: say so). */
  readonly onStage?: (stage: "worktree" | "setup" | "cache", detail: string) => void;
  /** Output of `setup`, line by line: what it is doing right now. */
  readonly onSetupLine?: (line: string) => void;
}

export function projectHash(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
}

const CYRILLIC: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

/**
 * `jarvis/<slug of the task>/<run>`: a ticket key stays as it is (`ABC-123`), Cyrillic is spelt in
 * Latin letters, punctuation goes (pilot: a Russian task gave `jarvis/web-app-compact-.-./…`).
 */
export function branchNameFor(task: string, runId: string): string {
  return `jarvis/${taskSlug(task, 40)}/${shortOf(runId)}`;
}

/**
 * Where a run's worktree lives: `<worktreesDir>/<repository>/<run>-<task>`, e.g.
 * `~/.jarvis/worktrees/web-app/1a2b3c4d-compact-form`. Pilot: `5e6f7a8b9c0d/run_1a2b3c4d5e6f…` — the
 * person going there by hand could not tell one run from another.
 */
export function worktreePathFor(worktreesDir: string, repoRoot: string, task: string, runId: string): string {
  const repo =
    basename(repoRoot)
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+/, "") || projectHash(repoRoot);
  return join(worktreesDir, repo, `${shortOf(runId)}-${taskSlug(task, 30)}`);
}

const shortOf = (runId: string): string => runId.replace(/^run_/, "").slice(0, 8);

/** A short readable name of a run's work: `abc-123-1a2b3c4d`, `servis-ne-startuet-1a2b3c4d`. */
export function readableIdFor(task: string, runId: string): string {
  return `${taskSlug(task, 40).toLowerCase()}-${shortOf(runId)}`;
}

/** A ticket key stays as it is (`ABC-123`), Cyrillic is spelt in Latin letters, punctuation goes. */
function taskSlug(task: string, max: number): string {
  const key = /^\s*([A-Z][A-Z0-9]+-\d+)\b/.exec(task)?.[1];
  return key ?? (slugOf(task, max) || "task");
}

/** Words of a text as a branch-safe slug: lower case, Cyrillic in Latin letters, `-` between words. */
export function slugOf(text: string, max: number, sep = "-"): string {
  return [...text.toLowerCase()]
    .map((ch) => CYRILLIC[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]+/g, sep)
    .replace(new RegExp(`^\\${sep}+|\\${sep}+$`, "g"), "")
    .slice(0, max)
    .replace(new RegExp(`\\${sep}+$`), "");
}

async function must(promise: ReturnType<typeof git>, what: string): Promise<string> {
  const r = await promise;
  if (r.code !== 0)
    throw new WorktreeError(`${what}: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
  return r.stdout.trim();
}

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/** Commit identity: explicit GIT_* variables win, then the given identity, then a jarvis default. */
export function gitIdentityEnv(base: NodeJS.ProcessEnv, identity?: GitIdentity): NodeJS.ProcessEnv {
  const env = { ...base };
  env.GIT_AUTHOR_NAME ??= identity?.name ?? "jarvis";
  env.GIT_AUTHOR_EMAIL ??= identity?.email ?? "jarvis@localhost";
  env.GIT_COMMITTER_NAME ??= env.GIT_AUTHOR_NAME;
  env.GIT_COMMITTER_EMAIL ??= env.GIT_AUTHOR_EMAIL;
  return env;
}

export class WorktreeWorkspace implements Workspace {
  readonly ref: WorkspaceRef;
  private readonly env: NodeJS.ProcessEnv;

  constructor(ref: WorkspaceRef, env?: NodeJS.ProcessEnv, identity?: GitIdentity) {
    this.ref = ref;
    this.env = gitIdentityEnv(env ?? process.env, identity);
  }

  static async isDirty(repoRoot: string): Promise<boolean> {
    const r = await git(["status", "--porcelain"], repoRoot);
    return r.code === 0 && r.stdout.trim().length > 0;
  }

  static async create(options: CreateWorktreeOptions): Promise<WorktreeWorkspace> {
    const baseRef = options.baseRef ?? "HEAD";
    const baseCommit = await must(
      git(["rev-parse", "--verify", `${baseRef}^{commit}`], options.repoRoot),
      `resolve base "${baseRef}"`,
    );
    const branch = branchNameFor(options.task, options.runId);
    const path = worktreePathFor(options.worktreesDir, options.repoRoot, options.task, options.runId);
    mkdirSync(join(path, ".."), { recursive: true });
    const clone = options.checkout === "clone";
    if (clone) await createClone(options.repoRoot, path, branch, baseCommit);
    else
      await must(
        git(["worktree", "add", "--quiet", path, "-b", branch, baseCommit], options.repoRoot),
        "create worktree",
      );
    const ref: WorkspaceRef = {
      mode: "worktree",
      repoRoot: options.repoRoot,
      path,
      branch,
      baseRef,
      baseCommit,
      headCommit: baseCommit,
      ...(clone ? { checkout: "clone" as const } : {}),
    };
    options.onStage?.("worktree", path);
    const cache = options.cache;
    const key = cache ? cacheKey(path, cache.key) : undefined;
    const cacheDir = cache ? join(cache.dir, projectHash(options.repoRoot)) : undefined;
    let hit = false;
    if (cache && key && cacheDir) {
      try {
        const restored = await restoreDeps(cacheDir, key, path);
        if (restored) {
          hit = true;
          options.onStage?.("cache", `restored ${restored.join(", ")} (key ${key.slice(0, 8)})`);
        }
      } catch (error) {
        // a broken cache only costs the time of a full setup
        options.onStage?.("cache", `not restored: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (options.setup) {
      options.onStage?.("setup", options.setup);
      const r = await runShell(options.setup, {
        cwd: path,
        timeoutMs: options.setupTimeoutMs ?? 600_000,
        env: options.env ?? process.env,
        ...(options.onSetupLine ? { onLine: options.onSetupLine } : {}),
      });
      if (r.code !== 0 || r.timedOut) {
        // a failed setup leaves no half-made worktree or branch behind (pilot: `jarvis c` failed silently)
        if (clone) rmSync(path, { recursive: true, force: true });
        else await git(["worktree", "remove", "--force", path], options.repoRoot);
        await git(["branch", "-D", branch], options.repoRoot);
        throw new WorktreeError(
          `workspace.setup failed (${r.timedOut ? "timed out" : `exit ${r.code ?? "killed"}`}): ${(r.stderr || r.stdout).trim().slice(-2000)}`,
        );
      }
    }
    if (cache && key && cacheDir && !hit) {
      try {
        const saved = await saveDeps(cacheDir, key, path, cache.paths);
        if (saved.length > 0) options.onStage?.("cache", `kept ${saved.join(", ")} for the next run`);
      } catch (error) {
        options.onStage?.("cache", `not kept: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return new WorktreeWorkspace(ref, options.env);
  }

  static open(ref: WorkspaceRef, env?: NodeJS.ProcessEnv, identity?: GitIdentity): WorktreeWorkspace {
    if (!existsSync(ref.path))
      throw new WorktreeError(`worktree ${ref.path} is missing (removed by gc?); the run cannot continue`);
    return new WorktreeWorkspace(ref, env, identity);
  }

  async head(): Promise<string> {
    return must(git(["rev-parse", "HEAD"], this.ref.path), "rev-parse HEAD");
  }

  /** Commits everything in the worktree; returns the resulting (or unchanged) HEAD. */
  async checkpoint(message: string, trailers: Record<string, string> = {}): Promise<string> {
    await must(git(["add", "-A"], this.ref.path), "git add");
    const staged = await git(["diff", "--cached", "--quiet"], this.ref.path);
    if (staged.code === 0) return this.head();
    const body = `${message}\n\n${Object.entries(trailers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n")}`.trimEnd();
    await must(
      git(["commit", "-q", "--no-verify", "-m", body], this.ref.path, { env: this.env }),
      "git commit",
    );
    return this.head();
  }

  async humanCheckpoint(actorId: string): Promise<{ commit: string; files: string[] } | undefined> {
    const status = await git(["status", "--porcelain"], this.ref.path);
    if (status.code !== 0 || status.stdout.trim().length === 0) return undefined;
    const files = status.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3).trim())
      .sort();
    const commit = await this.checkpoint("human edit", {
      "Jarvis-Actor": actorId,
      "Jarvis-Kind": "human-edit",
    });
    return { commit, files };
  }

  async sweepScratch(): Promise<string[]> {
    const r = await git(["ls-files", "--others", "--exclude-standard"], this.ref.path);
    if (r.code !== 0) return [];
    const scratch = r.stdout.split("\n").filter((f) => f.length > 0 && isScratchFile(f));
    for (const file of scratch) rmSync(join(this.ref.path, file), { force: true });
    return scratch;
  }

  async restore(commit: string | undefined): Promise<void> {
    const target = commit ?? this.ref.baseCommit;
    if (!target) return;
    await must(git(["reset", "-q", "--hard", target], this.ref.path), "git reset");
    await must(git(["clean", "-fdq"], this.ref.path), "git clean");
    // a clone's branch moved back: the repository's copy of it too
    if (this.ref.checkout === "clone" && this.ref.branch) await pushBranch(this.ref.path, this.ref.branch);
  }

  /** Where the run's commits are read: its checkout, or — removed — its branch in the repository. */
  private tip(): { cwd: string; rev: string } {
    return existsSync(this.ref.path) || !this.ref.branch
      ? { cwd: this.ref.path, rev: "HEAD" }
      : { cwd: this.ref.repoRoot, rev: this.ref.branch };
  }

  async diff(): Promise<string> {
    const t = this.tip();
    return (await git(["diff", "--no-color", `${this.ref.baseCommit}..${t.rev}`], t.cwd)).stdout;
  }

  async changedFiles(): Promise<string[]> {
    const t = this.tip();
    const r = await git(["diff", "--name-only", `${this.ref.baseCommit}..${t.rev}`], t.cwd);
    return r.stdout.split("\n").filter((l) => l.length > 0);
  }

  /** ADR-0003 §4: squash the run branch onto the branch checked out in the main repository. */
  /**
   * ADR-0003 §4: the run's own changes — `base..branch`, not the branch — as one commit on the
   * branch checked out in the main repository. Pilot: the main branch's last commit was amended after
   * the run started; a squash merge of the run branch then carried the old commit too and collided
   * with its new version (`CONFLICT (add/add)` on a file the run never touched).
   */
  async apply(message: string): Promise<{ commit: string; files: string[] }> {
    const files = await this.changedFiles();
    if (files.length === 0) throw new WorktreeError("nothing to apply: the run produced no changes");
    const repo = this.ref.repoRoot;
    if (await WorktreeWorkspace.isDirty(repo)) {
      throw new WorktreeError(
        "the main working tree has uncommitted changes; commit or stash them before `jarvis apply`",
      );
    }
    const base = this.ref.baseCommit ?? this.ref.baseRef;
    const branch = this.ref.branch as string;
    // the raw output: a trailing context line of a single space is part of the patch
    const diff = await git(["diff", "--binary", "--full-index", `${base}..${branch}`], repo);
    if (diff.code !== 0) throw new WorktreeError(`git diff: ${diff.stderr.trim() || `exit ${diff.code}`}`);
    const patch = diff.stdout;
    const dir = mkdtempSync(join(tmpdir(), "jarvis-apply-"));
    const file = join(dir, "run.patch");
    try {
      writeFileSync(file, patch.endsWith("\n") ? patch : `${patch}\n`);
      const applied = await git(["apply", "--3way", "--index", file], repo);
      if (applied.code !== 0) {
        const unmerged = (await git(["diff", "--name-only", "--diff-filter=U"], repo)).stdout
          .split("\n")
          .filter(Boolean);
        // leave the main checkout as it was: the person decides how to resolve
        await git(["reset", "-q", "--hard"], repo);
        throw new WorktreeError(
          `the run's changes conflict with your branch${unmerged.length > 0 ? ` in ${unmerged.join(", ")}` : ""}: ${applied.stderr.trim().split("\n").slice(-2).join(" ")}; to resolve by hand: git diff ${base.slice(0, 8)}..${branch} | git apply --3way, fix the conflict markers, commit`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await must(git(["commit", "-q", "--no-verify", "-m", message], repo, { env: this.env }), "git commit");
    const commit = await must(git(["rev-parse", "HEAD"], repo), "rev-parse");
    return { commit, files };
  }

  /**
   * Removes the checkout and, with `pruneBranch`, its branch. The folder is first renamed aside (one
   * call, the same disk) and git forgets the worktree; the files — a monorepo's `node_modules` are
   * hundreds of thousands — are deleted by a detached `rm -rf` that outlives the command. Pilot:
   * `git worktree remove` deleted them one by one, silently, past its two-minute timeout.
   */
  async remove(options: { pruneBranch?: boolean } = {}): Promise<void> {
    const path = this.ref.path;
    const aside = `${path}.removing-${Date.now()}`;
    let moved = false;
    try {
      renameSync(path, aside);
      moved = true;
    } catch {
      // another disk or no permission: let git remove it, without the usual timeout
    }
    if (!moved && this.ref.checkout === "clone") rmSync(path, { recursive: true, force: true });
    else if (!moved)
      await git(["worktree", "remove", "--force", path], this.ref.repoRoot, { timeoutMs: 3_600_000 });
    await git(["worktree", "prune"], this.ref.repoRoot);
    if (moved) deleteInBackground(aside);
    if (options.pruneBranch && this.ref.branch)
      await deleteBranchKeepingTip(this.ref.repoRoot, this.ref.branch);
  }
}

/**
 * Deletes a run's branch and keeps its last commit under `refs/jarvis/removed/<branch>`: a branch
 * deleted with its run's work not taken can be brought back (`git branch <branch> refs/jarvis/removed/<branch>`).
 * Pilot: a finished run's branch was deleted from its page before its changes were applied.
 */
export async function deleteBranchKeepingTip(repoRoot: string, branch: string): Promise<void> {
  const tip = await git(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], repoRoot);
  if (tip.code === 0) await git(["update-ref", `refs/jarvis/removed/${branch}`, tip.stdout.trim()], repoRoot);
  await git(["branch", "-D", branch], repoRoot);
}

/** The file in a clone's `.git` that names the repository it was cloned from (`mainCheckoutOf`). */
export const CLONE_MAIN_FILE = "jarvis-main";

/**
 * A run's checkout as a `git clone --shared`: a `.git` directory of its own (tools that read git with
 * JGit do not know worktrees), the objects borrowed from the repository, the run's branch made there
 * and pushed back to the repository on every commit (a post-commit hook), so `jarvis diff`, `apply`
 * and the pages see it there as they see a worktree's.
 */
async function createClone(
  repoRoot: string,
  path: string,
  branch: string,
  baseCommit: string,
): Promise<void> {
  await must(
    git(["clone", "--quiet", "--shared", "--no-checkout", repoRoot, path], repoRoot),
    "git clone --shared",
  );
  try {
    await must(git(["checkout", "-q", "-b", branch, baseCommit], path), "checkout the run's branch");
    writeFileSync(join(path, ".git", CLONE_MAIN_FILE), `${repoRoot}\n`);
    const hook = join(path, ".git", "hooks", "post-commit");
    mkdirSync(join(path, ".git", "hooks"), { recursive: true });
    writeFileSync(
      hook,
      `#!/bin/sh\n# jarvis: the run's branch goes back to the repository it came from\ngit push --quiet --force origin "HEAD:refs/heads/${branch}" >/dev/null 2>&1 || true\n`,
    );
    chmodSync(hook, 0o755);
    await pushBranch(path, branch);
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
}

/** The clone's branch, as it is, into the repository it came from. */
async function pushBranch(path: string, branch: string): Promise<void> {
  await must(
    git(["push", "--quiet", "--force", "origin", `HEAD:refs/heads/${branch}`], path),
    "push the run's branch",
  );
}

export function workspaceFactory(env?: NodeJS.ProcessEnv): WorkspaceFactory {
  return {
    async open(ref) {
      return ref.mode === "worktree" ? WorktreeWorkspace.open(ref, env) : new CwdWorkspace(ref);
    },
  };
}

/** `rm -rf` detached from this process (it may take minutes); in-process where there is no `rm`. */
function deleteInBackground(path: string): void {
  if (process.platform === "win32") {
    rmSync(path, { recursive: true, force: true });
    return;
  }
  try {
    const child = spawn("rm", ["-rf", path], { detached: true, stdio: "ignore" });
    child.on("error", () => rmSync(path, { recursive: true, force: true }));
    child.unref();
  } catch {
    rmSync(path, { recursive: true, force: true });
  }
}

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WorkspaceRef } from "../core/domain/run.ts";
import { git, runShell } from "../tools/local/exec.ts";
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
  /** Told when the worktree exists and before `setup` runs (it can take minutes: say so). */
  readonly onStage?: (stage: "worktree" | "setup", detail: string) => void;
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
  const key = /^\s*([A-Z][A-Z0-9]+-\d+)\b/.exec(task)?.[1];
  const slug =
    key ??
    ([...task.toLowerCase()]
      .map((ch) => CYRILLIC[ch] ?? ch)
      .join("")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") ||
      "task");
  return `jarvis/${slug}/${runId.replace(/^run_/, "").slice(0, 8)}`;
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
    const path = join(options.worktreesDir, projectHash(options.repoRoot), options.runId);
    mkdirSync(join(options.worktreesDir, projectHash(options.repoRoot)), { recursive: true });
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
    };
    options.onStage?.("worktree", path);
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
        await git(["worktree", "remove", "--force", path], options.repoRoot);
        await git(["branch", "-D", branch], options.repoRoot);
        throw new WorktreeError(
          `workspace.setup failed (${r.timedOut ? "timed out" : `exit ${r.code ?? "killed"}`}): ${(r.stderr || r.stdout).trim().slice(-2000)}`,
        );
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

  async restore(commit: string | undefined): Promise<void> {
    const target = commit ?? this.ref.baseCommit;
    if (!target) return;
    await must(git(["reset", "-q", "--hard", target], this.ref.path), "git reset");
    await must(git(["clean", "-fdq"], this.ref.path), "git clean");
  }

  async diff(): Promise<string> {
    return (await git(["diff", "--no-color", `${this.ref.baseCommit}..HEAD`], this.ref.path)).stdout;
  }

  async changedFiles(): Promise<string[]> {
    const r = await git(["diff", "--name-only", `${this.ref.baseCommit}..HEAD`], this.ref.path);
    return r.stdout.split("\n").filter((l) => l.length > 0);
  }

  /** ADR-0003 §4: squash the run branch onto the branch checked out in the main repository. */
  async apply(message: string): Promise<{ commit: string; files: string[] }> {
    const files = await this.changedFiles();
    if (files.length === 0) throw new WorktreeError("nothing to apply: the run produced no changes");
    if (await WorktreeWorkspace.isDirty(this.ref.repoRoot)) {
      throw new WorktreeError(
        "the main working tree has uncommitted changes; commit or stash them before `jarvis apply`",
      );
    }
    const merge = await git(
      ["merge", "--squash", "--no-commit", this.ref.branch as string],
      this.ref.repoRoot,
    );
    if (merge.code !== 0) {
      await git(["merge", "--abort"], this.ref.repoRoot);
      await git(["reset", "-q", "--hard"], this.ref.repoRoot);
      throw new WorktreeError(
        `squash merge conflicts: ${merge.stderr.trim() || merge.stdout.trim()}; rebase the run branch ${this.ref.branch} manually`,
      );
    }
    await must(
      git(["commit", "-q", "--no-verify", "-m", message], this.ref.repoRoot, { env: this.env }),
      "git commit",
    );
    const commit = await must(git(["rev-parse", "HEAD"], this.ref.repoRoot), "rev-parse");
    return { commit, files };
  }

  async remove(options: { pruneBranch?: boolean } = {}): Promise<void> {
    await git(["worktree", "remove", "--force", this.ref.path], this.ref.repoRoot);
    await git(["worktree", "prune"], this.ref.repoRoot);
    if (options.pruneBranch && this.ref.branch)
      await git(["branch", "-D", this.ref.branch], this.ref.repoRoot);
  }
}

export function workspaceFactory(env?: NodeJS.ProcessEnv): WorkspaceFactory {
  return {
    async open(ref) {
      return ref.mode === "worktree" ? WorktreeWorkspace.open(ref, env) : new CwdWorkspace(ref);
    },
  };
}

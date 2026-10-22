import { PR_REQUEST, prOf, requestOf, scopeNamed } from "../../app/deliver.ts";
import { FormatError, headerOf, trailersOf } from "../../app/deliveryFormat.ts";
import { prReviewOf } from "../../app/prReview.ts";
import { commentText, markThreads, threadsToFix, triageOf } from "../../app/prTriage.ts";
import type { Run } from "../../core/domain/run.ts";
import { git } from "../../tools/local/exec.ts";
import { runEffect } from "../effects.ts";
import type { DeterministicTool } from "../executors.ts";
import type { StepContext } from "../types.ts";
import { gitIdentityEnv } from "../worktree.ts";

/**
 * The PR flow's fixes (`jarvis pr-fix <run>`, workflow `pr-fix`): a run of its own on top of the PR's
 * branch. `pr.fixInput` gives the implementation the threads to fix — the reviewer's words, the
 * agent's what-to-change, the place — and the PR run's spec; `pr.pushFix` puts the change on the PR's
 * branch as one commit by the team's `delivery.commit.fix` (never a force-push), and answers each
 * thread «fixed in <commit>». The PR run's threads move to `fixing`, then `fixed`.
 */

function parentOf(ctx: StepContext): Run | undefined {
  const id = ctx.run.options?.prFix?.runId;
  return id ? ctx.runtime.runs.get(id) : undefined;
}

const fixInput: DeterministicTool = async (ctx) => {
  const parent = parentOf(ctx);
  if (!parent) return { status: "failure", reason: "a PR fix names the run whose PR it is (--pr-fix)" };
  const review = prReviewOf(ctx.runtime, parent);
  const items = threadsToFix(ctx.runtime, parent);
  if (items.length === 0) return { status: "failure", reason: "no thread of the PR is to be fixed" };
  const lines: string[] = [
    "# The PR's review comments to fix",
    "Reviewers commented the pull request of this task; these threads are agreed to change. Change exactly what each asks — nothing else — and keep the tests passing. Each thread: where, the reviewer's words, what to change.",
  ];
  for (const item of items) {
    const thread = review?.threads.find((t) => t.id === item.thread);
    const where = thread?.file
      ? `${thread.file}${thread.line ? `:${thread.line}` : ""}`
      : "the PR as a whole";
    const said: string[] = [];
    const walk = (c: { author: string; text: string; mine?: boolean; replies: readonly unknown[] }) => {
      said.push(`> ${c.mine ? "Jarvis" : c.author}: ${commentText(c.text)}`);
      for (const r of c.replies as (typeof c)[]) walk(r);
    };
    if (thread) walk(thread);
    lines.push(
      `## Thread ${item.thread} — ${where}`,
      ...said,
      `What to change: ${item.change ?? item.reason}`,
    );
  }
  const put = (type: string, name: string, content: string, mediaType: string) =>
    ctx.runtime.artifacts.put({
      runId: ctx.run.id,
      type,
      name,
      content,
      mediaType,
      provenance: { kind: "tool", capability: "pr.fixInput" },
      stepId: ctx.step.id,
      iteration: ctx.iteration,
    });
  const outputs: string[] = [];
  const a = put("review", "pr-comments.md", lines.join("\n\n"), "text/markdown");
  outputs.push(`${a.artifactId}@${a.version}`);
  // the PR run's spec: what the change is for, so a fix keeps to it
  const spec = ctx.runtime.artifacts.listLatest(parent.id, "spec")[0];
  if (spec) {
    const s = put(
      "spec",
      spec.name,
      ctx.runtime.artifacts.text(spec),
      spec.name.endsWith(".md") ? "text/markdown" : "application/json",
    );
    outputs.push(`${s.artifactId}@${s.version}`);
  }
  markThreads(
    ctx.runtime,
    parent,
    items.map((i) => i.thread),
    "fixing",
    { run: ctx.run.id },
  );
  return { status: "success", outputs };
};

const pushFix: DeterministicTool = async (ctx) => {
  const parent = parentOf(ctx);
  const pr = parent ? prOf(ctx.runtime, parent) : undefined;
  if (!parent || !pr?.id) return { status: "failure", reason: "the PR run or its PR is gone" };
  const fixing = triageOf(ctx.runtime, parent).items.filter(
    (i) => i.state === "fixing" && i.fix?.run === ctx.run.id,
  );
  const ws = ctx.run.workspace;
  const base = ws.baseCommit;
  if (!base) return { status: "failure", reason: "the fix run has no base commit" };
  // everything the fix changed, as one tree over the PR's head
  await git(["add", "-A"], ws.path);
  const tree = (await git(["write-tree"], ws.path)).stdout.trim();
  const baseTree = (await git(["rev-parse", `${base}^{tree}`], ws.path)).stdout.trim();
  if (!tree || tree === baseTree) return { status: "failure", reason: "the fix changed nothing" };
  const cfg = ctx.runtime.loaded.config.delivery;
  const files = (await git(["diff", "--name-only", "--cached", base], ws.path)).stdout
    .split("\n")
    .filter(Boolean);
  let message: string;
  try {
    const input = {
      task: parent.task,
      title: "address review comments",
      ...(parent.options?.kind ? { kind: parent.options.kind } : {}),
      files,
      ...((s) => (s ? { scope: s } : {}))(scopeNamed(ctx.runtime, ctx.run.id)),
      runId: ctx.run.id,
    };
    message = `${headerOf(cfg, input, cfg.commit.fix)}\n\n${trailersOf(cfg, ctx.run.id)}`;
  } catch (error) {
    if (error instanceof FormatError) return { status: "failure", reason: error.message };
    throw error;
  }
  const env = gitIdentityEnv(ctx.runtime.env, {
    name: parent.owner.display ?? parent.owner.id,
    email: parent.owner.id,
  });
  const made = await git(["commit-tree", tree, "-p", base, "-m", message], ws.path, { env });
  if (made.code !== 0) return { status: "failure", reason: `the commit was not made: ${made.stderr.trim()}` };
  const commit = made.stdout.trim();
  const remote = cfg.remote;
  // onto the PR's branch, never forced: a branch that moved on refuses it, and the person decides
  const pushed = await runEffect(ctx.runtime.effects, ctx.lease, ctx.runtime.events, {
    runId: ctx.run.id,
    stepId: ctx.step.id,
    iteration: ctx.iteration,
    capability: "git.push",
    args: { remote, branch: pr.source, commit },
    seq: 0,
    execute: async () => {
      const r = await git(["push", "--porcelain", remote, `${commit}:refs/heads/${pr.source}`], ws.repoRoot, {
        env: ctx.runtime.env,
        timeoutMs: 300_000,
      });
      if (r.code !== 0)
        throw new Error(
          `${pr.source} was not pushed (moved on since the fix began? the fix is kept in this run's branch): ${(r.stderr.trim() || r.stdout.trim()).split("\n").slice(-2).join(" ")}`,
        );
      return { pushed: commit };
    },
    verify: async () => {
      const r = await git(["ls-remote", remote, `refs/heads/${pr.source}`], ws.repoRoot, {
        env: ctx.runtime.env,
      });
      return r.stdout.startsWith(commit) ? { pushed: commit } : "not-found";
    },
  }).catch((error: unknown) => error as Error);
  if (pushed instanceof Error) {
    markThreads(
      ctx.runtime,
      parent,
      fixing.map((i) => i.thread),
      "to-fix",
    );
    return { status: "failure", reason: pushed.message };
  }
  // each fixed thread answered: the agent's reply and the line that says Jarvis fixed it
  const reqArtifact = ctx.runtime.artifacts.listLatest(parent.id, PR_REQUEST)[0];
  const request = reqArtifact ? requestOf(ctx.runtime, reqArtifact) : undefined;
  const short = commit.slice(0, 10);
  const unanswered: number[] = [];
  for (const item of fixing) {
    const ru = /[а-яё]/i.test(item.reply);
    const content = `${item.reply.trim()}\n\n${ru ? `— Jarvis: исправлено в ${short}` : `— Jarvis: fixed in ${short}`}`;
    try {
      const r = await ctx.tools.invoke("bitbucket.pr.comment", {
        ...(request?.workspace ? { workspace: request.workspace } : {}),
        ...(request?.repo ? { repo: request.repo } : {}),
        id: pr.id,
        parent: item.thread,
        content,
      });
      if (!r.ok) unanswered.push(item.thread);
    } catch {
      unanswered.push(item.thread);
    }
  }
  markThreads(
    ctx.runtime,
    parent,
    fixing.map((i) => i.thread),
    "fixed",
    { run: ctx.run.id, commit },
  );
  ctx.runtime.events.emit({
    kind: "pr.fixPushed",
    runId: parent.id,
    payload: {
      run: ctx.run.id,
      commit: short,
      threads: fixing.length,
      unanswered: unanswered.length,
      branch: pr.source,
    },
  });
  return { status: "success" };
};

export const PR_FIX_TOOLS: Record<string, DeterministicTool> = {
  "pr.fixInput": fixInput,
  "pr.pushFix": pushFix,
};

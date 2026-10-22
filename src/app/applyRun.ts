import { existsSync } from "node:fs";
import type { Actor } from "../core/domain/actor.ts";
import type { Run } from "../core/domain/run.ts";
import { removeMarkers } from "../interaction/review/collector.ts";
import { WorktreeWorkspace } from "../orchestration/worktree.ts";
import { shortRunId } from "../storage/runStore.ts";
import { git } from "../tools/local/exec.ts";
import { scopeNamed } from "./deliver.ts";
import { commitMessageOf, FormatError } from "./deliveryFormat.ts";
import type { Runtime } from "./runtime.ts";

/**
 * A run's own changes as one commit on the branch checked out in the repository (ADR-0003 §4): the
 * same from `jarvis apply` and from the run's page. Works from the run's branch in the repository,
 * also when its checkout is gone. Throws `WorktreeError` with what to do (a dirty checkout, a conflict).
 */
export async function applyRun(
  runtime: Runtime,
  run: Run,
  actor: Actor,
  env: NodeJS.ProcessEnv,
  message?: string,
): Promise<{ commit: string; files: string[] }> {
  const ws = run.workspace;
  const identity = { name: actor.display ?? actor.id, email: actor.id };
  const wt = new WorktreeWorkspace(ws, env, identity);
  await removeReviewMarkers(runtime, run, wt);
  const trailer = `Jarvis-Run: ${run.id}`;
  // the subject: the task's first line, short (the task may be a paragraph)
  const first = (run.task.split("\n")[0] ?? run.task).trim();
  const subject = first.length > 72 ? `${first.slice(0, 69).trimEnd()}…` : first;
  const text = message
    ? message.includes(trailer)
      ? message
      : `${message.trimEnd()}\n\n${trailer}`
    : ((await teamMessage(runtime, run)) ??
      `${subject}: apply jarvis run ${shortRunId(run.id)}\n\n${trailer}`);
  const result = await wt.apply(text);
  runtime.events.emit({
    kind: "run.applied",
    runId: run.id,
    actor: `${actor.kind}:${actor.id}`,
    payload: { commit: result.commit, files: result.files.length },
  });
  return result;
}

/**
 * The commit's message by the team's standard (`delivery.commit.format`), when the project set one:
 * the same as a PR's. Without the issue key the format wants, the plain message.
 */
async function teamMessage(runtime: Runtime, run: Run): Promise<string | undefined> {
  const cfg = runtime.loaded.config.delivery;
  if (cfg.commit.format === "{subject}") return undefined;
  const ws = run.workspace;
  const diff =
    ws.branch && ws.baseCommit
      ? await git(["diff", "--name-only", `${ws.baseCommit}..${ws.branch}`], ws.repoRoot)
      : undefined;
  try {
    return commitMessageOf(cfg, {
      task: run.task,
      title: (run.task.split("\n")[0] ?? run.task).trim(),
      ...(run.options?.kind ? { kind: run.options.kind } : {}),
      files: diff?.code === 0 ? diff.stdout.split("\n").filter(Boolean) : [],
      ...((s) => (s ? { scope: s } : {}))(scopeNamed(runtime, run.id)),
      runId: run.id,
    });
  } catch (error) {
    if (error instanceof FormatError) return undefined;
    throw error;
  }
}

/**
 * ADR-0019 §5: markers leave the code once the work is approved, before it goes anywhere (Apply or a
 * PR); the threads stay in the store.
 */
export async function removeReviewMarkers(runtime: Runtime, run: Run, wt: WorktreeWorkspace): Promise<void> {
  const ws = run.workspace;
  if (!existsSync(ws.path) || !runtime.loaded.config.human.review.removeMarkersAfterApproval) return;
  const stripped = await removeMarkers(ws.path);
  if (stripped.length === 0) return;
  await wt.checkpoint("jarvis: remove review markers", {
    "Jarvis-Run": run.id,
    "Jarvis-Kind": "review-cleanup",
  });
  runtime.events.emit({ kind: "review.markersRemoved", runId: run.id, payload: { files: stripped } });
}

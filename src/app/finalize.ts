import { existsSync } from "node:fs";
import { type Actor, formatActor } from "../core/domain/actor.ts";
import type { Run } from "../core/domain/run.ts";
import { caseOfRun, casesRootOf, runToCase } from "../evals/runToCase.ts";
import { WorktreeWorkspace } from "../orchestration/worktree.ts";
import { prOf } from "./deliver.ts";
import { prReviewOf } from "./prReview.ts";
import { triageOf } from "./prTriage.ts";
import { proposeRepeatedFindings } from "./repeatedFindings.ts";
import type { Runtime } from "./runtime.ts";

/**
 * The end of the PR flow: the task finalized by a person — usually once its PR is ready for merge or
 * merged (the merge is always a person's), or earlier, said so. What goes with it, each as asked: an
 * eval case made of the run; the PR's agreed comments kept as the run's review findings, so a comment
 * reviewers keep making becomes a standard candidate (src/app/repeatedFindings.ts); the run's checkout
 * removed (the branch stays: the PR has it). Recorded as `run.finalized`; the run stops following its PR.
 */

export class FinalizeError extends Error {
  readonly code: "no-pr" | "not-ready" | "done";
  constructor(code: FinalizeError["code"], message: string) {
    super(message);
    this.name = "FinalizeError";
    this.code = code;
  }
}

export interface FinalizeOptions {
  readonly evalCase?: boolean;
  readonly suite?: string;
  /** The PR's agreed comments into the run's review findings. */
  readonly lessons?: boolean;
  /** The PR is not ready for merge, and the person finalizes anyway. */
  readonly anyway?: boolean;
}

export interface Finalized {
  readonly ready: boolean;
  readonly merged: boolean;
  readonly evalCase?: string;
  readonly lessons: number;
  readonly candidates: number;
  readonly checkoutRemoved: boolean;
}

export function finalizedOf(runtime: Runtime, run: Run): { by?: string; at: string } | undefined {
  const e = runtime.events.list({ runId: run.id, kind: "run.finalized", latest: true, limit: 1 })[0];
  return e ? { ...(e.actor ? { by: e.actor } : {}), at: e.ts } : undefined;
}

/** The PR's comments the code changed for, as review findings: what a reviewer had to say. */
function lessonsOf(runtime: Runtime, run: Run): Array<Record<string, unknown>> {
  const review = prReviewOf(runtime, run);
  return triageOf(runtime, run)
    .items.filter((i) => i.verdict === "agree" || i.state === "fixed")
    .map((i) => {
      const thread = review?.threads.find((t) => t.id === i.thread);
      const said = thread?.text.replace(/<!--[\s\S]*?-->/g, "").trim();
      return {
        severity: "minor",
        issue: said || i.reason,
        ...(i.change ? { suggestion: i.change } : {}),
        ...(thread?.file ? { file: thread.file } : {}),
        ...(thread?.line ? { line: thread.line } : {}),
      };
    });
}

export async function finalizeRun(
  runtime: Runtime,
  run: Run,
  actor: Actor,
  options: FinalizeOptions = {},
): Promise<Finalized> {
  if (!prOf(runtime, run)) throw new FinalizeError("no-pr", "the run has no PR to finalize");
  if (finalizedOf(runtime, run)) throw new FinalizeError("done", "the task is finalized already");
  const doc = prReviewOf(runtime, run);
  const merged = doc?.state === "MERGED";
  const ready = merged || doc?.ready === true;
  if (!ready && !options.anyway)
    throw new FinalizeError(
      "not-ready",
      `the PR is not ready for merge${doc?.blockers.length ? ` (${doc.blockers.join("; ")})` : ""}: finalize anyway, said so`,
    );
  let lessons = 0;
  let candidates = 0;
  if (options.lessons) {
    const findings = lessonsOf(runtime, run);
    lessons = findings.length;
    if (findings.length > 0) {
      runtime.artifacts.put({
        runId: run.id,
        type: "review",
        name: "pr-comments.json",
        content: JSON.stringify(
          { summary: "The PR's review comments the code changed for", findings },
          null,
          2,
        ),
        mediaType: "application/json",
        provenance: { kind: "tool", capability: "runtime.finalize" },
        stepId: "finalize",
      });
      candidates = proposeRepeatedFindings(runtime, run).length;
    }
  }
  let evalCase: string | undefined;
  if (options.evalCase) {
    const root = casesRootOf(run.workspace.repoRoot);
    evalCase = caseOfRun(root, run.id)?.dir;
    if (!evalCase) {
      const made = await runToCase(runtime, run.id, {
        suiteDir: `${root}/evals/${options.suite ?? "default"}`,
      });
      evalCase = made.caseDir;
    }
  }
  // the checkout is not needed any more; the branch stays — the PR is made of it
  const ws = run.workspace;
  const checkoutRemoved = ws.mode === "worktree" && existsSync(ws.path);
  if (checkoutRemoved) await new WorktreeWorkspace(ws, runtime.env).remove({ pruneBranch: false });
  const done: Finalized = {
    ready,
    merged,
    ...(evalCase ? { evalCase } : {}),
    lessons,
    candidates,
    checkoutRemoved,
  };
  runtime.events.emit({
    kind: "run.finalized",
    runId: run.id,
    actor: formatActor(actor),
    payload: { ...done },
  });
  return done;
}

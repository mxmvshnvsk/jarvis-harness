import type { Runtime } from "../../app/runtime.ts";
import type { Run } from "../../core/domain/run.ts";
import type { Interaction } from "../store.ts";

/**
 * Per-comment review lifecycle (ADR-0019 §5):
 *   open → acknowledged (classified by review-analysis) → applied (an implementation round ran)
 *        → ready_for_review (the gate is reached again) → resolved (approved) — or a new comment
 *   on the same place starts the cycle again. Comments that need no action (SUGGESTION,
 *   KNOWLEDGE_CANDIDATE) resolve at classification. State lives in the review session's meta.
 */
export type CommentState = "open" | "acknowledged" | "applied" | "ready_for_review" | "resolved";

export interface CommentRecord {
  readonly id: string;
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly state: CommentState;
  readonly class?: string;
  readonly action?: string;
  readonly history: Array<{ state: CommentState; at: string; by: string }>;
}

export type CommentMap = Record<string, CommentRecord>;

export function commentsOf(session: Interaction): CommentMap {
  const raw = session.meta.comments;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as CommentMap) : {};
}

function save(runtime: Runtime, session: Interaction, comments: CommentMap): void {
  runtime.interactions.setMeta(session.id, { ...session.meta, comments });
}

function move(
  c: CommentRecord,
  state: CommentState,
  by: string,
  extra: Partial<CommentRecord> = {},
): CommentRecord {
  if (c.state === state) return { ...c, ...extra };
  return { ...c, ...extra, state, history: [...c.history, { state, at: new Date().toISOString(), by }] };
}

/** The review session that is still active for a run (not resolved/rejected). */
export function activeSession(runtime: Runtime, runId: string): Interaction | undefined {
  return runtime.interactions.openFor(runId, "review");
}

/** A new submission: comments seen before keep their state and history; new ones start open. */
export function seedComments(
  runtime: Runtime,
  runId: string,
  collected: ReadonlyArray<{ id: string; file: string; line: number; text: string }>,
  by: string,
): CommentMap {
  const previous: CommentMap = {};
  for (const session of runtime.interactions.listForRun(runId).filter((i) => i.kind === "review")) {
    Object.assign(previous, commentsOf(session));
  }
  const comments: CommentMap = {};
  const now = new Date().toISOString();
  for (const c of collected) {
    const prev = previous[c.id];
    const changed = prev !== undefined && prev.text !== c.text;
    comments[c.id] =
      prev && !changed && prev.state !== "resolved"
        ? { ...prev, file: c.file, line: c.line }
        : {
            id: c.id,
            file: c.file,
            line: c.line,
            text: c.text,
            state: "open",
            history: [{ state: "open", at: now, by }],
          };
  }
  return comments;
}

/** review-analysis finished: classify, acknowledge, resolve what needs no action. */
export function afterAnalysis(
  runtime: Runtime,
  run: Run,
  analysis: { comments?: Array<{ id: string; class: string; action?: string }> },
): void {
  const session = activeSession(runtime, run.id);
  if (!session) return;
  const comments = commentsOf(session);
  for (const a of analysis.comments ?? []) {
    const c = comments[a.id];
    if (!c) continue;
    const noAction = a.class === "SUGGESTION" || a.class === "KNOWLEDGE_CANDIDATE";
    comments[a.id] = move(c, noAction ? "resolved" : "acknowledged", "review-analysis", {
      class: a.class,
      ...(a.action ? { action: a.action } : {}),
    });
  }
  save(runtime, session, comments);
  runtime.interactions.setState(session.id, "acknowledged");
  runtime.events.emit({
    kind: "review.classified",
    runId: run.id,
    payload: { session: session.id, comments: Object.values(comments).map((c) => [c.id, c.class, c.state]) },
  });
}

/** An implementation round completed while comments were acknowledged: they are applied. */
export function afterImplementation(runtime: Runtime, run: Run): void {
  const session = activeSession(runtime, run.id);
  if (!session) return;
  const comments = commentsOf(session);
  let changed = false;
  for (const [id, c] of Object.entries(comments)) {
    if (c.state === "acknowledged") {
      comments[id] = move(c, "applied", "implementation");
      changed = true;
    }
  }
  if (!changed) return;
  save(runtime, session, comments);
  runtime.interactions.setState(session.id, "applied");
}

/** The final gate is reached again: applied comments await the reviewer. */
export function afterGateReached(runtime: Runtime, run: Run): void {
  const session = activeSession(runtime, run.id);
  if (!session) return;
  const comments = commentsOf(session);
  let changed = false;
  for (const [id, c] of Object.entries(comments)) {
    if (c.state === "applied") {
      comments[id] = move(c, "ready_for_review", "runtime");
      changed = true;
    }
  }
  if (!changed) return;
  save(runtime, session, comments);
  runtime.interactions.setState(session.id, "ready_for_review");
}

/** The implementation was approved: every comment of the session resolves, the session closes. */
export function afterApproval(runtime: Runtime, run: Run, by: string): void {
  const session = activeSession(runtime, run.id);
  if (!session) return;
  const comments = commentsOf(session);
  for (const [id, c] of Object.entries(comments)) comments[id] = move(c, "resolved", by);
  save(runtime, session, comments);
  runtime.interactions.close(session.id, "resolved", by, session.contentRef);
  runtime.events.emit({
    kind: "review.resolved",
    runId: run.id,
    payload: { session: session.id, comments: Object.keys(comments) },
  });
}

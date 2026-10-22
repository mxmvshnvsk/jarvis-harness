import type { Run } from "../core/domain/run.ts";
import { PR_ARTIFACT, PR_REQUEST, prOf, requestOf } from "./deliver.ts";
import type { Runtime } from "./runtime.ts";

/**
 * The PR flow after the PR is up: its state read from the Bitbucket server — the open threads with
 * their replies, the reviewers' approvals, the tasks, the build of its last commit — and whether it is
 * ready for merge. Read by code, no model; kept as the run's `pr-review` document, a version per
 * read that changed something, and said in the feed. The merge is always a person's.
 */

export const PR_REVIEW = "pr-review";

/** A comment of a thread, and its replies. */
export interface PrComment {
  readonly id: number;
  readonly author: string;
  readonly text: string;
  readonly at?: string;
  /** Jarvis's own (its marker in the text): never answered by Jarvis. */
  readonly mine?: boolean;
  readonly replies: readonly PrComment[];
}

export interface PrThread extends PrComment {
  readonly file?: string;
  readonly line?: number;
  /** A task (Bitbucket Server: BLOCKER), not a plain comment. */
  readonly task?: boolean;
  readonly version?: number;
}

export interface PrReviewDoc {
  readonly pr: {
    readonly id: string;
    readonly url?: string;
    readonly source: string;
    readonly target: string;
  };
  readonly repo?: { readonly workspace?: string; readonly slug?: string };
  readonly state: string;
  /** The PR's version on the server: an update is conditional on it. */
  readonly version?: number;
  readonly reviewers: ReadonlyArray<{ readonly name: string; readonly status?: "APPROVED" | "NEEDS_WORK" }>;
  readonly approvals: number;
  /** The open threads, not resolved. */
  readonly threads: readonly PrThread[];
  readonly openTasks: number;
  readonly build?: { readonly successful: number; readonly failed: number; readonly inProgress: number };
  readonly head?: string;
  readonly ready: boolean;
  /** What stands between the PR and its merge, said. */
  readonly blockers: readonly string[];
  readonly checkedAt: string;
}

/** Jarvis's own comment: its effect marker (`[jarvis:run=… effect=…]`) or an HTML comment mark. */
const MARKER = /<!--\s*jarvis[:\s]|\[jarvis:run=/i;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && /^\d+$/.test(v)
      ? Number(v)
      : undefined;

function json(text: string): Record<string, unknown> | undefined {
  try {
    const body = text.replace(/^\[[a-zA-Z.]+\] ok\n/, "");
    const v = JSON.parse(body.slice(body.indexOf("{")));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function commentOf(o: Record<string, unknown>): PrComment {
  const text = str(o.text) ?? str(o.content) ?? "";
  const replies = Array.isArray(o.replies)
    ? (o.replies as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    : [];
  return {
    id: num(o.id) ?? 0,
    author: str(o.author) ?? "?",
    text,
    ...(str(o.created_on) ? { at: str(o.created_on) as string } : {}),
    ...(MARKER.test(text) ? { mine: true } : {}),
    replies: replies.filter((r) => str(r.state) !== "RESOLVED").map(commentOf),
  };
}

/** The reviewers as the server lists them: `Name (APPROVED)`, `Name (NEEDS_WORK)`, or objects. */
function reviewersOf(v: unknown): PrReviewDoc["reviewers"] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((r) => {
    if (typeof r === "string") {
      const m = /^(.*?)\s*\((APPROVED|NEEDS_WORK)\)\s*$/.exec(r);
      return [m ? { name: m[1] as string, status: m[2] as "APPROVED" | "NEEDS_WORK" } : { name: r }];
    }
    if (r && typeof r === "object") {
      const o = r as Record<string, unknown>;
      const name = str(o.name) ?? str(o.display_name) ?? str(o.displayName) ?? "?";
      const status =
        o.approved === true ? "APPROVED" : str(o.status) === "NEEDS_WORK" ? "NEEDS_WORK" : undefined;
      return [{ name, ...(status ? { status } : {}) } as const];
    }
    return [];
  });
}

/** What `bitbucket.pr.get` answered: state, reviewers, the open threads, the tasks. */
export function prStateOf(
  text: string,
): Omit<PrReviewDoc, "pr" | "repo" | "ready" | "blockers" | "checkedAt"> {
  const doc = json(text) ?? {};
  const comments = Array.isArray(doc.active_comments)
    ? (doc.active_comments as unknown[]).filter(
        (c): c is Record<string, unknown> => !!c && typeof c === "object",
      )
    : [];
  const threads: PrThread[] = comments
    .filter((c) => str(c.state) !== "RESOLVED")
    .map((c) => ({
      ...commentOf(c),
      ...(str(c.file_path) ? { file: str(c.file_path) as string } : {}),
      ...(num(c.line_number) !== undefined ? { line: num(c.line_number) as number } : {}),
      ...(c.is_task === true ? { task: true } : {}),
      ...(num(c.version) !== undefined ? { version: num(c.version) as number } : {}),
    }));
  const reviewers = reviewersOf(doc.reviewers);
  const tasks = Array.isArray(doc.tasks) ? (doc.tasks as Array<Record<string, unknown>>) : undefined;
  const openTasks = num(doc.open_task_count) ?? tasks?.filter((t) => str(t.state) !== "RESOLVED").length ?? 0;
  const head = str(doc.source_commit);
  return {
    state: str(doc.state) ?? "OPEN",
    ...(num(doc.version) !== undefined ? { version: num(doc.version) as number } : {}),
    reviewers,
    approvals: reviewers.filter((r) => r.status === "APPROVED").length,
    threads,
    openTasks,
    ...(head ? { head } : {}),
  };
}

/** The build of the PR's last commit, from `bitbucket.pr.commits` (the latest first). */
export function buildOf(text: string, head?: string): PrReviewDoc["build"] {
  const doc = json(text);
  const commits = Array.isArray(doc?.commits) ? (doc?.commits as Array<Record<string, unknown>>) : [];
  const last =
    (head ? commits.find((c) => head.startsWith(str(c.hash) ?? "\u0000")) : undefined) ?? commits[0];
  const b = last?.build_status as Record<string, unknown> | undefined;
  if (!b) return undefined;
  return {
    successful: num(b.successful) ?? 0,
    failed: num(b.failed) ?? 0,
    inProgress: num(b.in_progress) ?? 0,
  };
}

/** Ready for merge: enough approvals, nobody wants work, no open thread or task, the build green. */
export function readinessOf(
  s: Pick<PrReviewDoc, "state" | "reviewers" | "approvals" | "threads" | "openTasks" | "build">,
  approvals: number,
): { ready: boolean; blockers: string[] } {
  const blockers: string[] = [];
  if (s.state !== "OPEN") return { ready: false, blockers: [`the PR is ${s.state}`] };
  if (s.approvals < approvals) blockers.push(`approvals: ${s.approvals} of ${approvals}`);
  const work = s.reviewers.filter((r) => r.status === "NEEDS_WORK").map((r) => r.name);
  if (work.length > 0) blockers.push(`needs work: ${work.join(", ")}`);
  const open = s.threads.filter((t) => !t.mine).length;
  if (open > 0) blockers.push(`open threads: ${open}`);
  if (s.openTasks > 0) blockers.push(`open tasks: ${s.openTasks}`);
  if (s.build && s.build.failed > 0) blockers.push("the build failed");
  else if (s.build && s.build.inProgress > 0) blockers.push("the build is running");
  return { ready: blockers.length === 0, blockers };
}

/** The run's last read of its PR. */
export function prReviewOf(runtime: Runtime, run: Run): PrReviewDoc | undefined {
  const a = runtime.artifacts.listLatest(run.id, PR_REVIEW)[0];
  if (!a) return undefined;
  try {
    return JSON.parse(runtime.artifacts.text(a)) as PrReviewDoc;
  } catch {
    return undefined;
  }
}

/** The run is following its PR: the PR is up, not merged or declined, the task not finalized. */
export function followsPr(runtime: Runtime, run: Run): boolean {
  if (run.state !== "COMPLETED" || !prOf(runtime, run)) return false;
  if (runtime.events.list({ runId: run.id, kind: "run.finalized", latest: true, limit: 1 }).length > 0)
    return false;
  const last = prReviewOf(runtime, run);
  return !last || last.state === "OPEN";
}

/** Due for a read: never read, or the last read is older than `delivery.flow.pollMinutes`. */
export function prCheckDue(runtime: Runtime, run: Run, now = Date.now()): boolean {
  if (!followsPr(runtime, run)) return false;
  // the last read, changed or not: its event
  const last = runtime.events.list({ runId: run.id, kind: "pr.checked", latest: true, limit: 1 })[0];
  const every = runtime.loaded.config.delivery.flow.pollMinutes * 60_000;
  return !last || now - Date.parse(last.ts) >= every;
}

/** A read capability called outside a step, as `jarvis mcp call` does: undefined — not here, not allowed or failed. */
export type PrReader = (capability: string, args: Record<string, unknown>) => Promise<string | undefined>;

export function mcpReader(runtime: Runtime): PrReader {
  return async (capability, args) => {
    const cap = runtime.registry.get(capability);
    if (!cap || !runtime.tools.policy(cap, ["*"]).allowed) return undefined;
    const call = await runtime.mcp.provider.invoke(capability, args);
    return call.result.ok ? call.result.text : undefined;
  };
}

export class PrCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrCheckError";
  }
}

/**
 * Reads the run's PR now: a new version of `pr-review` when something changed, `pr.checked` in the
 * feed with what is new — comments since the last read, approvals, the build, ready or not.
 */
export async function checkPr(
  runtime: Runtime,
  run: Run,
  channel: "poll" | "ui" | "cli",
  read: PrReader = mcpReader(runtime),
): Promise<PrReviewDoc> {
  const pr = prOf(runtime, run);
  if (!pr?.id) throw new PrCheckError("the run has no PR to read");
  const reqArtifact = runtime.artifacts.listLatest(run.id, PR_REQUEST)[0];
  const request = reqArtifact ? requestOf(runtime, reqArtifact) : undefined;
  const at = {
    ...(request?.workspace ? { workspace: request.workspace } : {}),
    ...(request?.repo ? { repo: request.repo } : {}),
    id: pr.id,
  };
  const got = await read("bitbucket.pr.get", at).catch((error: unknown) => {
    throw new PrCheckError(error instanceof Error ? error.message : String(error));
  });
  if (!got)
    throw new PrCheckError(
      "bitbucket.pr.get is not available or failed: allow it on the Bitbucket MCP server",
    );
  const state = prStateOf(got);
  // the build: optional — a server without it, or not allowed, leaves it unknown, not failed
  const commits = await read("bitbucket.pr.commits", at).catch(() => undefined);
  const build = commits ? buildOf(commits, state.head) : undefined;
  const flow = runtime.loaded.config.delivery.flow;
  const whole = { ...state, ...(build ? { build } : {}) };
  const { ready, blockers } = readinessOf(whole, flow.ready.approvals);
  const before = prReviewOf(runtime, run);
  const doc: PrReviewDoc = {
    pr: { id: pr.id, ...(pr.url ? { url: pr.url } : {}), source: pr.source, target: pr.target },
    ...(request?.workspace || request?.repo
      ? {
          repo: {
            ...(request.workspace ? { workspace: request.workspace } : {}),
            ...(request.repo ? { slug: request.repo } : {}),
          },
        }
      : {}),
    ...whole,
    ready,
    blockers,
    checkedAt: new Date().toISOString(),
  };
  const seen = new Set((before?.threads ?? []).flatMap((t) => [t.id, ...t.replies.map((r) => r.id)]));
  const fresh = doc.threads.flatMap((t) => [t, ...t.replies]).filter((c) => !c.mine && !seen.has(c.id));
  const same =
    before && JSON.stringify({ ...before, checkedAt: "" }) === JSON.stringify({ ...doc, checkedAt: "" });
  // a version only when something changed: a read every few minutes is not a new document
  if (!same)
    runtime.artifacts.put({
      runId: run.id,
      type: PR_REVIEW,
      name: "pr-review.json",
      content: JSON.stringify(doc, null, 2),
      mediaType: "application/json",
      provenance: { kind: "tool", capability: "bitbucket.pr.get" },
      stepId: "pr",
    });
  runtime.events.emit({
    kind: "pr.checked",
    runId: run.id,
    payload: {
      channel,
      state: doc.state,
      fresh: fresh.length,
      open: doc.threads.filter((t) => !t.mine).length,
      approvals: doc.approvals,
      ...(doc.build
        ? { build: doc.build.failed > 0 ? "failed" : doc.build.inProgress > 0 ? "running" : "ok" }
        : {}),
      ready: doc.ready,
      ...(before?.ready !== doc.ready ? { readyChanged: true } : {}),
      ...(same ? { same: true } : {}),
    },
  });
  return doc;
}

export { PR_ARTIFACT };

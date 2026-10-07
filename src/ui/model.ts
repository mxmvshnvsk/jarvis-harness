import { basename } from "node:path";
import { type Activity, activityOf, noticeOf } from "../app/activity.ts";
import { type BudgetGrant, type BudgetStop, budgetGranted, budgetStopOf } from "../app/budgetStop.ts";
import { type BudgetWait, budgetWaitOf } from "../app/budgetWait.ts";
import { candidatesOf } from "../app/candidates.ts";
import { awaitedArtifact, type Decision, decisionOn, rerunRequested, waitingCard } from "../app/decide.ts";
import { Journey, type LoopReport, type StepReport } from "../app/journey.ts";
import { type Resumable, resumableOf } from "../app/resumable.ts";
import type { Runtime } from "../app/runtime.ts";
import type { RunTokens } from "../app/status.ts";
import { type Change, changesIn, homePath } from "../cli/checkout.ts";
import { changedFilesOf, type DocFacts, docFacts, reasonsOf } from "../cli/gate.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import type { WorkflowDefinition } from "../core/domain/workflow.ts";
import type { LocalWorkflowEngine } from "../orchestration/runtime.ts";
import { shortRunId } from "../storage/runStore.ts";
import type { StoredEvent } from "../telemetry/events.ts";

/**
 * What the pages of `jarvis ui` show, read from the same stores and the same journal as the terminal
 * (ADR-0022 §9, ADR-0023 §1): `Journey` for the steps, `activityOf` for what runs now, the loop card's
 * reasons, the gate's brief. No state of its own.
 */

export interface Repo {
  readonly root: string;
  readonly name: string;
  readonly runs: number;
}

export interface LoopCard {
  readonly kind: "loop";
  readonly step: string;
  readonly iterations?: number;
  readonly edge: string;
  readonly from?: string;
  readonly to?: string;
  readonly outcome?: string;
  readonly reasons: ReturnType<typeof reasonsOf>;
  readonly reasonText: string;
  readonly checkout: string;
  readonly checkoutShown: string;
  readonly changes?: readonly Change[];
  /** "Run again" asked since the run stopped (the page, the card's `r`): it goes on, or waits for `jarvis continue`. */
  readonly rerun?: ReturnType<typeof rerunRequested>;
}

export interface ApprovalCard {
  readonly kind: "approval";
  readonly type: string;
  readonly artifact: ArtifactVersion;
  readonly facts?: DocFacts;
  /** The first lines of a document that is not a JSON result. */
  readonly excerpt?: string;
  readonly files?: ReadonlyArray<{ path: string; added: number; removed: number }>;
  readonly decision?: Decision;
}

/** A stop on a budget (src/app/budgetStop.ts): more and go on, or finish the step with what it has. */
export interface BudgetCard {
  readonly kind: "budget";
  readonly stop: BudgetStop;
  readonly changes?: readonly Change[];
  /** Decided since the run stopped (the page, the terminal's card): it goes on, or waits for `continue`. */
  readonly granted?: BudgetGrant;
}

export interface OtherCard {
  readonly kind: "other";
  readonly what: string;
}

export type WaitCard = LoopCard | ApprovalCard | BudgetCard | OtherCard;

export interface WaitingRun {
  readonly run: Run;
  readonly card: WaitCard;
  /** A terminal waits at this run's card: a decision goes on at once. */
  readonly terminal: boolean;
  /** Decided, and nobody goes on with it: "Resume" (src/app/resumable.ts). */
  readonly resumable?: Resumable;
}

export interface RunningRun {
  readonly run: Run;
  /** Parked on a quota window or a model that is down: goes on by itself. */
  readonly wait?: BudgetWait;
  readonly activity?: Activity;
  readonly position?: { readonly index: number; readonly total: number };
}

export interface RecentRun {
  readonly run: Run;
  readonly modelCalls: number;
  readonly tookMs: number;
}

/** A module research whose candidate waits for a review (Knowledge → Modules). */
export interface WaitingCandidate {
  readonly module: string;
  /** Short run id. */
  readonly run: string;
  readonly at: string;
  readonly claims?: { readonly proposed: number; readonly kept: number };
  readonly review: number;
}

export interface RunsPage {
  readonly repos: readonly Repo[];
  /** The repository shown, or undefined for all. */
  readonly repo?: string;
  readonly waiting: readonly WaitingRun[];
  /** Module research waiting for a review: a person decides, as for a run. */
  readonly candidates: readonly WaitingCandidate[];
  readonly running: readonly RunningRun[];
  readonly recent: readonly RecentRun[];
  readonly today: { readonly runs: number; readonly modelCalls: number };
}

const live = (r: Run, now: number) => r.lease !== undefined && Date.parse(r.lease.until) >= now;

function workflowOf(engine: LocalWorkflowEngine, run: Run): WorkflowDefinition | undefined {
  try {
    return engine.workflow(run.workflow);
  } catch {
    return undefined;
  }
}

function runEvents(runtime: Runtime, runId: string): StoredEvent[] {
  return runtime.events.list({ runId, limit: 1_000_000 });
}

/** The repositories runs were made in, the current one first. */
export function reposOf(runs: readonly Run[], current?: string): Repo[] {
  const by = new Map<string, number>();
  for (const r of runs) by.set(r.workspace.repoRoot, (by.get(r.workspace.repoRoot) ?? 0) + 1);
  return [...by.entries()]
    .map(([root, n]) => ({ root, name: basename(root) || root, runs: n }))
    .sort((a, b) => (a.root === current ? -1 : b.root === current ? 1 : a.name.localeCompare(b.name)));
}

export async function waitCardOf(runtime: Runtime, run: Run, homeDir: string): Promise<WaitCard> {
  const kind = run.waitingFor?.kind;
  if (kind === "loop") {
    const record = runtime.artifacts.listLatest(run.id, "loop-exhausted")[0];
    let doc: Record<string, unknown> | undefined;
    try {
      doc = record ? (JSON.parse(runtime.artifacts.text(record)) as Record<string, unknown>) : undefined;
    } catch {
      doc = undefined;
    }
    const edge = typeof doc?.edge === "string" ? doc.edge : (run.waitingFor?.detail ?? "a back edge");
    const route = /^(.+)->(.+)#(.+)$/.exec(edge);
    const reasonText = typeof doc?.reason === "string" ? doc.reason : "";
    const changes = changesIn(run.workspace.path);
    const rerun = rerunRequested(runtime, run.id);
    return {
      kind: "loop",
      step: run.currentStep ?? "the step",
      ...(typeof doc?.iterations === "number" ? { iterations: doc.iterations } : {}),
      edge,
      ...(route ? { from: route[1] as string, to: route[2] as string, outcome: route[3] as string } : {}),
      reasons: reasonsOf(reasonText),
      reasonText,
      checkout: run.workspace.path,
      checkoutShown: homePath(run.workspace.path, homeDir),
      ...(changes ? { changes } : {}),
      ...(rerun ? { rerun } : {}),
    };
  }
  if (kind === "budget") {
    const stop = budgetStopOf(runtime, run);
    if (stop) {
      const changes = run.workspace.mode === "worktree" ? changesIn(run.workspace.path) : undefined;
      const granted = budgetGranted(runtime, run.id);
      return { kind: "budget", stop, ...(changes ? { changes } : {}), ...(granted ? { granted } : {}) };
    }
  }
  const awaited = kind === "approval" || !kind ? awaitedArtifact(runtime, run) : undefined;
  if (awaited) {
    const text = runtime.artifacts.text(awaited.artifact);
    const facts = docFacts(awaited.artifact.name, text);
    const files = awaited.type === "implementation" ? await changedFilesOf(run).catch(() => []) : [];
    const decision = decisionOn(runtime, awaited.artifact);
    return {
      kind: "approval",
      type: awaited.type,
      artifact: awaited.artifact,
      ...(facts ? { facts } : { excerpt: text.split("\n").slice(0, 8).join("\n") }),
      ...(files.length > 0 ? { files } : {}),
      ...(decision ? { decision } : {}),
    };
  }
  return { kind: "other", what: kind ?? "a decision" };
}

export async function runsPage(
  runtime: Runtime,
  engine: LocalWorkflowEngine,
  options: { repo?: string; current?: string; homeDir: string; now?: Date },
): Promise<RunsPage> {
  const now = (options.now ?? new Date()).getTime();
  const all = runtime.runs.list({ includeTerminal: true, limit: 500 });
  const repos = reposOf(all, options.current);
  const runs = options.repo ? all.filter((r) => r.workspace.repoRoot === options.repo) : all;
  const waiting: WaitingRun[] = [];
  const running: RunningRun[] = [];
  const recent: RecentRun[] = [];
  for (const run of runs) {
    if (run.state === "WAITING_HUMAN") {
      waiting.push({
        run,
        card: await waitCardOf(runtime, run, options.homeDir),
        terminal: waitingCard(runtime, run.id) !== undefined,
        ...((r) => (r ? { resumable: r } : {}))(resumableOf(runtime, run, now)),
      });
    } else if (run.state === "WAITING_BUDGET") {
      // in progress, only paused: with what runs, not with what ended
      const wait = budgetWaitOf(runtime, run);
      running.push({ run, ...(wait ? { wait } : {}) });
    } else if (run.state === "RUNNING" && live(run, now)) {
      const events = runEvents(runtime, run.id);
      const activity = activityOf(events, new Date(now));
      const plan = workflowOf(engine, run)?.steps.map((s) => s.id) ?? [];
      const at = activity?.step ? plan.indexOf(activity.step.id) : -1;
      running.push({
        run,
        ...(activity ? { activity } : {}),
        ...(at >= 0 ? { position: { index: at + 1, total: plan.length } } : {}),
      });
    } else if (recent.length < 25) {
      recent.push({
        run,
        modelCalls: runtime.events.list({ runId: run.id, kind: "model.call", limit: 1_000_000 }).length,
        tookMs: Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt)),
      });
    }
  }
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const since = midnight.toISOString();
  const ids = new Set(runs.map((r) => r.id));
  return {
    repos,
    ...(options.repo ? { repo: options.repo } : {}),
    waiting: waiting.sort((a, b) => a.run.updatedAt.localeCompare(b.run.updatedAt)),
    candidates: candidatesOf(runtime, (r) => r.workflow === "onboard-module" && ids.has(r.id))
      .filter((c) => !c.decision && c.doc.module)
      .map((c) => ({
        module: c.doc.module as string,
        run: shortRunId(c.artifact.runId),
        at: c.artifact.createdAt,
        ...(c.claims ? { claims: { proposed: c.claims.proposed, kept: c.claims.kept } } : {}),
        review: c.review.length,
      })),
    running,
    recent,
    today: {
      runs: runs.filter((r) => r.createdAt >= since).length,
      modelCalls: runtime.events
        .list({ kind: "model.call", since, limit: 1_000_000 })
        .filter((e) => e.runId && ids.has(e.runId)).length,
    },
  };
}

/* ---- one run ---- */

export interface StepRow {
  readonly id: string;
  /** A child of a composite step (verify's tests, standards…). */
  readonly child: boolean;
  readonly status: "done" | "failed" | "skipped" | "running" | "waiting" | "pending";
  /** Waiting for a quota window or a model, not for a person. */
  readonly paused?: boolean;
  /** The last finished round of the step. */
  readonly last?: StepReport;
  readonly rounds: number;
  readonly loops: readonly LoopReport[];
  readonly startedAt?: string;
}

export interface FeedItem {
  readonly ts: string;
  readonly text: string;
  readonly tone?: "ok" | "warn" | "bad";
}

export interface RunPage {
  readonly run: Run;
  readonly plan: readonly string[];
  readonly steps: readonly StepRow[];
  readonly tokens: RunTokens;
  readonly workedMs: number;
  readonly activity?: Activity;
  readonly card?: WaitCard;
  readonly terminal: boolean;
  /** Started from the page: it goes on in the background after a decision (src/ui/launcher.ts). */
  readonly driven?: boolean;
  /** Parked on a quota window or a model: what it waits for and until when. */
  readonly wait?: BudgetWait;
  /** Nobody moves it on, and `jarvis resume` would: the page's "Resume" (src/app/resumable.ts). */
  readonly resumable?: Resumable;
  readonly feed: readonly FeedItem[];
  readonly artifacts: ReadonlyArray<ArtifactVersion & { readonly state: string }>;
  readonly leaseLive: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** One line of the activity feed for an event worth a person's attention; undefined for the rest. */
export function feedItem(e: StoredEvent): FeedItem | undefined {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const step = str(p.stepId) ?? e.stepId;
  const who = e.actor?.replace(/^(user|service|ci):/, "");
  const from = (c: unknown) => (c === "ui" ? " from the page" : c === "cli" ? " in the terminal" : "");
  const at = (text: string, tone?: FeedItem["tone"]) => ({ ts: e.ts, text, ...(tone ? { tone } : {}) });
  switch (e.kind) {
    case "run.created":
      return at(`run created${who ? ` by ${who}` : ""}`);
    case "step.finish": {
      const status = str(p.status) ?? "success";
      const label = `${step ?? "?"}${typeof p.iteration === "number" && p.iteration > 1 ? `#${p.iteration}` : ""}`;
      if (status === "skipped") return at(`${label} skipped: ${str(p.reason) ?? "nothing to do"}`);
      const outcome = str(p.outcome);
      if (status !== "success") return at(`${label} ${status}: ${str(p.reason) ?? ""}`.trim(), "bad");
      return outcome && outcome !== "success"
        ? at(`${label} → ${outcome}`, "warn")
        : at(`${label} done`, "ok");
    }
    case "step.error":
      return at(`${step ?? "?"} error: ${str(p.message) ?? str(p.error) ?? ""}`, "bad");
    case "workflow.loop": {
      const edge = /^(.+)->(.+)#(.+)$/.exec(str(p.edge) ?? "");
      const round =
        typeof p.iteration === "number"
          ? `, round ${p.iteration}${typeof p.max === "number" ? `/${p.max}` : ""}`
          : "";
      return at(
        edge ? `↻ ${edge[1]} → ${edge[2]} ${edge[3]}${round}` : `↻ loop ${str(p.edge) ?? ""}${round}`,
        "warn",
      );
    }
    case "run.state": {
      const state = str(p.state) ?? "?";
      const why = str(p.reason);
      if (state === "RUNNING") return at(`running${why ? ` — ${why}` : ""}`);
      if (state === "COMPLETED") return at("✓ completed", "ok");
      if (state === "FAILED") return at(`✗ failed${why ? `: ${why}` : ""}`, "bad");
      return at(`⏸ ${state.toLowerCase().replace("_", " ")}${why ? ` — ${why}` : ""}`, "warn");
    }
    case "approval.recorded": {
      const d = str(p.decision) ?? "decision";
      const verb = d === "approve" ? "✓ accepted" : d === "reject" ? "✗ rejected" : "↻ sent back";
      return at(
        `${verb} ${str(p.type) ?? ""}@${String(p.version ?? "?")}${who ? ` by ${who}` : ""}${from(p.channel)}`,
        d === "approve" ? "ok" : d === "reject" ? "bad" : "warn",
      );
    }
    case "loop.rerun":
      return at(
        `↻ run ${str(p.step) ?? "the step"} again${who ? ` — by ${who}` : ""}${from(p.channel)}`,
        "warn",
      );
    case "card.open":
      return at(`a terminal waits at the ${str(p.kind) === "loop" ? "loop" : "decision"} card`);
    case "workspace.humanEdit": {
      const files = Array.isArray(p.files) ? p.files.length : 0;
      return at(`your edit → checkpoint, ${files} file${files === 1 ? "" : "s"}`, "ok");
    }
    case "workspace.scratchRemoved": {
      const files = Array.isArray(p.files) ? p.files.join(", ") : "";
      return at(`removed scratch files: ${files}`);
    }
    case "run.interrupted":
      return at("⏸ interrupted (Ctrl-C)", "warn");
    case "run.applied":
      return at(`applied${who ? ` by ${who}` : ""}`, "ok");
    case "model.retry":
    case "model.error": {
      const notice = noticeOf(e);
      // the notice carries a wall clock of its own: the feed has one
      return notice
        ? at(
            notice.replace(/^(\S+) \d\d:\d\d:\d\d /, "$1 "),
            e.kind === "model.error" && e.payload?.kind !== "quota_exhausted" ? "bad" : "warn",
          )
        : undefined;
    }
    default:
      return undefined;
  }
}

/** The state of each artifact for the list: awaiting approval, approved, sent back. */
function artifactStates(runtime: Runtime, run: Run): Array<ArtifactVersion & { state: string }> {
  // only what the run waits on now is "awaiting approval"; an older gated document is not
  const awaited = run.state === "WAITING_HUMAN" ? awaitedArtifact(runtime, run)?.artifact : undefined;
  return runtime.artifacts
    .listLatest(run.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((a) => {
      const decided = runtime.artifacts.approvalsFor(a.artifactId, a.version)[0];
      const state = runtime.artifacts.isApproved(a.artifactId).approved
        ? "approved"
        : decided?.decision === "request_changes"
          ? "sent back"
          : decided?.decision === "reject"
            ? "rejected"
            : awaited?.artifactId === a.artifactId && awaited.version === a.version
              ? "awaiting approval"
              : "";
      return { ...a, state };
    });
}

export async function runPage(
  runtime: Runtime,
  engine: LocalWorkflowEngine,
  run: Run,
  options: { homeDir: string; now?: Date },
): Promise<RunPage> {
  const now = options.now ?? new Date();
  const workflow = workflowOf(engine, run);
  const plan = workflow?.steps.map((s) => s.id) ?? [];
  const children = new Set(workflow?.steps.flatMap((s) => s.children) ?? []);
  const events = runEvents(runtime, run.id);
  const journey = new Journey(plan);
  const reports = new Map<string, StepReport[]>();
  const loops = new Map<string, LoopReport[]>();
  const started = new Map<string, string>();
  const finished = new Set<string>();
  for (const e of events) {
    if (e.kind === "step.start") {
      const id = str(e.payload?.stepId) ?? e.stepId;
      if (id) {
        started.set(id, e.ts);
        finished.delete(id);
      }
    }
    for (const line of journey.push(e)) {
      if (line.kind === "step") {
        reports.set(line.report.stepId, [...(reports.get(line.report.stepId) ?? []), line.report]);
        finished.add(line.report.stepId);
      } else loops.set(line.report.from, [...(loops.get(line.report.from) ?? []), line.report]);
    }
  }
  const activity = activityOf(events, now);
  const leaseLive = run.lease !== undefined && Date.parse(run.lease.until) >= now.getTime();
  const row = (id: string): StepRow => {
    const all = reports.get(id) ?? [];
    const last = all.at(-1);
    const inFlight = started.has(id) && !finished.has(id);
    const status: StepRow["status"] =
      run.currentStep === id && (run.state === "WAITING_HUMAN" || run.state === "WAITING_BUDGET")
        ? "waiting"
        : inFlight && run.state === "RUNNING"
          ? "running"
          : !last
            ? "pending"
            : last.status === "skipped"
              ? "skipped"
              : last.status === "success"
                ? "done"
                : "failed";
    const at = started.get(id);
    return {
      id,
      child: children.has(id),
      status,
      ...(last ? { last } : {}),
      ...(run.currentStep === id && run.state === "WAITING_BUDGET" ? { paused: true } : {}),
      rounds: all.filter((r) => r.status !== "skipped").length,
      loops: loops.get(id) ?? [],
      ...(at ? { startedAt: at } : {}),
    };
  };
  // composite children right under their parent, as the terminal shows them side by side
  const order: string[] = [];
  for (const step of workflow?.steps ?? []) {
    if (children.has(step.id)) continue;
    order.push(step.id);
    for (const c of step.children) order.push(c);
  }
  const tokens = events
    .filter((e) => e.kind === "model.call")
    .reduce<RunTokens>(
      (acc, e) => {
        const p = (e.payload ?? {}) as Record<string, number>;
        return {
          calls: acc.calls + 1,
          promptTokens: acc.promptTokens + (p.promptTokens ?? 0),
          cachedTokens: acc.cachedTokens + (p.cachedTokens ?? 0),
          outputTokens: acc.outputTokens + (p.outputTokens ?? 0),
          retries: acc.retries + (p.retries ?? 0),
        };
      },
      { calls: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0, retries: 0 },
    );
  // time in steps, from the journal: a composite's children run inside it, side by side
  const workedMs = [...reports.entries()]
    .filter(([id]) => !children.has(id))
    .flatMap(([, rs]) => rs)
    .reduce((sum, r) => sum + r.durationMs, 0);
  const feed = events.map(feedItem).filter((f): f is FeedItem => f !== undefined);
  return {
    run,
    plan,
    steps: order.map(row),
    tokens,
    workedMs,
    ...(activity && run.state === "RUNNING" ? { activity } : {}),
    ...(run.state === "WAITING_HUMAN" ? { card: await waitCardOf(runtime, run, options.homeDir) } : {}),
    terminal: waitingCard(runtime, run.id) !== undefined,
    feed: feed.slice(-15),
    artifacts: artifactStates(runtime, run),
    leaseLive,
    ...(() => {
      const wait = budgetWaitOf(runtime, run);
      return wait ? { wait } : {};
    })(),
    ...((r) => (r ? { resumable: r } : {}))(resumableOf(runtime, run, now.getTime())),
  };
}

/* ---- one artifact ---- */

export interface ArtifactPage {
  readonly run: Run;
  readonly artifact: ArtifactVersion;
  readonly versions: readonly number[];
  readonly text: string;
  readonly facts?: DocFacts;
  readonly state: string;
  readonly decision?: Decision;
  /** This version is what the run waits on now and is not decided yet: it can be decided here. */
  readonly awaited: boolean;
  /** The run still stands at this version's gate (decided or not): it goes on with `jarvis continue`. */
  readonly atGate: boolean;
  readonly terminal: boolean;
  readonly driven?: boolean;
  readonly resumable?: Resumable;
}

export function artifactPage(
  runtime: Runtime,
  run: Run,
  type: string,
  name: string,
  version?: number,
): ArtifactPage | undefined {
  const latest = runtime.artifacts.listLatest(run.id, type).find((a) => a.name === name);
  if (!latest) return undefined;
  const artifact =
    version !== undefined && version !== latest.version
      ? runtime.artifacts.get(latest.artifactId, version)
      : latest;
  if (!artifact) return undefined;
  const text = runtime.artifacts.text(artifact);
  const facts = docFacts(artifact.name, text);
  const decision = decisionOn(runtime, artifact);
  const awaited = awaitedArtifact(runtime, run);
  const isAwaited =
    run.state === "WAITING_HUMAN" &&
    awaited?.artifact.artifactId === artifact.artifactId &&
    awaited.artifact.version === artifact.version;
  const state = decision
    ? decision.approval.decision === "approve"
      ? "accepted"
      : decision.approval.decision === "reject"
        ? "rejected"
        : "sent back"
    : isAwaited
      ? "awaiting your approval"
      : "";
  return {
    run,
    artifact,
    versions: Array.from({ length: latest.version }, (_v, i) => i + 1),
    text,
    ...(facts ? { facts } : {}),
    state,
    ...(decision ? { decision } : {}),
    awaited: isAwaited && !decision,
    atGate: isAwaited,
    terminal: waitingCard(runtime, run.id) !== undefined,
    ...((r) => (r ? { resumable: r } : {}))(resumableOf(runtime, run)),
  };
}

export { shortRunId };

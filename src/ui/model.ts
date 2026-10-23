import { existsSync } from "node:fs";
import { basename } from "node:path";
import { type Activity, activityOf, compactingText, noticeOf } from "../app/activity.ts";
import { arbiterRole } from "../app/arbiter.ts";
import { AUTONOMY_DECIDED } from "../app/autonomy.ts";
import { type BudgetGrant, type BudgetStop, budgetGranted, budgetStopOf } from "../app/budgetStop.ts";
import { type BudgetWait, budgetWaitOf } from "../app/budgetWait.ts";
import { candidatesOf } from "../app/candidates.ts";
import { type Continuation, continuationOf, continuedFromOf, contradictionsOf } from "../app/continuation.ts";
import {
  type ContractChangeRequest,
  libraryAwaited,
  pendingContractRequests,
} from "../app/contractChange.ts";
import type { DtoCheck } from "../app/contractFields.ts";
import { crossContinuationOf, type ScopeReport, scopeOf } from "../app/crossScope.ts";
import {
  awaitedArtifact,
  type Decision,
  decisionOn,
  goOnRequested,
  rerunRequested,
  waitingCard,
} from "../app/decide.ts";
import { prOf } from "../app/deliver.ts";
import { unresolvedEffectOf } from "../app/effects.ts";
import { finalizedOf } from "../app/finalize.ts";
import { continuedBy } from "../app/handoff.ts";
import { Journey, type LoopReport, type StepReport } from "../app/journey.ts";
import { type MasterBudget, masterBudgetOf } from "../app/masterBudget.ts";
import { pauseRequested } from "../app/pause.ts";
import { type PlanProgress, planProgressOf } from "../app/planProgress.ts";
import { followsPr, prReviewOf } from "../app/prReview.ts";
import { triageOf } from "../app/prTriage.ts";
import { redoableInPlace, redoTargets } from "../app/redo.ts";
import { type RestartPlan, restartPlanOf } from "../app/restart.ts";
import { type Resumable, resumableOf } from "../app/resumable.ts";
import { type RoundFailure, roundsOf, type StopWhy } from "../app/rounds.ts";
import type { Runtime } from "../app/runtime.ts";
import { type StallSignals, stallSignalsOf } from "../app/stall.ts";
import type { RunTokens } from "../app/status.ts";
import { checksAskOf, pauseAfterRequested } from "../app/steer.ts";
import {
  type ContractItem,
  MASTER_WORKFLOW,
  masterOf,
  type SubtaskView,
  splitOf,
  subtasksOf,
} from "../app/subtasks.ts";
import { type KindChoice, kindOfTask } from "../app/taskKind.ts";
import { type TimeSplit, timeSplitOf } from "../app/timeSplit.ts";
import { type TryOut, tryOutOf } from "../app/tryOut.ts";
import { editableFile, isEditable } from "../artifacts/editable.ts";
import { type Change, changesIn, homePath } from "../cli/checkout.ts";
import { changedFilesOf, type DocFacts, docFacts, reasonsOf } from "../cli/gate.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import { isTerminal, type Run } from "../core/domain/run.ts";
import type { WorkflowDefinition } from "../core/domain/workflow.ts";
import {
  type CandidateReason,
  candidateReasons,
  type EvalCandidate,
  evalCandidates,
  isDismissed,
} from "../evals/candidates.ts";
import { caseOfRun, casesRootOf } from "../evals/runToCase.ts";
import { type ScheduledEvalOutcome, scheduledEvalNotices } from "../evals/schedule.ts";
import {
  type GivenAnswer,
  givenFor,
  openQuestionDetailsOf,
  openQuestionsOf,
  type SuggestionsDoc,
  suggestionsFor,
} from "../interaction/answers.ts";
import {
  type ClarificationResolution,
  type EarlierRule,
  earlierRulesFor,
  latestProposal,
} from "../interaction/clarify.ts";
import { conflictFilesOf } from "../interaction/conflict.ts";
import { notesOf, type RunNote } from "../interaction/notes.ts";
import type { QuestionDetail } from "../interaction/questions.ts";
import type { Interaction, InteractionMessage } from "../interaction/store.ts";
import type { NamedService } from "../knowledge/catalog.ts";
import type { LocalWorkflowEngine } from "../orchestration/runtime.ts";
import {
  EFFECT_HELD,
  UNTRUSTED_CONTENT,
  type UntrustedSource,
  untrustedSince,
} from "../security/policy/untrusted.ts";
import { shortRunId } from "../storage/runStore.ts";
import type { StoredEvent } from "../telemetry/events.ts";
import { plural, t, units } from "./i18n.ts";

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
  /** «Go on without it» asked since the run stopped. */
  readonly goOn?: ReturnType<typeof goOnRequested>;
  /** The step's checks failed: the rounds, this round's failures, the whole output (src/app/rounds.ts). */
  readonly tests?: TestsStop;
}

/** Why failed checks stopped the run, and what the person needs to decide. */
export interface TestsStop {
  /** `rounds-used-up`: the back edge has no rounds left. */
  readonly why: StopWhy | "rounds-used-up";
  readonly round: number;
  /** How many rounds the step gets by itself: the first and the back edge's. */
  readonly rounds: number;
  readonly history: ReadonlyArray<{
    readonly round: number;
    readonly failed: number;
    readonly notStarted: boolean;
    /** Failed exactly as the round before. */
    readonly same: boolean;
  }>;
  readonly failures: readonly RoundFailure[];
  /** Failures of this round already failing in the round before. */
  readonly repeated: readonly string[];
  readonly notStarted: readonly string[];
  /** The checks document of the round, and each failed check's whole output. */
  readonly checksHref: string;
  readonly logs: ReadonlyArray<{ readonly check: string; readonly href: string; readonly command?: string }>;
  /** What the implementation said at the end of its last round. */
  readonly said?: string;
}

/** The checks of the round a loop stopped at, when they failed. */
function testsStopOf(
  runtime: Runtime,
  run: Run,
  doc: Record<string, unknown> | undefined,
  max: number | undefined,
): TestsStop | undefined {
  const rounds = roundsOf(runtime, run.id);
  const round =
    typeof doc?.round === "number" ? doc.round : (run.currentIteration ?? rounds.at(-1)?.round ?? 0);
  const now = rounds.find((r) => r.round === round);
  if (!now || (now.failures.length === 0 && now.notStarted.length === 0)) return undefined;
  const why =
    doc?.why === "same-failure" || doc?.why === "not-started" || doc?.why === "every-failure"
      ? doc.why
      : "rounds-used-up";
  const history = rounds
    .filter((r) => r.round <= round)
    .map((r, i, all) => {
      const before = all[i - 1];
      const was = new Set(before?.failures.map((f) => f.signature) ?? []);
      const same =
        before !== undefined &&
        r.failures.length > 0 &&
        r.failures.length === was.size &&
        r.failures.every((f) => was.has(f.signature));
      return { round: r.round, failed: r.failures.length, notStarted: r.notStarted.length > 0, same };
    });
  const before = [...rounds].reverse().find((r) => r.round < round);
  const was = new Set(before?.failures.map((f) => f.signature) ?? []);
  const short = shortRunId(run.id);
  let results: Array<{ check?: unknown; log?: unknown; command?: unknown; ok?: unknown }> = [];
  try {
    const parsed = JSON.parse(runtime.artifacts.text(now.checks)) as { results?: typeof results };
    results = Array.isArray(parsed.results) ? parsed.results : [];
  } catch {
    results = [];
  }
  const logs = results.flatMap((r) => {
    const v = typeof r.log === "string" ? Number(r.log.split("@")[1]) : Number.NaN;
    if (r.ok !== false || typeof r.check !== "string" || !Number.isFinite(v)) return [];
    const name = `${r.check.replace(/[^\w.-]+/g, "-")}.log`;
    return [
      {
        check: r.check,
        href: `/runs/${short}/artifacts/check-log/${encodeURIComponent(name)}?v=${v}`,
        ...(typeof r.command === "string" ? { command: r.command } : {}),
      },
    ];
  });
  const impl = runtime.artifacts.listLatest(run.id, "implementation")[0];
  let said: string | undefined;
  try {
    const d = impl
      ? (JSON.parse(runtime.artifacts.text(impl)) as { summary?: unknown; notes?: unknown })
      : {};
    const notes = Array.isArray(d.notes) ? d.notes.filter((n): n is string => typeof n === "string") : [];
    said =
      [typeof d.summary === "string" ? d.summary : "", ...notes.slice(0, 2)].filter(Boolean).join(" ") ||
      undefined;
  } catch {
    said = undefined;
  }
  return {
    why,
    round,
    rounds: (max ?? 2) + 1,
    history,
    failures: now.failures.slice(0, 8),
    repeated: now.failures.filter((f) => was.has(f.signature)).map((f) => f.signature),
    notStarted: now.notStarted,
    checksHref: `/runs/${short}/artifacts/checks/checks.json?v=${now.checks.version}`,
    logs,
    ...(said ? { said: said.slice(0, 600) } : {}),
  };
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
  /** The implementation gate: one line into the checkout and to start the project (src/app/tryOut.ts). */
  readonly tryOut?: TryOut;
}

/** A stop on a budget (src/app/budgetStop.ts): more and go on, or finish the step with what it has. */
export interface BudgetCard {
  readonly kind: "budget";
  readonly stop: BudgetStop;
  readonly changes?: readonly Change[];
  /** Decided since the run stopped (the page, the terminal's card): it goes on, or waits for `continue`. */
  readonly granted?: BudgetGrant;
  /** What the step's journal shows: more work than the limit, or going round (src/app/stall.ts). */
  readonly signals?: StallSignals;
}

export interface OtherCard {
  readonly kind: "other";
  readonly what: string;
}

/** ADR-0002 §2: an external change whose outcome nobody can tell — did it happen? (src/app/effects.ts) */
export interface EffectCard {
  readonly kind: "effect";
  readonly capability: string;
  readonly step: string;
  readonly startedAt: string;
  readonly marker: string;
  /** What it was asked, as JSON, cut for the page. */
  readonly asked: string;
}

/** ADR-0025 §7: an sdd whose impact reaches other services — on as a task across services, or here only. */
export interface ScopeCard {
  readonly kind: "scope";
  readonly report: ScopeReport;
}

/** ADR-0025 §6: a subtask asks its master to change the contract — a person decides on the master. */
export interface ContractCard {
  readonly kind: "contract";
  readonly master: Run;
  readonly request?: ContractChangeRequest;
  /** Accepted as a library's change: the library subtask this run waits for. */
  readonly library?: { readonly key: string; readonly service: string };
}

/**
 * A clarification thread (ADR-0019 §4) answered on the page: the agent's question, the turns so far,
 * Jarvis's proposed rule. Pilot: the run stood at «Answer in the terminal» and the page's flow broke.
 */
export interface ClarifyCard {
  readonly kind: "clarify";
  readonly thread: Interaction;
  readonly messages: readonly InteractionMessage[];
  readonly proposal?: ClarificationResolution;
  /** The person answered last: Jarvis is writing its turn. */
  readonly thinking: boolean;
  /** The thread's turns are used up (human.clarification.maxTurns): accept or write the rule. */
  readonly exhausted: boolean;
  /** Rules settled in other runs of the same task: one click instead of the conversation again. */
  readonly earlier: readonly EarlierRule[];
}

/**
 * A hand edit of files the step had changed (ADR-0019 §6.3): which files, and the three ways out.
 * `resolved` — decided (the page, `jarvis answer`), the run goes on with it or waits for `continue`.
 */
export interface ConflictCard {
  readonly kind: "conflict";
  readonly thread: Interaction;
  readonly step: string;
  readonly files: readonly string[];
  readonly checkout: string;
  readonly checkoutShown: string;
  readonly resolved?: { readonly choice: string; readonly by?: string };
}

export type WaitCard =
  | LoopCard
  | ApprovalCard
  | BudgetCard
  | ClarifyCard
  | ScopeCard
  | ContractCard
  | EffectCard
  | ConflictCard
  | OtherCard;

/** The conflict a run waits on, as the page shows it. */
export function conflictCardOf(runtime: Runtime, run: Run, homeDir: string): ConflictCard | undefined {
  const id = run.waitingFor?.interactionId;
  const thread = id ? runtime.interactions.get(id) : runtime.interactions.openFor(run.id, "conflict");
  if (thread?.kind !== "conflict") return undefined;
  const choice = runtime.interactions.messages(thread.id).findLast((m) => m.role === "human")?.text;
  return {
    kind: "conflict",
    thread,
    step: thread.stepId,
    files: conflictFilesOf(thread),
    checkout: run.workspace.path,
    checkoutShown: homePath(run.workspace.path, homeDir),
    ...(thread.state === "resolved"
      ? { resolved: { choice: choice ?? "", ...(thread.resolvedBy ? { by: thread.resolvedBy } : {}) } }
      : {}),
  };
}

/** The open clarification thread of a run, as the page shows it. */
export function clarifyCardOf(runtime: Runtime, run: Run): ClarifyCard | undefined {
  const thread = runtime.interactions.openFor(run.id, "clarification");
  if (!thread || thread.state === "resolved" || thread.state === "rejected") return undefined;
  const messages = runtime.interactions.messages(thread.id);
  const proposal = latestProposal(runtime, thread);
  const last = messages.at(-1);
  const config = runtime.loaded.config.human.clarification;
  const turns = runtime.interactions.humanTurns(thread.id);
  const exhausted = turns > config.maxTurns || (!config.multiTurn && turns > 1);
  return {
    kind: "clarify",
    thread,
    messages,
    ...(proposal ? { proposal } : {}),
    thinking: last?.role === "human" && !exhausted,
    exhausted,
    earlier: earlierRulesFor(runtime, run),
  };
}

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
  /** Stopped, not ended: a master waiting for its subtasks, a pause, Ctrl-C — Resume goes on. */
  readonly suspended?: true;
  readonly activity?: Activity;
  readonly position?: { readonly index: number; readonly total: number };
  /** An implementation's place in its plan (src/app/planProgress.ts). */
  readonly planProgress?: PlanProgress;
  /** A round on a back edge: what it fixes, instead of the plan. */
  readonly fixing?: FixView;
}

export interface RecentRun {
  readonly run: Run;
  /** Done, with a PR: where its review stands. */
  readonly pr?: RunPr;
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

/** The finished runs as a list to search and page through (Runs → Recent). */
export interface RecentList {
  readonly runs: readonly RecentRun[];
  /** What was asked: free text, every word in some field of a run (id, task, workflow, state, …). */
  readonly query: string;
  readonly terms: readonly string[];
  readonly page: number;
  readonly pageSize: number;
  /** Runs that match the query, all pages. */
  readonly total: number;
}

/** Rows of Recent a page can show; the first is the default. */
export const RECENT_SIZES = [10, 15, 20, 30] as const;
export const RECENT_PAGE: number = RECENT_SIZES[0];

/** `foo "two words" bar` → its terms, lower case; a quoted phrase is one term. */
export function termsOf(query: string): string[] {
  return [...query.matchAll(/"([^"]+)"|(\S+)/g)]
    .map((m) => (m[1] ?? m[2] ?? "").trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/** Every field of a run a person might remember it by, as one text to search. */
export function searchTextOf(run: Run, homeDir: string): string {
  const created = new Date(run.createdAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    run.id,
    shortRunId(run.id),
    run.task,
    run.workflow,
    run.state,
    run.stateReason ?? "",
    run.owner.id,
    run.workspace.repoRoot,
    homeDir && run.workspace.repoRoot.startsWith(homeDir)
      ? `~${run.workspace.repoRoot.slice(homeDir.length)}`
      : "",
    run.workspace.branch ?? "",
    run.profile ?? "",
    run.currentStep ?? "",
    run.createdAt.slice(0, 10),
    `${pad(created.getDate())}.${pad(created.getMonth() + 1)}.${created.getFullYear()}`,
  ]
    .join("\n")
    .toLowerCase();
}

export interface RunsPage {
  readonly repos: readonly Repo[];
  /** The repository shown, or undefined for all. */
  readonly repo?: string;
  readonly waiting: readonly WaitingRun[];
  /** Module research waiting for a review: a person decides, as for a run. */
  readonly candidates: readonly WaitingCandidate[];
  readonly running: readonly RunningRun[];
  readonly recent: RecentList;
  readonly today: { readonly runs: number; readonly modelCalls: number };
  /** Finished runs worth keeping as eval cases (src/evals/candidates.ts), of the repository shown. */
  readonly evalCandidates: readonly EvalCandidate[];
  /** Scheduled eval suites whose last run regressed or failed (src/evals/schedule.ts). */
  readonly evalNotices: readonly ScheduledEvalOutcome[];
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
    const goOn = goOnRequested(runtime, run.id);
    const tests = testsStopOf(
      runtime,
      run,
      doc,
      typeof doc?.maxIterations === "number" ? doc.maxIterations : undefined,
    );
    return {
      kind: "loop",
      ...(goOn ? { goOn } : {}),
      ...(tests ? { tests } : {}),
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
      const signals = stallSignalsOf(runtime, run.id, stop.stepId, stop.iteration);
      return {
        kind: "budget",
        stop,
        ...(changes ? { changes } : {}),
        ...(granted ? { granted } : {}),
        ...(signals.calls > 0 ? { signals } : {}),
      };
    }
  }
  if (kind === "clarification") {
    const card = clarifyCardOf(runtime, run);
    if (card) return card;
  }
  if (kind === "scope") {
    const report = scopeOf(runtime, run);
    if (report) return { kind: "scope", report };
  }
  if (kind === "contract") {
    const master = masterOf(runtime, run)?.master;
    if (master) {
      const request = pendingContractRequests(runtime, master).find((r) => r.run === run.id);
      const library = request ? undefined : libraryAwaited(runtime, master, run);
      return { kind: "contract", master, ...(request ? { request } : {}), ...(library ? { library } : {}) };
    }
  }
  if (kind === "effect") {
    const open = unresolvedEffectOf(runtime, run);
    if (open) {
      const asked = JSON.stringify(open.args ?? null);
      return {
        kind: "effect",
        capability: open.record.capability,
        step: open.record.stepId,
        startedAt: open.record.createdAt,
        marker: open.marker,
        asked: asked.length > 600 ? `${asked.slice(0, 599)}…` : asked,
      };
    }
  }
  if (kind === "conflict") {
    const card = conflictCardOf(runtime, run, homeDir);
    if (card) return card;
  }
  const awaited = kind === "approval" || !kind ? awaitedArtifact(runtime, run) : undefined;
  if (awaited) {
    const text = runtime.artifacts.text(awaited.artifact);
    const facts = docFacts(awaited.artifact.name, text);
    const files = awaited.type === "implementation" ? await changedFilesOf(run).catch(() => []) : [];
    const decision = decisionOn(runtime, awaited.artifact);
    const tryOut =
      awaited.type === "implementation"
        ? tryOutOf(runtime, run, { homeDir, changed: files.map((f) => f.path) })
        : undefined;
    return {
      kind: "approval",
      type: awaited.type,
      artifact: awaited.artifact,
      ...(facts ? { facts } : { excerpt: text.split("\n").slice(0, 8).join("\n") }),
      ...(files.length > 0 ? { files } : {}),
      ...(decision ? { decision } : {}),
      ...(tryOut ? { tryOut } : {}),
    };
  }
  return { kind: "other", what: kind ?? "a decision" };
}

export async function runsPage(
  runtime: Runtime,
  engine: LocalWorkflowEngine,
  options: {
    repo?: string;
    current?: string;
    homeDir: string;
    now?: Date;
    q?: string;
    page?: number;
    size?: number;
  },
): Promise<RunsPage> {
  const now = (options.now ?? new Date()).getTime();
  // every run: Recent pages through all of them and searches all of them
  const all = runtime.runs.list({ includeTerminal: true, limit: 1_000_000 });
  const repos = reposOf(all, options.current);
  const runs = options.repo ? all.filter((r) => r.workspace.repoRoot === options.repo) : all;
  const waiting: WaitingRun[] = [];
  const running: RunningRun[] = [];
  const finished: Run[] = [];
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
    } else if (run.state === "SUSPENDED") {
      // stopped, not ended: with what is in progress, not with what ended
      running.push({ run, suspended: true });
    } else if (run.state === "RUNNING" && live(run, now)) {
      const events = runEvents(runtime, run.id);
      const activity = activityOf(events, new Date(now));
      const plan = workflowOf(engine, run)?.steps.map((s) => s.id) ?? [];
      const at = activity?.step ? plan.indexOf(activity.step.id) : -1;
      const fixing = fixingOf(runtime, events, activity);
      const progress = implementing(activity) && !fixing ? planProgressOf(runtime, run, events) : undefined;
      running.push({
        run,
        ...(activity ? { activity } : {}),
        ...(fixing ? { fixing } : {}),
        ...(at >= 0 ? { position: { index: at + 1, total: plan.length } } : {}),
        ...(progress ? { planProgress: progress } : {}),
      });
    } else finished.push(run);
  }
  const query = (options.q ?? "").trim();
  const terms = termsOf(query);
  const matching =
    terms.length === 0
      ? finished
      : finished.filter((run) => {
          const text = searchTextOf(run, options.homeDir);
          return terms.every((t) => text.includes(t));
        });
  const size = (RECENT_SIZES as readonly number[]).includes(options.size ?? 0)
    ? (options.size as number)
    : RECENT_PAGE;
  const pages = Math.max(1, Math.ceil(matching.length / size));
  const pageNo = Math.min(Math.max(1, Math.floor(options.page ?? 1)), pages);
  const recent: RecentList = {
    // the model calls of the rows shown only: counting them is a query per run
    runs: matching.slice((pageNo - 1) * size, pageNo * size).map((run) => ({
      run,
      ...((p) => (p ? { pr: p } : {}))(run.state === "COMPLETED" ? runPrOf(runtime, run) : undefined),
      modelCalls: runtime.events.count({ runId: run.id, kind: "model.call" }),
      tookMs: Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt)),
    })),
    query,
    terms,
    page: pageNo,
    pageSize: size,
    total: matching.length,
  };
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
    evalCandidates: evalCandidates(runtime).filter((c) => ids.has(c.runId)),
    evalNotices: scheduledEvalNotices(runtime),
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
  /**
   * `returned` — its last round sent the work back (a gate's Send back, a review's defects): done, but
   * not a pass; `stopped` — started and not finished, the run no longer working (Ctrl-C, a pause, a cancel).
   */
  readonly status: "done" | "returned" | "failed" | "skipped" | "running" | "waiting" | "stopped" | "pending";
  /** Waiting for a quota window or a model, not for a person. */
  readonly paused?: boolean;
  /** A task across services parked for its subtasks: they work, not a person's turn. */
  readonly forChildren?: boolean;
  /** The last finished round of the step. */
  readonly last?: StepReport;
  readonly rounds: number;
  readonly loops: readonly LoopReport[];
  readonly startedAt?: string;
  /** Done in the run this one went on from (`jarvis continue`): its report, not this run's. */
  readonly carriedFrom?: { readonly id: string; readonly workflow: string };
  /** The skills its agent got last time and why (event `context.skills`, src/agents/knowledge.ts). */
  readonly skills?: StepSkills;
}

export interface StepSkills {
  /** `skill:id@v`, in the order the agent got them. */
  readonly refs: readonly string[];
  /** `step` — named by the workflow step; `picked` — by kind, stacks, paths and agent. */
  readonly how: "step" | "picked";
  readonly kind?: string;
  readonly stacks: readonly string[];
  /** Skill ids the step names that the project has not. */
  readonly missing: readonly string[];
}

function skillsOf(e: StoredEvent): StepSkills {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    refs: list(p.skills),
    how: p.how === "step" ? "step" : "picked",
    ...(typeof p.kind === "string" ? { kind: p.kind } : {}),
    stacks: list(p.stacks),
    missing: list(p.missing),
  };
}

export interface FeedItem {
  readonly ts: string;
  readonly text: string;
  readonly tone?: "ok" | "warn" | "bad";
  /** The calls of a batch under its line. */
  readonly sub?: ReadonlyArray<{ readonly text: string; readonly tone?: "bad" }>;
}

/** `read src/a.ts`: a call of a batch, with what it was asked. */
function callLine(capability: string, args: unknown): string {
  let detail = "";
  if (typeof args === "string")
    try {
      const a = JSON.parse(args) as Record<string, unknown>;
      const v = a.path ?? a.pattern ?? a.query ?? a.ref ?? a.key ?? a.id ?? a.url;
      if (typeof v === "string" || typeof v === "number") detail = String(v);
    } catch {
      // not JSON: the capability alone
    }
  return `${capability.replace(/^repo\./, "")}${detail ? ` ${detail}` : ""}`;
}

const quickMs = (ms: number) => (ms < 100 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

/**
 * The feed of a run: its events as lines, and every batch of tools an agent asked for in one answer as
 * one line with its calls under it, how long each took, and the batch from start to its last end.
 */
export function feedOf(events: readonly StoredEvent[]): FeedItem[] {
  const out: FeedItem[] = [];
  const open = new Map<
    string,
    {
      at: number;
      start: number;
      size: number;
      parallel: boolean;
      modelCall: number;
      sub: Array<{ text: string; tone?: "bad"; end?: number }>;
    }
  >();
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const key = `${e.stepId ?? ""}#${e.iteration ?? 1}#${String(p.modelCall ?? p.batch)}`;
    if (e.kind === "tool.batch" && Array.isArray(p.calls)) {
      open.set(key, {
        at: out.length,
        start: Date.parse(e.ts),
        size: Number(p.size) || p.calls.length,
        parallel: p.parallel === true,
        modelCall: Number(p.modelCall) || 0,
        sub: (p.calls as Array<Record<string, unknown>>).map((c) => ({
          text: callLine(String(c.capability ?? "?"), c.args),
        })),
      });
      out.push({ ts: e.ts, text: "" });
      continue;
    }
    if (e.kind === "tool.call" && typeof p.batch === "number") {
      const b = open.get(key);
      const line = b?.sub[Number(p.slot) || 0];
      if (b && line) {
        line.text = `${line.text} · ${quickMs(Number(p.durationMs) || 0)}${p.ok === false ? " ✗" : ""}`;
        if (p.ok === false) line.tone = "bad";
        line.end = Date.parse(e.ts);
      }
      continue;
    }
    const item = feedItem(e);
    if (item) out.push(item);
  }
  for (const b of open.values()) {
    const ends = b.sub.map((s) => s.end ?? b.start);
    const span = Math.max(0, Math.max(...ends) - b.start);
    const head = b.parallel
      ? t("⇉ {n} tools in parallel", { n: b.size })
      : t("{n} tools in a row", { n: b.size });
    out[b.at] = {
      ts: (out[b.at] as FeedItem).ts,
      // a call still out: the batch runs, its length is not known yet
      text: `${t("model call {n}", { n: b.modelCall })} · ${head} · ${b.sub.some((x) => x.end === undefined) ? t("running") : units(quickMs(span))}`,
      sub: b.sub.map((s) => ({ text: s.text, ...(s.tone ? { tone: s.tone } : {}) })),
    };
  }
  return out;
}

export interface RunPage {
  readonly run: Run;
  /** An autonomous run whose budget judge runs on the worker's model (no roles.arbiter). */
  readonly arbiterShared?: boolean;
  /** The kind of task the skills were picked by, and what decided it (src/app/taskKind.ts). */
  readonly kind: KindChoice;
  readonly plan: readonly string[];
  readonly steps: readonly StepRow[];
  readonly tokens: RunTokens;
  readonly workedMs: number;
  /** Where the run's time went: working, waiting for a person, on budget and the model, stopped. */
  readonly time?: TimeSplit;
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
  /** An implementation's place in its plan, while it runs. */
  readonly planProgress?: PlanProgress;
  /** A person's notes to the run while it works (src/interaction/notes.ts). */
  readonly notes?: readonly RunNote[];
  /** Steering of this run (src/app/steer.ts): «ask me when tests fail», «stop after this step». */
  readonly steer?: {
    readonly askOnFailure: boolean;
    /** The project's own setting, said next to the switch. */
    readonly projectAsk: string;
    readonly stopAfter?: { readonly step: string; readonly iteration: number; readonly by?: string };
  };
  /** The step runs again on a back edge: what it fixes (the reasons of the steps that sent it back). */
  readonly fixing?: FixView;
  /** Pause asked, the process has not stopped yet (src/app/pause.ts). */
  readonly pausing?: { readonly by?: string };
  /** A finished run whose implementation was accepted: «Make an eval case» (src/evals/runToCase.ts). */
  readonly evalReady?: boolean;
  /**
   * Why it is worth a case (src/evals/candidates.ts): sent back, a back edge, a person's edit; none — it
   * went straight through. Not said once a person dismissed it.
   */
  readonly evalWhy?: readonly CandidateReason[];
  /** The eval case it became. */
  readonly evalCase?: { readonly dir: string; readonly suite: string };
  /** A finished research/spec that can go on (src/app/continuation.ts): "Continue to sdd". */
  readonly next?: Continuation & { readonly contradictions: number };
  /** A finished research/spec of a service naming linked services: «Continue to sdd (cross-repos)» (ADR-0025 §7). */
  readonly nextCross?: readonly NamedService[];
  /** A run that waits, is paused or failed: the steps it can go back to with a note (src/app/redo.ts). */
  readonly redo?: { readonly targets: readonly string[]; readonly current?: string };
  /** A cancelled or failed run: the steps it can start again from (src/app/restart.ts). */
  readonly restart?: RestartPlan & { readonly restartedAs?: RunLink };
  /** The run that went on from this one. */
  readonly continuedBy?: RunLink;
  /** The run this one went on from. */
  readonly continuedFrom?: RunLink & { readonly contradictions: number };
  /** A subtask of a task across services (ADR-0025 §6): its master and its place. */
  readonly subtaskOf?: {
    readonly master: Run;
    readonly key: string;
    readonly service?: string;
    readonly of: number;
  };
  /** A master: its subtasks, and the contract checked in their checkouts. */
  readonly subtasks?: readonly SubtaskView[];
  readonly contractCheck?: ContractCheckView;
  /** A master: the contract changes its subtasks ask for, waiting for a person. */
  readonly contractRequests?: readonly ContractChangeRequest[];
  /** A master: the contract as its split has it now. */
  readonly contractItems?: readonly ContractItem[];
  /** A master: its budget, the sum of its subtasks'. */
  readonly masterBudget?: MasterBudget;
  /** A master: what the task spent, its own steps and each subtask's run (src/ui/pages.ts familyHtml). */
  readonly family?: FamilySpend;
  /** A master: what each started subtask does now, by its key. */
  readonly subtaskNow?: Readonly<Record<string, SubtaskNow>>;
  /** A master: the PR of each subtask that has one, by its key — its review is followed on the subtask's run. */
  readonly subtaskPr?: Readonly<Record<string, RunPr>>;
  /** A done run with a PR: where its review stands — the head says it instead of a bare COMPLETED. */
  readonly pr?: RunPr;
  /** Untrusted content from the internet with no approval since (ADR-0016 §4): effects are held. */
  readonly untrusted?: UntrustedView;
}

/** One side of a contract item as the check found it (src/orchestration/tools/cross.ts). */
export interface ContractSideView {
  readonly service: string;
  readonly status: string;
  readonly at?: string;
  readonly note?: string;
  readonly fields?: readonly DtoCheck[];
}

/** The master's contract check (src/orchestration/tools/cross.ts), as the page shows it. */
export interface ContractCheckView {
  readonly ok: boolean;
  readonly items: ReadonlyArray<{
    readonly kind: string;
    readonly id: string;
    readonly change: string;
    readonly producerSide: ContractSideView;
    readonly consumerSides: readonly ContractSideView[];
  }>;
}

/** What one run spent: model calls and tokens, time working. */
export interface Spend {
  readonly calls: number;
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly cachedEstimated?: boolean;
  readonly outputTokens: number;
  readonly workingMs: number;
}

/** A task across services: the master's own steps, each subtask's run, and the sum. */
export interface FamilySpend {
  readonly total: Spend;
  readonly parts: ReadonlyArray<{
    readonly label: string;
    readonly run?: Run;
    readonly state?: string;
    readonly spend: Spend;
  }>;
}

/** What a started subtask does now, for the master's list. */
export interface SubtaskNow {
  /** The pill: the step it works on, or what it waits for. */
  readonly pill: string;
  readonly tone: "info" | "wait" | "plain";
  /** One line under it: the agent's calls, its tools, its wait. */
  readonly detail?: string;
}

/** Where a subtask's PR stands, from the subtask run's last read of it (src/app/prReview.ts). */
export interface RunPr {
  readonly run: Run;
  readonly id?: string;
  readonly url?: string;
  /** merged: merged on the server, or the task finalized; read: never read yet. */
  readonly phase: "unread" | "review" | "comments" | "replies" | "ready" | "merged" | "declined";
  readonly approvals: number;
  readonly need: number;
  /** Open threads of reviewers (not Jarvis's own). */
  readonly threads: number;
  /** Answers or fixes Jarvis proposes for its comments, waiting for a person. */
  readonly waiting: number;
  readonly build?: "ok" | "failed" | "running";
  readonly blockers: readonly string[];
  readonly following: boolean;
  /** The task was finalized (with or without the merge): the flow is over. */
  readonly finalized?: true;
}

export function runPrOf(runtime: Runtime, run: Run): RunPr | undefined {
  const pr = prOf(runtime, run);
  if (!pr) return undefined;
  const review = prReviewOf(runtime, run);
  const need = runtime.loaded.config.delivery.flow.ready.approvals;
  const threads = review ? review.threads.filter((x) => !x.mine).length : 0;
  const waiting = triageOf(runtime, run).items.filter((i) => i.state === "proposed").length;
  const b = review?.build;
  const build = b ? (b.failed > 0 ? "failed" : b.inProgress > 0 ? "running" : "ok") : undefined;
  const finalized = finalizedOf(runtime, run) !== undefined;
  const phase: RunPr["phase"] =
    finalized || review?.state === "MERGED"
      ? "merged"
      : review?.state === "DECLINED"
        ? "declined"
        : !review
          ? "unread"
          : waiting > 0
            ? "replies"
            : threads > 0 || review.openTasks > 0
              ? "comments"
              : review.ready
                ? "ready"
                : "review";
  return {
    run,
    ...(pr.id ? { id: pr.id } : {}),
    ...(pr.url ? { url: pr.url } : {}),
    phase,
    approvals: review?.approvals ?? 0,
    need,
    threads,
    waiting,
    ...(build ? { build } : {}),
    blockers: review?.blockers ?? [],
    following: followsPr(runtime, run),
    ...(finalized ? { finalized: true as const } : {}),
  };
}

export function spendOf(events: readonly StoredEvent[], now: Date, live: boolean): Spend {
  let calls = 0;
  let promptTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let estimated = false;
  for (const e of events) {
    if (e.kind !== "model.call") continue;
    const p = (e.payload ?? {}) as Record<string, number>;
    calls += 1;
    promptTokens += p.promptTokens ?? 0;
    outputTokens += p.outputTokens ?? 0;
    cachedTokens += p.cachedTokens || p.cachedEstimated || 0;
    if (!p.cachedTokens && (p.cachedEstimated ?? 0) > 0) estimated = true;
  }
  const time = timeSplitOf(events, now, live);
  return {
    calls,
    promptTokens,
    cachedTokens,
    ...(estimated ? { cachedEstimated: true } : {}),
    outputTokens,
    workingMs: time?.parts.working.ms ?? 0,
  };
}

const plus = (a: Spend, b: Spend): Spend => ({
  calls: a.calls + b.calls,
  promptTokens: a.promptTokens + b.promptTokens,
  cachedTokens: a.cachedTokens + b.cachedTokens,
  ...(a.cachedEstimated || b.cachedEstimated ? { cachedEstimated: true } : {}),
  outputTokens: a.outputTokens + b.outputTokens,
  workingMs: a.workingMs + b.workingMs,
});

const leaseLiveOf = (run: Run, now: Date) =>
  run.lease !== undefined && Date.parse(run.lease.until) >= now.getTime();

/** A started subtask now: its step and what its agent does, or what it waits for. */
function subtaskNowOf(run: Run, events: readonly StoredEvent[], now: Date): SubtaskNow | undefined {
  const step = `${run.currentStep ?? "?"}${run.currentIteration > 1 ? `#${run.currentIteration}` : ""}`;
  if (run.state === "WAITING_HUMAN") {
    const kind = run.waitingFor?.kind;
    return {
      pill: t("waits for you · {what}", {
        what: kind === "approval" ? (run.currentStep ?? "approval") : (kind ?? step),
      }),
      tone: "wait",
      ...(run.waitingFor?.detail ? { detail: run.waitingFor.detail } : {}),
    };
  }
  if (run.state === "WAITING_BUDGET")
    return {
      pill: t("paused · {step}", { step }),
      tone: "plain",
      detail: t("waits for the quota window or the model"),
    };
  if (run.state === "SUSPENDED")
    return {
      pill: t("stopped · {step}", { step }),
      tone: "plain",
      ...(run.stateReason ? { detail: run.stateReason } : {}),
    };
  if (run.state === "CREATED") return { pill: t("starting"), tone: "info" };
  if (run.state !== "RUNNING") return undefined;
  if (!leaseLiveOf(run, now))
    return {
      pill: t("no process · {step}", { step }),
      tone: "plain",
      detail: t("interrupted or crashed: Retry or resume it"),
    };
  const a = activityOf(events, now);
  const s = a?.step;
  if (!s) return { pill: step, tone: "info" };
  const parts = [
    s.agent && s.agent !== s.id ? s.agent : "",
    s.modelCalls > 0 ? plural(s.modelCalls, "model call") : "",
    s.toolCalls > 0
      ? s.maxToolCalls
        ? t("tools {n}/{max}", { n: s.toolCalls, max: s.maxToolCalls })
        : plural(s.toolCalls, "tool call")
      : "",
    a?.lastTool
      ? `${t("last:")} ${a.lastTool.capability}${a.lastTool.detail ? ` ${a.lastTool.detail}` : ""}`
      : "",
  ].filter(Boolean);
  return {
    pill: `${s.id}${s.iteration > 1 ? `#${s.iteration}` : ""}`,
    tone: "info",
    ...(parts.length > 0 ? { detail: parts.join(" · ") } : {}),
  };
}

/** A task across services on its run's page: the subtask's master, or the master's subtasks. */
function crossOf(
  runtime: Runtime,
  run: Run,
  now: Date = new Date(),
): Pick<
  RunPage,
  | "subtaskOf"
  | "subtasks"
  | "contractCheck"
  | "contractRequests"
  | "contractItems"
  | "masterBudget"
  | "family"
  | "subtaskNow"
  | "subtaskPr"
> {
  const of = masterOf(runtime, run);
  if (of)
    return {
      subtaskOf: {
        master: of.master,
        key: run.options?.parent?.key ?? "?",
        ...(of.subtask ? { service: of.subtask.service } : {}),
        of: splitOf(runtime, of.master)?.subtasks.length ?? 0,
      },
    };
  if (run.workflow !== MASTER_WORKFLOW) return {};
  const subtasks = subtasksOf(runtime, run);
  const check = runtime.artifacts.listLatest(run.id, "contract-check")[0];
  let contractCheck: ContractCheckView | undefined;
  try {
    contractCheck = check ? (JSON.parse(runtime.artifacts.text(check)) as ContractCheckView) : undefined;
  } catch {
    contractCheck = undefined;
  }
  const contractRequests = pendingContractRequests(runtime, run);
  const masterBudget = masterBudgetOf(runtime, run);
  // what the task spent: the master's own steps and each subtask's run, the sum on the head
  const own = spendOf(runEvents(runtime, run.id), now, leaseLiveOf(run, now));
  const parts: Array<FamilySpend["parts"][number]> = [{ label: t("the master's own steps"), spend: own }];
  const subtaskNow: Record<string, SubtaskNow> = {};
  const subtaskPr: Record<string, RunPr> = {};
  for (const v of subtasks) {
    if (!v.run) continue;
    const events = runEvents(runtime, v.run.id);
    parts.push({
      label: `${v.subtask.key} ${v.subtask.service}`,
      run: v.run,
      state: v.state,
      spend: spendOf(events, now, leaseLiveOf(v.run, now)),
    });
    const n = subtaskNowOf(v.run, events, now);
    if (n) subtaskNow[v.subtask.key] = n;
    const pr = runPrOf(runtime, v.run);
    if (pr) subtaskPr[v.subtask.key] = pr;
  }
  const family: FamilySpend = { total: parts.map((p) => p.spend).reduce(plus), parts };
  return {
    ...(subtasks.length > 0 ? { subtasks, family, subtaskNow } : {}),
    ...(Object.keys(subtaskPr).length > 0 ? { subtaskPr } : {}),
    ...(contractCheck ? { contractCheck } : {}),
    ...(contractRequests.length > 0
      ? { contractRequests, contractItems: splitOf(runtime, run)?.contract ?? [] }
      : {}),
    ...(masterBudget ? { masterBudget } : {}),
  };
}

export interface UntrustedView {
  readonly source: UntrustedSource;
  /** Effects refused since it came in, by capability, in order. */
  readonly held: readonly string[];
}

/** The run page's line on untrusted content (ADR-0016 §4); undefined once a person approved after it. */
export function untrustedOf(events: readonly StoredEvent[]): UntrustedView | undefined {
  const source = untrustedSince(events);
  if (!source) return undefined;
  const held = events
    .filter((e) => e.kind === EFFECT_HELD && e.seq > source.seq)
    .map((e) => str(e.payload?.capability) ?? "?");
  return { source, held: [...new Set(held)] };
}

export interface RunLink {
  readonly id: string;
  readonly workflow: string;
  readonly state: Run["state"];
  readonly step?: string;
  readonly createdAt: string;
}

const linkOf = (r: Run): RunLink => ({
  id: r.id,
  workflow: r.workflow,
  state: r.state,
  createdAt: r.createdAt,
  ...(r.currentStep ? { step: r.currentStep } : {}),
});

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** One line of the activity feed for an event worth a person's attention; undefined for the rest. */
export function feedItem(e: StoredEvent): FeedItem | undefined {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const step = str(p.stepId) ?? e.stepId;
  const who = e.actor?.replace(/^(user|service|ci):/, "");
  const from = (c: unknown) =>
    c === "ui" ? ` ${t("from the page")}` : c === "cli" ? ` ${t("in the terminal")}` : "";
  // ADR-0006 §2: the daemon resuming a run acts for its owner — said where the actor is
  const behalf = e.onBehalfOf
    ? ` ${t("on behalf of {who}", { who: e.onBehalfOf.replace(/^(user|service|ci):/, "") })}`
    : "";
  const by = who ? ` ${t("by {who}", { who })}${behalf}` : "";
  const at = (text: string, tone?: FeedItem["tone"]) => ({ ts: e.ts, text, ...(tone ? { tone } : {}) });
  switch (e.kind) {
    case "run.created":
      return at(`${t("run created")}${by}`);
    case "answers.suggested": {
      const n = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : 0);
      return at(
        t("answers prepared for {questions}: {answers} from the sources, {decisions} your call", {
          questions: plural(n("questions"), "open question"),
          answers: n("answers"),
          decisions: n("decisions"),
        }),
        "ok",
      );
    }
    case "human.note":
      return at(
        `${str(p.by) ? t("note from {who} for {step}", { who: str(p.by) as string, step: step ?? t("the run") }) : t("note for {step}", { step: step ?? t("the run") })}: ${str(p.text)?.slice(0, 160) ?? ""}`,
      );
    case "human.note.delivered":
      return at(t("{agent} got the note", { agent: str(p.agent) ?? t("the agent") }), "ok");
    case "agent.idle":
      return p.stopped === true
        ? at(
            t("{step} stopped: {calls} without an edit", {
              step: step ?? t("the step"),
              calls:
                typeof p.modelCalls === "number" ? plural(p.modelCalls, "model call") : t("many model calls"),
            }),
            "bad",
          )
        : at(
            t("{step}: {calls} without an edit — told to start editing", {
              step: step ?? t("the step"),
              calls:
                typeof p.modelCalls === "number" ? plural(p.modelCalls, "model call") : t("many model calls"),
            }),
            "warn",
          );
    case "answers.preparing":
      return at(
        t("Jarvis prepares answers to {n} from the sources — the gate opens after them", {
          n: plural(typeof p.questions === "number" ? p.questions : 0, "open question"),
        }),
      );
    case "answers.failed":
      return at(
        t("no answers prepared for the open questions: {why}", {
          why: str(p.error) ?? t("the model failed"),
        }),
        "warn",
      );
    case "step.finish": {
      const status = str(p.status) ?? "success";
      const label = `${step ?? "?"}${typeof p.iteration === "number" && p.iteration > 1 ? `#${p.iteration}` : ""}`;
      if (status === "skipped")
        return at(t("{step} skipped: {why}", { step: label, why: str(p.reason) ?? t("nothing to do") }));
      const outcome = str(p.outcome);
      if (status !== "success") return at(`${label} ${status}: ${str(p.reason) ?? ""}`.trim(), "bad");
      return outcome && outcome !== "success"
        ? at(`${label} → ${outcome}`, "warn")
        : at(t("{step} done", { step: label }), "ok");
    }
    case "step.error":
      return at(
        t("{step} error: {why}", { step: step ?? "?", why: str(p.message) ?? str(p.error) ?? "" }),
        "bad",
      );
    case "workflow.loop": {
      const edge = /^(.+)->(.+)#(.+)$/.exec(str(p.edge) ?? "");
      const round =
        typeof p.iteration === "number"
          ? `, ${t("round {n}", { n: `${p.iteration}${typeof p.max === "number" ? `/${p.max}` : ""}` })}`
          : "";
      return at(
        edge ? `↻ ${edge[1]} → ${edge[2]} ${edge[3]}${round}` : `↻ ${t("loop")} ${str(p.edge) ?? ""}${round}`,
        "warn",
      );
    }
    case "run.state": {
      const state = str(p.state) ?? "?";
      const why = str(p.reason);
      if (state === "RUNNING") return at(`${t("running")}${why ? ` — ${why}` : ""}${behalf ? by : ""}`);
      // states as the engine names them, in every language
      if (state === "COMPLETED") return at("✓ COMPLETED", "ok");
      if (state === "FAILED") return at(`✗ FAILED${why ? `: ${why}` : ""}`, "bad");
      return at(`⏸ ${state}${why ? ` — ${why}` : ""}`, "warn");
    }
    case "approval.recorded": {
      const d = str(p.decision) ?? "decision";
      const verb =
        d === "approve"
          ? `✓ ${t("accepted")}`
          : d === "reject"
            ? `✗ ${t("rejected")}`
            : `↻ ${t("sent back")}`;
      return at(
        `${verb} ${str(p.type) ?? ""}@${String(p.version ?? "?")}${by}${from(p.channel)}`,
        d === "approve" ? "ok" : d === "reject" ? "bad" : "warn",
      );
    }
    case "loop.rerun":
      return at(
        `↻ ${p.back === true ? t("one more round of {step}", { step: str(p.step) ?? t("the step") }) : t("run {step} again", { step: str(p.step) ?? t("the step") })}${who ? ` — ${t("by {who}", { who })}` : ""}${from(p.channel)}`,
        "warn",
      );
    case "card.open":
      return at(
        str(p.kind) === "loop"
          ? t("a terminal waits at the loop card")
          : t("a terminal waits at the decision card"),
      );
    case "workspace.humanEdit": {
      const files = Array.isArray(p.files) ? p.files.length : 0;
      return at(t("your edit → checkpoint, {files}", { files: plural(files, "file") }), "ok");
    }
    case "artifact.humanEdit":
      return at(
        `✎ ${t("{doc} edited by a person{who} in {file}", { doc: `${str(p.type) ?? t("document")}@${String(p.version ?? "?")}`, who: who ? ` (${who})` : "", file: str(p.file) ?? t("its file") })}`,
        "ok",
      );
    case "artifact.humanEditRejected":
      return at(
        `✎ ${t("edit of {file} not taken: {why}", { file: str(p.file) ?? t("a file"), why: str(p.reason) ?? "?" })}`,
        "bad",
      );
    case "workspace.scratchRemoved": {
      const files = Array.isArray(p.files) ? p.files.join(", ") : "";
      return at(t("removed scratch files: {files}", { files }));
    }
    case "run.interrupted":
      return at(`⏸ ${t("interrupted (Ctrl-C)")}`, "warn");
    case "run.pause":
      return at(`⏸ ${t("pause asked")}${by}${from(p.channel)}`, "warn");
    case "run.applied":
      return at(`${t("applied")}${by}`, "ok");
    case "related.collected":
      return at(
        t("related work: {issues}, {branches} with a branch, {contract} contract changes", {
          issues: plural(Number(p.issues) || 0, "related task"),
          branches: Number(p.branches) || 0,
          contract: Number(p.contract) || 0,
        }),
        "ok",
      );
    case "mcp.throttled": {
      const server = str(p.server) ?? "?";
      const secs = Math.max(1, Math.round((Number(p.waitMs) || 0) / 1000));
      if (p.reason === "rpm")
        return at(
          t("{server}: its {rpm} calls a minute are used, waiting {s} s", {
            server,
            rpm: Number(p.rpm) || 0,
            s: secs,
          }),
          "warn",
        );
      return at(
        p.gaveUp === true
          ? t("{server} answered 429 (too many requests) {n} times: gave up for now", {
              server,
              n: Number(p.attempt) || 0,
            })
          : t("{server} answered 429 (too many requests): asking again in {s} s", { server, s: secs }),
        "warn",
      );
    }
    case "related.story": {
      const story = str(p.story) ?? "?";
      const branch = str(p.branch) ?? "?";
      if (p.self === true)
        return at(t("Story {story}: its tasks read first, compared with {branch}", { story, branch }));
      // t("in Story {story}: {branch} was not in the repository — Jarvis made it from the base and pushed it; the run started from it, its PR goes into it")
      if (p.based === true && p.created === true)
        return at(
          t(
            "in Story {story}: {branch} was not in the repository — Jarvis made it from the base and pushed it; the run started from it, its PR goes into it",
            { story, branch },
          ),
          "ok",
        );
      if (p.based === true)
        return at(
          t("in Story {story}: the run started from {branch}, its PR goes into it", { story, branch }),
          "ok",
        );
      return at(
        p.why === "no-branch"
          ? t("in Story {story}: the repository has no {branch} yet, the run started from the usual base", {
              story,
              branch,
            })
          : t("in Story {story} ({branch}): the run did not start from its branch", { story, branch }),
        "warn",
      );
    }
    case "related.skipped":
      return at(t("related work not read: {why}", { why: str(p.reason) ?? "?" }));
    case "related.moved":
      return at(
        p.merged === true
          ? t("{issue}: its branch was merged since the spec", { issue: str(p.issue) ?? "?" })
          : p.contractChanged === true
            ? t("{issue}: its branch moved on and its contract changed since the spec — check the spec", {
                issue: str(p.issue) ?? "?",
              })
            : t("{issue}: its branch moved on since the spec, the contract is the same", {
                issue: str(p.issue) ?? "?",
              }),
        p.contractChanged === true ? "bad" : "warn",
      );
    case AUTONOMY_DECIDED: {
      const what = str(p.what);
      const text =
        what === "gate"
          ? t("autonomous: {type} passed without a person", { type: str(p.type) ?? "?" })
          : what === "assumption"
            ? t("autonomous: {agent} asked, nobody answers — the most cautious assumption, the step again", {
                agent: str(p.agent) ?? t("the agent"),
              })
            : what === "scope"
              ? t("autonomous: the task stays in this service")
              : what === "contract"
                ? t("autonomous: the contract stays as agreed")
                : what === "budget"
                  ? p.grant === true
                    ? t("budget judge: +{n} for {agent} — {why}", {
                        n: String(p.amount ?? "?"),
                        agent: str(p.agent) ?? "?",
                        why: str(p.why) ?? "",
                      })
                    : t("budget judge: no more for {agent} — {why}", {
                        agent: str(p.agent) ?? "?",
                        why: str(p.why) ?? "",
                      })
                  : t("autonomous: nobody to decide — the run ends");
      return at(text, what === "stopped" || (what === "budget" && p.grant !== true) ? "bad" : "warn");
    }
    case "run.delivered":
      return at(`${t("PR opened")}${str(p.url) ? `: ${str(p.url)}` : ""}${by}`, "ok");
    case "delivery.failed":
      return at(`${t("No PR:")} ${str(p.reason) ?? ""}`.trim(), "warn");
    case "pr.checked": {
      // a read every few minutes: in the feed only when it brought something
      if (p.state !== undefined && p.state !== "OPEN")
        return at(
          p.state === "MERGED" ? t("the PR is merged") : t("the PR is {state}", { state: String(p.state) }),
          "ok",
        );
      if (p.ready === true && p.readyChanged === true)
        return at(t("the PR is ready for merge: merge it in Bitbucket"), "ok");
      const fresh = Number(p.fresh) || 0;
      if (fresh > 0)
        return at(
          t("PR: {comments} new, {open} open threads, approvals {approvals}", {
            comments: plural(fresh, "comment"),
            open: Number(p.open) || 0,
            approvals: Number(p.approvals) || 0,
          }),
        );
      if (p.readyChanged === true) return at(t("the PR is not ready for merge any more"), "warn");
      return undefined;
    }
    // t("PR comments weighed: agrees {agree}, disagrees {disagree}, questions {question}, nothing to do {nothing}")
    case "pr.triaged": {
      const n = (k: string) => Number(p[k]) || 0;
      return at(
        t(
          "PR comments weighed: agrees {agree}, disagrees {disagree}, questions {question}, nothing to do {nothing}",
          {
            agree: n("agree"),
            disagree: n("disagree"),
            question: n("question"),
            nothing: n("nothing"),
          },
        ),
        n("disagree") + n("question") > 0 ? "warn" : undefined,
      );
    }
    case "pr.triageFailed":
      return at(t("the PR comments could not be weighed: {why}", { why: str(p.reason) ?? "?" }), "warn");
    case "pr.threadDecided":
      return at(
        p.action === "send"
          ? t("reply posted in thread {thread}{by}", { thread: String(p.thread), by })
          : p.action === "fix"
            ? t("thread {thread}: to be fixed{by}", { thread: String(p.thread), by })
            : t("thread {thread}: left to the person{by}", { thread: String(p.thread), by }),
      );
    case "run.finalized":
      return at(
        `${p.ready === true ? t("the task is finalized") : t("the task is finalized, its PR not ready for merge")}${by}`,
        p.ready === true ? "ok" : "warn",
      );
    case "pr.fixStarted":
      return at(
        t("fixing the PR's comments: {threads}, run {run}", {
          threads: plural(Number(p.threads) || 0, "thread"),
          run: (str(p.run) ?? "").replace(/^run_/, "").slice(0, 8),
        }),
      );
    case "pr.fixPushed":
      return at(
        t("the fix is pushed to {branch}: {commit}, {threads} answered", {
          branch: str(p.branch) ?? "?",
          commit: str(p.commit) ?? "?",
          threads: plural(Number(p.threads) || 0, "thread"),
        }),
        "ok",
      );
    case "pr.checkFailed":
      return at(t("the PR could not be read: {why}", { why: str(p.reason) ?? "?" }), "warn");
    case "delivery.skipped":
      return at(
        p.code === "empty"
          ? t("no PR: the run changed no code")
          : t("no PR: the run worked in your checkout, there is no branch to push"),
      );
    case "context.compacting": {
      const c = {
        kind: str(p.kind) ?? "compact",
        tokens: Number(p.tokens) || 0,
        blocks: Number(p.blocks) || 0,
        ms: 0,
      };
      return at(`⇣ ${compactingText(c)}…`, "warn");
    }
    case "context.compacted":
    case "context.reset":
    case "context.compaction_failed":
    case "model.retry":
    case "model.failover":
    case "model.error":
    case UNTRUSTED_CONTENT:
    case EFFECT_HELD: {
      // the notice's sentences, translated by src/app/activity.ts through t:
      // t("after {time}")
      // t("model")
      // t("in {time}")
      // t("retry {n}")
      // t("the summary came back empty: the record of the calls and the sources were kept instead")
      // t("the summary was cut off: the record of the calls was added")
      // t("conversation reset")
      // t("conversation compacted")
      // t("1 block into a summary")
      // t("{n} blocks into a summary")
      // t("compaction failed: {why} — older results were trimmed harder instead")
      // t("the summarizer")
      // t("the quota window of pool {pool} is full")
      // t("the quota window is full")
      // t("calls go to {model} until it frees")
      // t("the next model")
      // t("quota used up")
      // t("the run waits")
      // t("gave up after 1 attempt")
      // t("gave up after {n} attempts")
      // t("untrusted content from the internet: {tool} — from now on effects wait for a person's approval (ADR-0016 §4)")
      // t("a tool")
      // t("an internet tool")
      // t("effect {capability} held: the run read untrusted content ({from}) and no person has approved anything since (ADR-0016 §4)")
      const notice = noticeOf(e, t);
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

/** What the impact analysis names, by kind (`docs`, `telemetry`, …); undefined before it. */
function affectedKinds(runtime: Runtime, run: Run): Set<string> | undefined {
  const impact = runtime.artifacts.listLatest(run.id, "impact")[0];
  if (!impact) return undefined;
  try {
    const doc = JSON.parse(runtime.artifacts.text(impact)) as { affected?: Array<{ kind?: unknown }> };
    return new Set((doc.affected ?? []).map((a) => a.kind).filter((k): k is string => typeof k === "string"));
  } catch {
    return new Set();
  }
}

/**
 * Whether a step belongs on this run's page. Not drawn: a gate the configuration does not require
 * (it passes by itself), and a conditional step (`when: { affects }`) before the impact analysis or
 * when it names nothing of that kind. A step skipped this round because a sibling failed stays: that
 * is what happened. Pilot: grey rows of steps the run never needed.
 */
function forThisRun(
  runtime: Runtime,
  run: Run,
  workflow: WorkflowDefinition | undefined,
  row: StepRow,
): boolean {
  const step = workflow?.steps.find((s) => s.id === row.id);
  if (!step) return true;
  // a gate nobody has to pass: also once it passed by itself
  if (step.kind === "approval" && step.artifactType && row.status !== "waiting" && row.status !== "failed")
    return runtime.loaded.config.human.gates[step.artifactType]?.required !== false;
  if (row.status !== "pending" && row.status !== "skipped") return true;
  const kind = step.when?.affects;
  if (kind) return affectedKinds(runtime, run)?.has(kind) === true;
  return true;
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
  const skills = new Map<string, StepSkills>();
  for (const e of events) {
    if (e.kind === "context.skills" && e.stepId) skills.set(e.stepId, skillsOf(e));
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
  // steps done in the run this one went on from: shown done, with that run's reports
  const fromId = continuedFromOf(runtime, run);
  const fromRun = fromId ? runtime.runs.get(fromId) : undefined;
  const carried = new Map<string, StepReport>();
  if (fromRun) {
    const theirs = new Journey(plan);
    for (const e of runEvents(runtime, fromRun.id))
      for (const line of theirs.push(e))
        if (line.kind === "step" && !reports.has(line.report.stepId))
          carried.set(line.report.stepId, line.report);
  }
  const activity = activityOf(events, now);
  const fixing = run.state === "RUNNING" ? fixingOf(runtime, events, activity) : undefined;
  const leaseLive = run.lease !== undefined && Date.parse(run.lease.until) >= now.getTime();
  const row = (id: string): StepRow => {
    const theirs = carried.get(id);
    if (theirs && fromRun && !started.has(id))
      return {
        id,
        child: children.has(id),
        status: theirs.status === "skipped" ? "skipped" : "done",
        last: theirs,
        rounds: 1,
        loops: [],
        carriedFrom: { id: fromRun.id, workflow: fromRun.workflow },
      };
    const all = reports.get(id) ?? [];
    const last = all.at(-1);
    const inFlight = started.has(id) && !finished.has(id);
    // the last round's outcome took a back edge: it sent the work back, it did not pass
    const sentBack = (() => {
      const l = loops.get(id)?.at(-1);
      return !!last?.outcome && l?.outcome === last.outcome;
    })();
    const forChildren =
      run.currentStep === id && run.state === "SUSPENDED" && run.waitingFor?.kind === "children";
    const status: StepRow["status"] =
      run.currentStep === id &&
      (run.state === "WAITING_HUMAN" || run.state === "WAITING_BUDGET" || forChildren)
        ? "waiting"
        : inFlight && run.state === "RUNNING"
          ? "running"
          : inFlight
            ? "stopped"
            : !last
              ? "pending"
              : last.status === "skipped"
                ? "skipped"
                : last.status === "success"
                  ? sentBack
                    ? "returned"
                    : "done"
                  : "failed";
    const at = started.get(id);
    return {
      id,
      child: children.has(id),
      status,
      ...(last ? { last } : {}),
      ...(run.currentStep === id && run.state === "WAITING_BUDGET" ? { paused: true } : {}),
      ...(forChildren ? { forChildren: true } : {}),
      rounds: all.filter((r) => r.status !== "skipped").length,
      loops: loops.get(id) ?? [],
      ...(at ? { startedAt: at } : {}),
      ...((k) => (k ? { skills: k } : {}))(skills.get(id)),
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
        const estimated = !p.cachedTokens && (p.cachedEstimated ?? 0) > 0;
        return {
          calls: acc.calls + 1,
          promptTokens: acc.promptTokens + (p.promptTokens ?? 0),
          cachedTokens: acc.cachedTokens + (p.cachedTokens || p.cachedEstimated || 0),
          outputTokens: acc.outputTokens + (p.outputTokens ?? 0),
          retries: acc.retries + (p.retries ?? 0),
          ...(acc.cachedEstimated || estimated ? { cachedEstimated: true } : {}),
        };
      },
      { calls: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0, retries: 0 },
    );
  // time in steps, from the journal: a composite's children run inside it, side by side
  const workedMs = [...reports.entries()]
    .filter(([id]) => !children.has(id))
    .flatMap(([, rs]) => rs)
    .reduce((sum, r) => sum + r.durationMs, 0);
  const feed = feedOf(events);
  return {
    ...(run.options?.autonomous && runtime.loaded.config.human.arbiter.enabled && !arbiterRole(runtime).own
      ? { arbiterShared: true }
      : {}),
    run,
    kind: kindOfTask({ task: run.task, picked: run.options?.kind, workflowKind: workflow?.kind }),
    plan,
    steps: order.map(row).filter((r) => forThisRun(runtime, run, workflow, r)),
    ...crossOf(runtime, run, now),
    ...((p) => (p ? { pr: p } : {}))(run.state === "COMPLETED" ? runPrOf(runtime, run) : undefined),
    tokens,
    workedMs,
    ...((t) => (t ? { time: t } : {}))(timeSplitOf(events, now, leaseLive)),
    ...(activity && run.state === "RUNNING" ? { activity } : {}),
    ...(run.state === "WAITING_HUMAN" ? { card: await waitCardOf(runtime, run, options.homeDir) } : {}),
    terminal: waitingCard(runtime, run.id) !== undefined,
    // all of it: the page shows the newest few and the rest under «earlier»
    feed,
    artifacts: artifactStates(runtime, run),
    leaseLive,
    ...(() => {
      const wait = budgetWaitOf(runtime, run);
      return wait ? { wait } : {};
    })(),
    ...((r) => (r ? { resumable: r } : {}))(resumableOf(runtime, run, now.getTime())),
    ...continuationLinks(runtime, engine, run),
    ...restartOf(runtime, engine, run),
    ...redoOf(runtime, engine, run),
    ...evalOf(runtime, run),
    ...((n) => (n.length > 0 ? { notes: n } : {}))(notesOf(runtime, run.id)),
    ...(isTerminal(run.state)
      ? {}
      : {
          steer: {
            askOnFailure: checksAskOf(runtime, run.id) === "every-failure",
            projectAsk: runtime.loaded.config.human.checks.ask,
            ...((p) =>
              p
                ? { stopAfter: { step: p.step, iteration: p.iteration, ...(p.by ? { by: p.by } : {}) } }
                : {})(pauseAfterRequested(runtime, run.id)),
          },
        }),
    ...((p) => (p ? { pausing: p.by ? { by: p.by } : {} } : {}))(
      run.state === "RUNNING" ? pauseRequested(runtime, run.id) : undefined,
    ),
    ...(fixing ? { fixing } : {}),
    ...((u) => (u ? { untrusted: u } : {}))(
      events.some((e) => e.kind === UNTRUSTED_CONTENT) ? untrustedOf(events) : undefined,
    ),
    // a round that fixes what was found is not the plan again (pilot: «plan 1 of 11» in round 2)
    ...((p) => (p ? { planProgress: p } : {}))(
      run.state === "RUNNING" && implementing(activity) && !fixing
        ? planProgressOf(runtime, run, events)
        : undefined,
    ),
  };
}

/** The steps a run that waits, is paused or failed can go back to (src/app/redo.ts). */
function redoOf(runtime: Runtime, engine: LocalWorkflowEngine, run: Run): Pick<RunPage, "redo"> {
  if (run.options?.parent || !redoableInPlace(run)) return {};
  const workflow = workflowOf(engine, run);
  const targets = workflow ? redoTargets(runtime, run, workflow) : [];
  return targets.length > 0
    ? { redo: { targets, ...(run.currentStep ? { current: run.currentStep } : {}) } }
    : {};
}

/**
 * A cancelled or failed run that can start again from one of its steps (src/app/restart.ts), and the
 * run it last started again as.
 */
function restartOf(runtime: Runtime, engine: LocalWorkflowEngine, run: Run): Pick<RunPage, "restart"> {
  if ((run.state !== "CANCELLED" && run.state !== "FAILED") || run.options?.parent) return {};
  const workflow = workflowOf(engine, run);
  const plan = workflow ? restartPlanOf(runtime, run, workflow) : undefined;
  if (!plan) return {};
  let as: Run | undefined;
  for (const e of runtime.events.list({ kind: "run.created", limit: 100_000 })) {
    if ((e.payload as { restartOf?: string } | undefined)?.restartOf === run.id && e.runId)
      as = runtime.runs.get(e.runId) ?? as;
  }
  return { restart: { ...plan, ...(as ? { restartedAs: linkOf(as) } : {}) } };
}

/** Where a run came from and where it went on (src/app/continuation.ts). */
function continuationLinks(
  runtime: Runtime,
  engine: LocalWorkflowEngine,
  run: Run,
): Pick<RunPage, "next" | "continuedBy" | "continuedFrom"> {
  const fromId = continuedFromOf(runtime, run);
  const from = fromId ? runtime.runs.get(fromId) : undefined;
  const byId = run.state === "COMPLETED" ? continuedBy(runtime, run) : undefined;
  const by = byId ? runtime.runs.get(byId) : undefined;
  const next = by ? undefined : continuationOf(runtime, engine, run);
  return {
    ...(next ? { next: { ...next, contradictions: contradictionsOf(runtime, run.id) } } : {}),
    ...((cross) => (next && cross ? { nextCross: cross } : {}))(crossContinuationOf(runtime, run)),
    ...(by ? { continuedBy: linkOf(by) } : {}),
    ...(from
      ? { continuedFrom: { ...linkOf(from), contradictions: contradictionsOf(runtime, from.id) } }
      : {}),
  };
}

/* ---- one artifact ---- */

/** The document's open questions with what Jarvis prepared for them (src/interaction/answers.ts). */
export interface QuestionsView {
  readonly list: readonly string[];
  /** Per question: its words without the options, and its own options (offered when no suggestion has some). */
  readonly details?: readonly QuestionDetail[];
  readonly suggestions?: SuggestionsDoc;
  /** What a person answered on this version, if they decided here. */
  readonly given?: readonly GivenAnswer[];
}

export interface ArtifactPage {
  readonly questions?: QuestionsView;
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
  /** The latest version of a document a person may edit as a file (ADR-0005 §3): where it is. */
  readonly editFile?: string;
}

/** The file of an editable document, while the run is not over and its workspace is there. */
function editFileOf(run: Run, artifact: ArtifactVersion, latest: ArtifactVersion): string | undefined {
  if (!isEditable(artifact.type) || artifact.version !== latest.version || isTerminal(run.state))
    return undefined;
  const file = editableFile(run, artifact);
  return existsSync(file) ? file : undefined;
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
    ...questionsOf(runtime, artifact, text),
    terminal: waitingCard(runtime, run.id) !== undefined,
    ...((r) => (r ? { resumable: r } : {}))(resumableOf(runtime, run)),
    ...((f) => (f ? { editFile: f } : {}))(editFileOf(run, artifact, latest)),
  };
}

function questionsOf(
  runtime: Runtime,
  artifact: ArtifactVersion,
  text: string,
): Pick<ArtifactPage, "questions"> {
  const list = openQuestionsOf(text);
  if (list.length === 0) return {};
  const details = openQuestionDetailsOf(text);
  const suggestions = suggestionsFor(runtime, artifact);
  const given = givenFor(runtime, artifact);
  return {
    questions: {
      list,
      ...(details.length === list.length ? { details } : {}),
      ...(suggestions ? { suggestions } : {}),
      ...(given ? { given } : {}),
    },
  };
}

export interface FixView {
  readonly round: number;
  readonly max?: number;
  /** The step that sent the work back (a composite: its children's reasons). */
  readonly from: string;
  readonly reasons: ReadonlyArray<{ readonly step: string; readonly text: string }>;
  /** A person sent the work back at a gate: who, what, with which comment (it goes to the agent as is). */
  readonly review?: {
    readonly by: string;
    readonly channel?: string;
    readonly ref: string;
    readonly decision: string;
    readonly comment?: string;
  };
}

/** The running step's fix round, if it is one: with the comments people sent the work back with. */
export function fixingOf(
  runtime: Runtime,
  events: readonly StoredEvent[],
  activity: Activity | undefined,
): FixView | undefined {
  return fixOf(
    events,
    activity?.step?.id,
    (artifactId, version, decision) =>
      runtime.artifacts
        .approvalsFor(artifactId, version)
        .filter((a) => a.decision === decision)
        .at(-1)?.comment,
  );
}

/**
 * A step running again on a back edge (`verify → implementation#defects_found`): the round and why —
 * the reasons the steps in between finished with. Pilot: the second round showed «Plan 1 of 15» as if
 * the work started over.
 */
export function fixOf(
  events: readonly StoredEvent[],
  stepId: string | undefined,
  commentOf?: (artifactId: string, version: number, decision: string) => string | undefined,
): FixView | undefined {
  if (!stepId) return undefined;
  let start = -1;
  let iteration = 1;
  events.forEach((e, i) => {
    const p = (e.payload ?? {}) as { stepId?: string; iteration?: number };
    if (e.kind === "step.start" && (p.stepId ?? e.stepId) === stepId) {
      start = i;
      iteration = typeof p.iteration === "number" ? p.iteration : (e.iteration ?? 1);
    }
  });
  if (start < 0 || iteration <= 1) return undefined;
  let loop: { edge?: string; iteration?: number; max?: number } | undefined;
  let loopAt = -1;
  let prevEnd = -1;
  for (let i = start - 1; i >= 0; i--) {
    const e = events[i] as StoredEvent;
    const p = (e.payload ?? {}) as { stepId?: string; edge?: string };
    if (
      !loop &&
      e.kind === "workflow.loop" &&
      typeof p.edge === "string" &&
      p.edge.includes(`->${stepId}#`)
    ) {
      loop = e.payload as typeof loop;
      loopAt = i;
    }
    if (e.kind === "step.finish" && (p.stepId ?? e.stepId) === stepId) {
      prevEnd = i;
      break;
    }
  }
  // a step only runs again «to fix» when a back edge sent the work to it; a later step on its next
  // round (review after another implementation round) fixes nothing (pilot: review#3 showed «Fixing
  // what … sent back» and four typecheck failures already fixed)
  if (!loop) return undefined;
  // the reasons of the round that sent it back: since the sending step last began
  const from = loop.edge?.split("->")[0];
  let fromStart = prevEnd;
  for (let i = loopAt - 1; i > prevEnd; i--) {
    const e = events[i] as StoredEvent;
    const p = (e.payload ?? {}) as { stepId?: string };
    if (e.kind === "step.start" && (p.stepId ?? e.stepId) === from) {
      fromStart = i;
      break;
    }
  }
  const reasons: Array<{ step: string; text: string }> = [];
  let review: FixView["review"];
  let gate: string | undefined;
  // a person's decision is recorded before the gate's step runs again: from the last round on
  for (const [k, e] of events.slice(prevEnd + 1, loopAt).entries()) {
    if (e.kind === "approval.recorded") {
      const p = (e.payload ?? {}) as {
        artifactId?: unknown;
        version?: unknown;
        type?: unknown;
        decision?: unknown;
        channel?: unknown;
      };
      const decision = typeof p.decision === "string" ? p.decision : "";
      if (decision && decision !== "approve") {
        gate = e.stepId ?? gate;
        const comment =
          typeof p.artifactId === "string" && typeof p.version === "number"
            ? commentOf?.(p.artifactId, p.version, decision)
            : undefined;
        review = {
          by: (e.actor ?? "a person").replace(/^(user|service|ci):/, ""),
          ...(typeof p.channel === "string" ? { channel: p.channel } : {}),
          ref: `${typeof p.type === "string" ? p.type : "artifact"}@${String(p.version ?? "?")}`,
          decision,
          ...(comment?.trim() ? { comment: comment.trim() } : {}),
        };
      }
      continue;
    }
    if (e.kind !== "step.finish" || prevEnd + 1 + k <= fromStart) continue;
    const p = (e.payload ?? {}) as { stepId?: string; outcome?: string; status?: string; reason?: string };
    const bad =
      (p.outcome && p.outcome !== "success") ||
      (p.status && p.status !== "success" && p.status !== "skipped");
    if (bad && typeof p.reason === "string" && p.reason.trim())
      reasons.push({ step: p.stepId ?? e.stepId ?? "?", text: p.reason.trim() });
  }
  return {
    round: iteration,
    ...(typeof loop?.max === "number" ? { max: loop.max + 1 } : {}),
    from: loop?.edge?.split("->")[0] ?? gate ?? "a later step",
    reasons,
    ...(review ? { review } : {}),
  };
}

/** A run that ended with an accepted implementation can become an eval case; or it did already. */
function evalOf(runtime: Runtime, run: Run): Pick<RunPage, "evalReady" | "evalCase" | "evalWhy"> {
  if (run.state !== "COMPLETED") return {};
  const made = caseOfRun(casesRootOf(run.workspace.repoRoot), run.id);
  if (made) return { evalCase: made };
  const impl = runtime.artifacts.listLatest(run.id, "implementation")[0];
  if (!impl || !runtime.artifacts.isApproved(impl.artifactId).approved) return {};
  const why = isDismissed(runtime, run.id) ? undefined : candidateReasons(runtime, run);
  return { evalReady: true, ...(why ? { evalWhy: why } : {}) };
}

/** The step running now is an implementation (it works through a plan). */
const implementing = (a: Activity | undefined): boolean =>
  a?.step?.agent === "implementation" || a?.step?.id === "implementation";

export { shortRunId };

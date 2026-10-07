import { type Activity, clock, compactingText, kilo, type ToolBatch } from "../app/activity.ts";
import { type BudgetStop, sourceOf, unitOf } from "../app/budgetStop.ts";
import { type BudgetWait, whenText } from "../app/budgetWait.ts";
import { isStale, issueKeyOf, type StartPoint } from "../app/continuation.ts";
import { duration } from "../app/journey.ts";
import type { McpHealth, McpServerHealth } from "../app/mcpHealth.ts";
import type { HealthState, ModelHealth, ModelPerf, ModelsHealth, Unlimited } from "../app/modelHealth.ts";
import type { Change } from "../cli/checkout.ts";
import { toolMix } from "../cli/progress.ts";
import { documentToMarkdown } from "../cli/render.ts";
import { incompleteOf } from "../cli/style.ts";
import { isTerminal, type Run } from "../core/domain/run.ts";
import type { EgressNotice } from "../security/policy/egress.ts";
import { shortRunId } from "../storage/runStore.ts";
import { type DiffFile, escapeHtml, type Html, html, join, markdownToHtml, type Part } from "./html.ts";
import type {
  ApprovalCard,
  ArtifactPage,
  BudgetCard,
  ClarifyCard,
  FeedItem,
  LoopCard,
  RunPage,
  RunsPage,
  StepRow,
  WaitCard,
  WaitingCandidate,
  WaitingRun,
} from "./model.ts";
import { RECENT_PAGE, RECENT_SIZES } from "./model.ts";

/**
 * The pages of `jarvis ui` (ADR-0023 §3), server-rendered from the models in model.ts. Look: the
 * approved mockups (runs, run, review) — Plex Sans and Mono, a warm ground, white panels. Regions
 * marked `data-live` are re-rendered by the page's script when the journal moves.
 */

/**
 * What the page may do (ADR-0023 §3, §6 p.4): decide, run a used-up loop's step again, open the
 * checkout in the editor. Forms carry the session token; without it the pages only read.
 */
export interface Actions {
  readonly token: string;
  /** Tasks can be started from the page (a launcher): "Continue to sdd" goes on in the background. */
  readonly canLaunch?: boolean;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** A POST form with the session token: a foreign page cannot make one (ADR-0023 §5). */
function form(actions: Actions, action: string, body: Part, attrs: Part = ""): Html {
  return html`<form method="post" action="${action}"${attrs}><input type="hidden" name="t" value="${actions.token}">${body}</form>`;
}

/** "Resume": the page drives the run from now on and starts `jarvis resume` (src/app/resumable.ts). */
function resumeForm(actions: Actions, run: Pick<Run, "id">, label = "Resume"): Html {
  return form(
    actions,
    `${runHref(run)}/resume`,
    html`<button type="submit" class="btn primary">${label}</button>`,
  );
}

/** After a decision: who goes on with it — the terminal at the card, this page, or nobody yet. */
function goesOn(page: Pick<RunPage, "run" | "terminal" | "driven" | "resumable">, actions?: Actions): Html {
  const cmd = `jarvis continue ${shortRunId(page.run.id)}`;
  if (page.terminal) return html`<span class="hint">The terminal waiting at the card goes on with it.</span>`;
  if (page.resumable && actions)
    return html`${resumeForm(actions, page.run)}<span class="hint">${page.driven ? "It did not go on by itself" : "No terminal waits at this run"}: Resume goes on in the background, or <code>${cmd}</code> in a terminal</span>`;
  if (page.driven) return html`<span class="hint">It goes on in the background.</span>`;
  return html`<span class="hint">No terminal waits at this run: it goes on with <code>${cmd}</code></span><button type="button" class="btn" data-copy="${cmd}">Copy command</button>`;
}

export interface Chrome {
  readonly title: string;
  readonly page: "runs" | "run" | "artifact" | "knowledge" | "error";
  readonly address: string;
  readonly runId?: string;
  readonly back?: { readonly href: string; readonly label: string };
  readonly repos?: Html;
  /** Re-render the live regions this often (ms): clocks, the checkout's changes. */
  readonly tick?: number;
  /** The person's pick from the header's switch; none — the system's (prefers-color-scheme). */
  readonly theme?: "light" | "dark";
  /** A task can be started from the page (`jarvis ui` with a launcher, not read-only). */
  readonly canStart?: boolean;
  /** Without scripts, reload the page this often (seconds); with them the live regions refresh (`tick`). */
  readonly refresh?: number;
  /** MCP servers out of the project's data class by an exception (ADR-0016 §6): said on every page. */
  readonly egress?: readonly EgressNotice[];
}

export function layout(chrome: Chrome, content: Html): string {
  return html`<!doctype html>
<html lang="en"${chrome.theme ? html` data-theme="${chrome.theme}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${chrome.theme ?? "light dark"}">
${chrome.refresh ? html`<noscript><meta http-equiv="refresh" content="${String(chrome.refresh)}"></noscript>` : ""}
<meta name="referrer" content="same-origin">
<title>${chrome.title} · jarvis</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&amp;family=IBM+Plex+Sans:wght@400;500;600&amp;display=swap">
<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/app.js" defer></script>
</head>
<body data-page="${chrome.page}"${chrome.runId ? html` data-run="${chrome.runId}"` : ""}${chrome.tick ? html` data-tick="${chrome.tick}"` : ""}>
<a class="skip-link" href="#main">Skip to content</a>
<header class="top"><div class="wrap">
<a class="brand" href="/">jarvis</a>
${chrome.back ? html`<a class="back" href="${chrome.back.href}">← ${chrome.back.label}</a>` : ""}
${chrome.repos ?? ""}
<nav aria-label="Pages"><a href="/"${chrome.page === "runs" ? html` aria-current="page"` : ""}>Runs</a><a href="/knowledge"${chrome.page === "knowledge" ? html` aria-current="page"` : ""}>Knowledge</a></nav>
${chrome.canStart ? html`<a class="btn primary small" href="/#new">New task</a>` : ""}
<div class="status">
<div class="models-wrap" data-pop-wrap><button type="button" class="models" data-mcp aria-expanded="false" aria-controls="mcp-pop" title="MCP: checking the servers…"><span class="dot" data-state="pending" aria-hidden="true"></span><span>mcp</span></button>
<div id="mcp-pop" class="pop" role="dialog" aria-label="MCP servers" hidden><div data-mcp-body>${mcpPending()}</div></div></div>
<div class="models-wrap" data-pop-wrap><button type="button" class="models" data-models aria-expanded="false" aria-controls="models-pop" title="Models: collecting the stats…"><span class="dot" data-state="pending" aria-hidden="true"></span><span>models</span><span class="free" data-badge hidden></span></button>
<div id="models-pop" class="pop" role="dialog" aria-label="Models" hidden><div data-models-body>${modelsPending()}</div></div></div>
<span class="live" data-state="connecting" role="status"><span class="dot" aria-hidden="true"></span><span class="label">connecting…</span><span aria-hidden="true">·</span><span>${chrome.address}</span></span>
<button type="button" class="theme notify" data-notify aria-pressed="false" aria-label="System notifications when a run waits for you" title="System notifications when a run waits for you"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.75a4 4 0 0 0-4 4v2.6L2.75 11h10.5L12 8.35v-2.6a4 4 0 0 0-4-4zM6.5 13a1.5 1.5 0 0 0 3 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"></path></svg></button>
<button type="button" class="theme" data-theme-switch aria-label="Switch the theme" title="Switch the theme"><svg class="moon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path></svg><svg class="sun" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"></circle><path d="M8 1v1.75M8 13.25V15M1 8h1.75M13.25 8H15M3.05 3.05l1.24 1.24M11.71 11.71l1.24 1.24M3.05 12.95l1.24-1.24M11.71 4.29l1.24-1.24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path></svg></button>
</div>
</div></header>
${
  chrome.egress && chrome.egress.length > 0
    ? html`<div class="egress" role="note"><div class="wrap">${chrome.egress.map(
        (n) =>
          html`<p><span aria-hidden="true">⚠</span> <b>dataClass ${n.dataClass}</b> — MCP server <code>${n.server}</code> goes to the ${n.network} by an exception, reads only: ${n.reason}</p>`,
      )}</div></div>`
    : ""
}
<main id="main" class="wrap">
${content}
</main>
</body>
</html>
`.value;
}

/* ---- small pieces ---- */

const firstLine = (text: string, max = 200): string => {
  const line = text.split("\n")[0]?.trim() ?? "";
  return [...line].length > max ? `${[...line].slice(0, max - 1).join("")}…` : line;
};

const cut = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return [...one].length > max ? `${[...one].slice(0, max - 1).join("")}…` : one;
};

/** `19:52:10` in the machine's time: the page runs where the terminal does. */
export function wallClock(iso: string): string {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/** `12m`, `3h`, `2d`: how long something has waited. */
function ago(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

const runHref = (run: Pick<Run, "id">) => `/runs/${encodeURIComponent(shortRunId(run.id))}`;

export function artifactHref(
  run: Pick<Run, "id">,
  a: { type: string; name: string; version?: number },
): string {
  return `${runHref(run)}/artifacts/${encodeURIComponent(a.type)}/${encodeURIComponent(a.name)}${a.version ? `?v=${a.version}` : ""}`;
}

/** The state of a run as a pill: `⏸ WAITING_HUMAN · loop`, `◌ RUNNING · verify#4`, `✓ COMPLETED`. */
/** «Cancel» pressed and the run not stopped yet: it finishes its current model or tool call first. */
const cancelling = (run: Run): boolean => run.cancelRequested && !isTerminal(run.state);

function statePill(run: Run, extra?: string): Html {
  if (cancelling(run))
    return html`<span class="pill bad"><span class="spin" aria-hidden="true"></span> CANCELLING</span>`;
  const s = run.state;
  const tone =
    s === "COMPLETED"
      ? "ok"
      : s === "FAILED"
        ? "bad"
        : s === "RUNNING"
          ? "info"
          : s === "CANCELLED" || s === "CREATED"
            ? "plain"
            : "wait";
  const glyph = { ok: "✓", bad: "✗", info: "◌", plain: "–", wait: "⏸" }[tone];
  const label = s === "WAITING_BUDGET" ? "PAUSED · waits for quota" : s;
  return html`<span class="pill ${tone}">${glyph} ${label}${extra ? ` · ${extra}` : ""}</span>`;
}

function changeLine(c: Change): Html {
  const code = c.code === "??" ? "+" : c.code;
  const tone = code === "D" ? "bad" : code === "+" || code === "A" ? "ok" : "warn";
  return html`<span><span class="${tone}">${code}</span> ${c.file}</span>`;
}

function terminalHint(card: WaitCard, terminal: boolean, run: Run): Html {
  const cmd = `jarvis continue ${shortRunId(run.id)}`;
  if (terminal)
    return html`<p class="hint">A terminal waits at this card: what you decide there shows here, and the other way round.</p>`;
  const key =
    card.kind === "loop"
      ? html` (<code>r</code> runs ${card.step} again)`
      : card.kind === "budget"
        ? html` (<code>enter</code> more, <code>f</code> finish)`
        : "";
  return html`<div class="actions"><span class="hint">Decide in the terminal: <code>${cmd}</code>${key}</span><button type="button" class="btn" data-copy="${cmd}">Copy command</button></div>`;
}

/* ---- runs ---- */

/** A module research whose candidate waits for a review on the Modules page. */
function candidateCardHtml(c: WaitingCandidate, now: number): Html {
  const href = `/knowledge/modules?path=${encodeURIComponent(c.module)}`;
  return html`<article class="panel card">
<div class="row"><span class="pill info">⏸ knowledge · module</span><span class="meta">onboard-module · ${c.run} · waiting ${ago(c.at, now)}</span></div>
<h3>Review what the research found: <code>${c.module}</code></h3>
<p>${c.claims ? `${c.claims.kept} of ${c.claims.proposed} claims confirmed against the code` : "A module document"}${c.review > 0 ? ` · ${c.review} generalisation${c.review === 1 ? "" : "s"} to check` : ""}. Nothing is written until you accept it.</p>
<div class="actions"><a class="btn primary" href="${href}">Review the module</a><a class="btn" href="/runs/${encodeURIComponent(c.run)}">Open the run</a></div>
</article>`;
}

function waitingCardHtml(w: WaitingRun, now: number, actions?: Actions): Html {
  const { run, card } = w;
  const meta = html`<span class="meta">${run.workflow} · ${shortRunId(run.id)} · waiting ${ago(run.updatedAt, now)}${w.terminal ? " · a terminal waits" : ""}</span>`;
  // decided, and nobody goes on with it: Resume first (src/app/resumable.ts)
  const resume = w.resumable && actions ? resumeForm(actions, run) : "";
  const primary = resume ? "btn" : "btn primary";
  if (card.kind === "loop") {
    const reasons = card.reasons
      .slice(0, 2)
      .map(
        (r, i) =>
          html`${i > 0 ? "; " : ""}${r.kind ? html`<span class="chip">${r.kind}</span> ` : ""}${cut(r.text, 120)}`,
      );
    const more = card.reasons.length > 2 ? ` +${card.reasons.length - 2} more` : "";
    return html`<article class="panel card">
<div class="row"><span class="pill wait">⏸ loop used up · ${card.step}</span>${meta}</div>
<h3>${firstLine(run.task)}</h3>
<p>${card.step} sent the work back ${card.iterations ? `${card.iterations} times` : "too often"}${card.reasons.length > 0 ? html`: ${reasons}${more}` : "."}</p>
<div class="actions">${resume}<a class="${primary}" href="${runHref(run)}">Open the run</a>${actions ? form(actions, `${runHref(run)}/open`, html`<button type="submit" class="btn">Open in editor</button>`) : ""}</div>
</article>`;
  }
  if (card.kind === "budget") {
    const s = card.stop;
    return html`<article class="panel card">
<div class="row"><span class="pill wait">⏸ budget · ${s.stepId}</span>${meta}</div>
<h3>${firstLine(run.task)}</h3>
<p>${s.stepId} stopped at ${amount(s.used)} of ${amount(s.cap)} ${unitOf(s.dimension)} — ${sourceOf(s)}.${card.granted ? html` <span class="ok">${grantText(s, card.granted)}</span>` : ""}</p>
<div class="actions">${resume}<a class="${primary}" href="${runHref(run)}">Open the run</a></div>
</article>`;
  }
  if (card.kind === "approval") {
    const facts = card.facts;
    const gist = facts
      ? [facts.counts.map((c) => c.text).join(" · "), facts.summary ? cut(facts.summary, 180) : ""]
          .filter(Boolean)
          .join(". ")
      : cut(card.excerpt ?? "", 180);
    return html`<article class="panel card">
<div class="row"><span class="pill info">⏸ approval · ${card.type}</span>${meta}</div>
<h3>${firstLine(run.task)}</h3>
${gist ? html`<p>${gist}</p>` : ""}
${card.decision ? html`<p class="ok">${decisionText(card)}${w.terminal ? " — the terminal goes on" : resume ? " — nothing goes on with it yet" : html` — the run waits for <code>jarvis continue</code>`}</p>` : ""}
<div class="actions">${resume}<a class="${primary}" href="${artifactHref(run, card.artifact)}">Review the ${card.type}</a><a class="btn" href="${runHref(run)}">Open the run</a></div>
</article>`;
  }
  if (card.kind === "clarify") {
    const question = card.messages.find((m) => m.role === "jarvis")?.text ?? "";
    return html`<article class="panel card">
<div class="row"><span class="pill wait">⏸ clarification · ${card.thread.stepId}</span>${meta}</div>
<h3>${firstLine(run.task)}</h3>
${question ? html`<p>${cut(question, 220)}</p>` : ""}
${card.proposal ? html`<p class="ok">Jarvis proposes a rule — accept it or answer on</p>` : ""}
<div class="actions"><a class="btn primary" href="${runHref(run)}#decision">Answer</a></div>
</article>`;
  }
  return html`<article class="panel card">
<div class="row"><span class="pill wait">⏸ ${card.what}</span>${meta}</div>
<h3>${firstLine(run.task)}</h3>
<p>Answer in the terminal: <code>jarvis continue ${shortRunId(run.id)}</code></p>
<div class="actions"><a class="btn primary" href="${runHref(run)}">Open the run</a></div>
</article>`;
}

function decisionText(card: ApprovalCard): string {
  const d = card.decision;
  if (!d) return "";
  const verb =
    d.approval.decision === "approve"
      ? "✓ accepted"
      : d.approval.decision === "reject"
        ? "✗ rejected"
        : "↻ sent back";
  return `${verb} by ${d.approval.actor.id}${d.channel === "ui" ? " in the browser" : d.channel === "cli" ? " in the terminal" : ""}`;
}

/**
 * A running clock: the server's value, then the page counts on every second (src/ui/assets.ts) — the
 * value came only with a refresh and jumped 15:27 → 15:30 → 15:32 (pilot).
 */
export function ticking(ms: number): Html {
  const at = Math.max(0, Math.round(ms));
  return html`<span data-ms="${String(at)}">${clock(at)}</span>`;
}

/** `model call 12, waiting 0:21, receiving ~1.1k tok`: what the step's agent does now. */
export function callText(a: Activity): Html {
  const step = a.step;
  if (!step) return html`starting…`;
  // the tools of the last answer still run: the model is not asked yet
  if (a.batch?.running)
    return html`model call ${a.batch.modelCall} asked for ${a.batch.size} tools · running them`;
  if (a.waitingMs === undefined)
    return html`${step.modelCalls} model call${step.modelCalls === 1 ? "" : "s"}`;
  const coming = a.receiving
    ? a.receiving.outputChars > 0
      ? `, receiving ~${kilo(Math.round(a.receiving.outputChars / 4))} tok`
      : `, thinking ~${kilo(Math.round(a.receiving.reasoningChars / 4))} tok`
    : "";
  const retry = a.retrying ? `, retry ${a.retrying.attempt} after ${a.retrying.reason}` : "";
  if (a.compacting)
    return html`${compactingText(a.compacting)}, ${ticking(a.compacting.ms)}${coming}${retry}`;
  return html`model call ${step.modelCalls + 1}, waiting ${ticking(a.waitingMs)}${coming}${retry}`;
}

/** `[8/18] implementation#2 · model call 12, waiting 0:21, receiving ~1.1k tok` */
function activityText(a: Activity | undefined, position?: { index: number; total: number }): Html {
  if (!a?.step) return html`starting…`;
  const pos = position ? `[${position.index}/${position.total}] ` : "";
  const step = `${pos}${a.step.id}${a.step.iteration > 1 ? `#${a.step.iteration}` : ""}${a.step.agent && a.step.agent !== a.step.id ? ` · ${a.step.agent}` : ""}`;
  return html`${step} · ${callText(a)}`;
}

function toolBudget(a: Activity | undefined, now: number): Html {
  const step = a?.step;
  const max = step?.maxToolCalls;
  const used = step?.toolCalls ?? 0;
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const since = step ? ticking(now - Date.parse(step.startedAt)) : "";
  return html`<div class="bar" role="img" aria-label="${max ? `${used} of ${max} tool calls used` : `${used} tool calls`}"><span style="width:${pct}%"></span></div>
<span class="meta">tools ${max ? `${used}/${max}` : used}${since ? html` · ${since}` : ""}${step && step.modelCalls > 1 && used > 0 ? html` · ${perCall(used, step.modelCalls, "tools per model call")}` : ""}</span>`;
}

function recentState(run: Run): Html {
  const why = run.stateReason ? ` · ${cut(run.stateReason, 48)}` : "";
  switch (run.state) {
    case "COMPLETED":
      return html`<span class="ok">✓ COMPLETED</span>`;
    case "FAILED":
      return html`<span class="bad">✗ FAILED${why}</span>`;
    case "CANCELLED":
      return html`<span class="muted">– CANCELLED${why}</span>`;
    case "RUNNING":
      return html`<span class="warn">⏸ interrupted · <code>jarvis resume</code></span>`;
    case "WAITING_BUDGET":
      return html`<span class="warn">⏸ waits for ${run.waitingFor?.kind === "model" ? "the model" : "quota"}</span>`;
    default:
      return html`<span class="muted">${run.state}${why}</span>`;
  }
}

export function repoPicker(page: RunsPage): Html {
  if (page.repos.length < 2) return html``;
  return html`<form class="repo" method="get" action="/"><label class="repo" for="repo">repository</label>
<select id="repo" name="repo" data-autosubmit>
<option value=""${page.repo ? "" : html` selected`}>all repositories</option>
${page.repos.map((r) => html`<option value="${r.root}"${r.root === page.repo ? html` selected` : ""}>${r.name} (${r.runs})</option>`)}
</select><button type="submit" class="btn sr">Show</button></form>`;
}

/** What the page started (src/ui/launcher.ts) and has no run of yet: preparing, or failed before one. */
export interface LaunchView {
  readonly id: string;
  readonly task: string;
  readonly workflow: string;
  readonly startedAt: string;
  readonly exitCode: number | null;
  readonly log: string;
  readonly tail?: string;
}

export interface StartForm {
  readonly workflows: ReadonlyArray<{ readonly id: string; readonly label: string; readonly about: string }>;
  readonly repos: readonly string[];
  readonly current?: string;
  readonly launches: readonly LaunchView[];
  readonly homeDir: string;
  readonly notice?: Html;
}

const home = (path: string, dir: string) =>
  dir && path.startsWith(`${dir}/`) ? `~${path.slice(dir.length)}` : path;

/** "New task": what to do, which workflow (research first), which repository — started as the CLI would be. */
function startHtml(start: StartForm, actions: Actions): Html {
  const repoField =
    start.repos.length > 1
      ? html`<label class="field">Repository<select name="repo">${start.repos.map((r) => html`<option value="${r}"${r === start.current ? " selected" : ""}>${home(r, start.homeDir)}</option>`)}</select></label>`
      : html`<input type="hidden" name="repo" value="${start.repos[0] ?? ""}"><span class="meta">in ${home(start.repos[0] ?? "", start.homeDir)}</span>`;
  return html`<section class="panel newtask" aria-labelledby="new-title" id="new">
${form(
  actions,
  "/runs/new",
  html`<h2 id="new-title">New task</h2>
<label class="field grow">What to do<textarea name="task" rows="3" required maxlength="4000" placeholder="ABC-123 — or in words: what to find out, or the bug to fix"></textarea></label>
<div class="row">
<label class="field">Workflow<select name="workflow">${start.workflows.map((w) => html`<option value="${w.id}"${w.id === start.workflows[0]?.id ? " selected" : ""}>${w.label} — ${w.about}</option>`)}</select></label>
${repoField}
<button type="submit" class="btn primary">Start</button>
</div>
<div class="startfrom" data-from aria-live="polite"></div>
<label class="check"><input type="checkbox" name="fresh" value="design"> Read the Figma frames again <span class="meta">— the design changed at the same link; past Jarvis's one-day cache, each frame is a Figma API call</span></label>
<p class="hint">Runs in the background, as <code>jarvis research "…"</code> (or the workflow chosen) would without a terminal; where it needs you, it waits here — decide on the page and it goes on.</p>`,
)}
</section>`;
}

/** `20:35` today, `Oct 3, 14:10` before. */
function whenShort(iso: string, now: number): string {
  const d = new Date(iso);
  const hm = wallClock(iso).slice(0, 5);
  return d.toDateString() === new Date(now).toDateString()
    ? hm
    : `${d.toLocaleString("en-US", { month: "short", day: "numeric" })}, ${hm}`;
}

/**
 * Under "New task", for a workflow a finished run can go on as (sdd): the research of the same issue
 * in the same repository to start from — ticked when the code it read has not changed since
 * (src/app/continuation.ts). Fetched as the task is typed (`GET /runs/from`).
 */
export function startFromHtml(
  point: StartPoint | undefined,
  input: { readonly task: string; readonly workflow: string; readonly targets: ReadonlySet<string> },
  now: number,
): Html {
  if (!input.targets.has(input.workflow) || !input.task.trim()) return html``;
  const key = issueKeyOf(input.task);
  if (!point)
    return html`<p class="hint">No finished research of ${key ?? "this task"} in this repository — ${input.workflow} runs from the start.</p>`;
  const r = point.run;
  const stale = isStale(point);
  const facts = [
    shortRunId(r.id),
    ...(point.contradictions > 0 ? [plural(point.contradictions, "contradiction")] : []),
    ...(point.since && !stale
      ? [
          point.since.commits === 0
            ? "no new commits since"
            : `${plural(point.since.commits, "commit")} since, none touch what it read`,
        ]
      : []),
    ...(point.since ? [] : ["can't tell whether the code changed since"]),
  ];
  const touched = point.since?.touched ?? [];
  const shown = touched.slice(0, 3);
  return html`<div class="from">
<label class="check"><input type="checkbox" name="from" value="${r.id}"${stale ? "" : " checked"}> <span><b>Start from the ${r.workflow} of ${whenShort(r.updatedAt, now)}</b> <span class="meta">— ${facts.join(" · ")}</span></span></label>
${
  stale
    ? html`<p class="sub warn">⚠ code changed since: ${plural(point.since?.commits ?? 0, "commit")}, ${plural(touched.length, "file")} it read among them (${shown.map((f, i) => html`${i > 0 ? ", " : ""}<code>${f}</code>`)}${touched.length > shown.length ? ", …" : ""}) — a new research is safer</p>`
    : ""
}
<p class="sub hint">${stale ? `Unchecked: ${input.workflow} runs from the start, with a new research.` : `${input.workflow} begins at ${point.continuation.startAt} with it; the steps it did are not run again.`} <a href="/runs/${shortRunId(r.id)}" target="_blank" rel="noopener">Open the ${r.workflow}</a></p>
</div>`;
}

function launchHtml(l: LaunchView, now: number, homeDir: string): Html {
  return html`<a class="launch-link" href="/launches/${l.id}">${launchRow(l, now, homeDir)}</a>`;
}

function launchRow(l: LaunchView, now: number, homeDir: string): Html {
  const age = ticking(now - Date.parse(l.startedAt));
  if (l.exitCode !== null)
    return html`<div class="panel running launch failed">
<div class="what"><b>${firstLine(l.task)}</b><span class="meta">${l.workflow} · ${l.exitCode === 0 ? "ended without a run" : `failed to start (exit ${l.exitCode})`} · log ${home(l.log, homeDir)}</span>
${l.tail ? html`<pre class="tail">${l.tail}</pre>` : ""}</div></div>`;
  return html`<div class="panel running launch">
<div class="what"><b>${firstLine(l.task)}</b><span class="meta">${l.workflow} · starting ${age} · preparing the checkout (a workspace setup can take minutes) · log ${home(l.log, homeDir)}</span></div>
<span class="spin" aria-hidden="true"></span></div>`;
}

export function runsContent(page: RunsPage, now: number, actions?: Actions, start?: StartForm): Html {
  const waits = page.waiting.length + page.candidates.length;
  const sum = [
    `${waits} wait${waits === 1 ? "s" : ""} for you`,
    `${page.running.length} running`,
    `${page.today.runs} today`,
    `${page.today.modelCalls} model call${page.today.modelCalls === 1 ? "" : "s"} today`,
  ].join(" · ");
  const launches = start?.launches ?? [];
  return html`<div class="lede" data-live="lede"><h1>Runs</h1><span class="muted">${sum}</span></div>
${start?.notice ?? ""}
${start && actions ? startHtml(start, actions) : ""}
<section class="group" aria-labelledby="waits" data-live="waiting">
<h2 id="waits">Waits for you</h2>
${
  waits > 0
    ? html`<div class="cards">${page.waiting.map((w) => waitingCardHtml(w, now, actions))}${page.candidates.map((c) => candidateCardHtml(c, now))}</div>`
    : html`<div class="panel empty">Nothing waits for you.</div>`
}
</section>
<section class="group" aria-labelledby="running" data-live="running">
<h2 id="running">Running</h2>
${launches.map((l) => launchHtml(l, now, start?.homeDir ?? ""))}
${
  page.running.length > 0 || launches.length > 0
    ? page.running.map((r) =>
        r.wait
          ? html`<div class="panel running paused">
<div class="what"><a href="${runHref(r.run)}">${firstLine(r.run.task)}</a><span class="meta">${r.run.workflow} · ${shortRunId(r.run.id)} · ⏸ ${r.wait.kind === "model" ? `waits for the model ${r.wait.model ?? ""}` : `waits for the quota window${r.wait.pool ? ` of ${r.wait.pool}` : ""}`} · goes on ${whenText(r.wait.resumeAfter, now)}</span></div>
<a href="${runHref(r.run)}">Open</a>
</div>`
          : html`<div class="panel running">
<div class="what"><a href="${runHref(r.run)}">${firstLine(r.run.task)}</a><span class="meta">${cancelling(r.run) ? html`<span class="bad">cancelling…</span> · ` : ""}${r.run.workflow} · ${shortRunId(r.run.id)} · ${activityText(r.activity, r.position)}</span></div>
<div class="budget">${toolBudget(r.activity, now)}</div>
<a href="${runHref(r.run)}">Follow</a>
</div>`,
      )
    : html`<div class="panel empty">Nothing runs now.</div>`
}
</section>
<section class="group" aria-labelledby="recent">
<div class="group-head"><h2 id="recent">Recent</h2>
<form class="search" role="search" method="get" action="/">
<input type="search" name="q" value="${page.recent.query}" placeholder="Search runs: id, task, state…" title="Every word in some field: id, task, workflow, state and its reason, author, repository, branch, step, date; a quoted phrase as a whole" aria-label="Search runs" autocomplete="off" data-search>
<input type="hidden" name="repo" value="${page.repo ?? ""}"><button type="submit" class="btn sr">Search</button>
</form></div>
${recentHtml(page)}
</section>`;
}

/** Recent: one page of the finished runs (all of them, or those matching the search), and the way on. */
function recentHtml(page: RunsPage): Html {
  const list = page.recent;
  const href = (n: number, size = list.pageSize) => {
    const q = new URLSearchParams();
    if (list.query) q.set("q", list.query);
    q.set("repo", page.repo ?? "");
    if (size !== RECENT_PAGE) q.set("size", String(size));
    if (n > 1) q.set("page", String(n));
    return `/?${q.toString()}#recent`;
  };
  const from = (list.page - 1) * list.pageSize + 1;
  const to = from + list.runs.length - 1;
  const last = Math.max(1, Math.ceil(list.total / list.pageSize));
  // how many rows: shown while there is more than the smallest page, the page goes back to the first
  const sizes =
    list.total > RECENT_SIZES[0]
      ? html`<div class="sizes" role="group" aria-label="Rows per page">${RECENT_SIZES.map((n) =>
          n === list.pageSize
            ? html`<a href="${href(1, n)}" data-size="${String(n)}" aria-current="true">${String(n)}</a>`
            : html`<a href="${href(1, n)}" data-size="${String(n)}">${String(n)}</a>`,
        )}</div>`
      : html``;
  const pages =
    list.total > list.pageSize
      ? html`<span class="pages">${list.page > 1 ? html`<a href="${href(list.page - 1)}" rel="prev">← Newer</a>` : html`<span class="muted">← Newer</span>`}<span class="muted">${from}–${to} of ${list.total}</span>${list.page < last ? html`<a href="${href(list.page + 1)}" rel="next">Older →</a>` : html`<span class="muted">Older →</span>`}</span>`
      : list.query && list.total > 0
        ? html`<span class="pages muted">${list.total} found</span>`
        : html``;
  const pager =
    list.total > RECENT_SIZES[0] || (list.query && list.total > 0)
      ? html`<nav class="pager" aria-label="Recent runs, pages">${sizes}${pages}</nav>`
      : html``;
  const body =
    list.runs.length > 0
      ? html`<div class="panel scroll recent"><table>
<thead><tr><th scope="col">Run</th><th scope="col">Task</th><th scope="col">Workflow</th><th scope="col">State</th><th scope="col">Took</th><th scope="col">Model</th></tr></thead>
<tbody>${list.runs.map(
          (r) =>
            html`<tr><td class="mono"><a href="${runHref(r.run)}">${marked(shortRunId(r.run.id), list.terms)}</a></td><td>${marked(firstLine(r.run.task, 90), list.terms)}</td><td>${marked(r.run.workflow, list.terms)}</td><td>${recentState(r.run)}</td><td>${duration(r.tookMs)}</td><td class="muted">${r.modelCalls} call${r.modelCalls === 1 ? "" : "s"}</td></tr>`,
        )}</tbody></table></div>`
      : list.query
        ? html`<div class="panel empty">No runs match «${list.query}».</div>`
        : html`<div class="panel empty">No runs yet.</div>`;
  return html`<div data-live="recent">${body}${pager}</div>`;
}

/** The text with what the search matched marked, every match of every term (case aside). */
export function marked(text: string, terms: readonly string[]): Html {
  const wanted = terms.filter((t) => t.length > 0);
  if (wanted.length === 0) return html`${text}`;
  const lower = text.toLowerCase();
  const hits: Array<[number, number]> = [];
  for (const t of wanted)
    for (let at = lower.indexOf(t); at >= 0; at = lower.indexOf(t, at + t.length))
      hits.push([at, at + t.length]);
  if (hits.length === 0) return html`${text}`;
  hits.sort((a, b) => a[0] - b[0]);
  const parts: Html[] = [];
  let pos = 0;
  for (const [a, b] of hits) {
    if (b <= pos) continue;
    const start = Math.max(a, pos);
    parts.push(html`${text.slice(pos, start)}<mark>${text.slice(start, b)}</mark>`);
    pos = b;
  }
  parts.push(html`${text.slice(pos)}`);
  return join(parts);
}

/** `⇉ 2.6 tools per model call`: how much an agent asks for at once (the fewer model calls, the faster). */
function perCall(tools: number, calls: number, label: string): Html {
  return html`<span class="kpi" title="tool calls per model call: independent reads in one turn">⇉ ${(tools / calls).toFixed(1)} ${label}</span>`;
}

/** `repo.read` → `read`, `confluence.get` → `confluence`: what a lane did, short. */
function verbOf(capability: string): string {
  return capability.replace(/^repo\./, "").replace(/\.get$/, "");
}

/** `12ms`, `0.4s`, `3.1s`. */
function quick(ms: number): string {
  return ms < 100 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The tools of one answer as lanes on one clock: which ran side by side, which held the batch up. */
function batchHtml(b: ToolBatch): Html {
  const total = Math.max(1, b.ms);
  const done = b.calls.filter((c) => c.ok !== undefined).length;
  const head = b.parallel ? `⇉ ${b.size} in parallel` : `${b.size} in a row`;
  const state = b.running
    ? `· ${quick(b.ms)} so far · ${done} done`
    : `· the last batch, model call ${b.modelCall} · ${quick(b.ms)}`;
  return html`<div class="batch${b.running ? "" : " past"}" role="group" aria-label="${head}">
<div class="bh"><b>${head}</b><span>${state}</span></div>
${b.calls.slice(0, 12).map((c) => {
  const left = Math.min(100, (c.startMs / total) * 100);
  const width = Math.max(2, Math.min(100 - left, (c.ms / total) * 100));
  const mark =
    c.ok === undefined
      ? html`<span class="spin" aria-label="running"></span>`
      : c.ok
        ? html`<span class="ok">✓</span>`
        : html`<span class="bad">✗</span>`;
  return html`<div class="lane">${mark}<span class="k">${verbOf(c.capability)}</span><span class="p">${c.detail ?? ""}</span><span class="track"><span${c.ok === undefined ? html` class="run"` : ""} style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></span></span><span class="t">${quick(c.ms)}${c.ok === undefined ? "…" : ""}</span></div>`;
})}
</div>`;
}

/* ---- one run ---- */

function stepRow(s: StepRow, now: number): Html {
  const icon = {
    done: ["✓", "ok"],
    failed: ["✗", "bad"],
    skipped: ["–", "muted"],
    running: ["◌", "info"],
    waiting: ["⏸", "warn"],
    pending: ["·", "muted"],
  }[s.status];
  const r = s.last;
  const iteration = r && r.iteration > 1 ? `#${r.iteration}` : "";
  const notes: string[] = [];
  if (r && s.status !== "skipped") {
    if (r.quick?.used) notes.push(`${r.quick.tool}, no model call`);
    else if (r.agent) notes.push(r.agent);
    if (r.modelCalls > 0) notes.push(`${r.modelCalls} call${r.modelCalls === 1 ? "" : "s"}`);
    if (r.tools && Object.keys(r.tools).length > 0) notes.push(toolMix(r.tools));
    const tools = r.tools ? Object.values(r.tools).reduce((n, k) => n + k, 0) : 0;
    if (tools > 0 && r.modelCalls > 1) notes.push(`⇉ ${(tools / r.modelCalls).toFixed(1)} per call`);
    if (r.contradictions)
      notes.push(
        `⚠ ${r.contradictions} contradiction${r.contradictions === 1 ? "" : "s"} in the requirements`,
      );
    if (r.budgetExhausted)
      notes.push(
        `${r.budgetExhausted === "model" ? "model call" : r.budgetExhausted === "budget" ? "budget" : "tool"} limit reached`,
      );
    // the loop's line names the outcome already
    if (r.outcome && r.outcome !== "success" && s.loops.at(-1)?.outcome !== r.outcome) notes.push(r.outcome);
    if (r.status !== "success" && r.reason) notes.push(cut(r.reason, 120));
  }
  if (s.status === "skipped" && r?.reason) notes.push(`skipped: ${r.reason}`);
  if (s.carriedFrom) notes.unshift(`done in ${s.carriedFrom.workflow} ${shortRunId(s.carriedFrom.id)}`);
  const loop = s.loops.at(-1);
  if (loop)
    notes.push(
      `sent the work back to ${loop.to} ${loop.iteration}${loop.max ? `/${loop.max}` : ""} — ${loop.outcome}`,
    );
  if (s.status === "waiting") notes.push(s.paused ? "paused · waits for the quota window" : "waits for you");
  if (s.status === "running") notes.push("running now");
  const took =
    s.status === "running" && s.startedAt
      ? ticking(now - Date.parse(s.startedAt))
      : r && s.status !== "skipped"
        ? duration(r.durationMs)
        : "";
  const tone = icon?.[1] === "info" ? "" : icon?.[1];
  return html`<li class="step ${s.status}${s.child ? " child" : ""}${s.status === "waiting" || s.status === "running" ? " focus" : ""}">
<span class="ic ${tone ?? ""}" aria-hidden="true">${icon?.[0] ?? ""}</span>
<span class="nm"><b>${s.id}${iteration}<span class="sr"> — ${s.status}</span></b>${notes.length > 0 ? html`<span class="note">${notes.join(" · ")}</span>` : ""}</span>
<span class="took">${took}</span>
</li>`;
}

function loopCardHtml(card: LoopCard, page: RunPage, actions?: Actions): Html {
  const route = card.from ? `${card.from} → ${card.to} · ${card.outcome} · ` : "";
  return html`<section class="panel decision" aria-labelledby="decision" data-live="card">
<div class="row" style="flex-direction:column;align-items:flex-start;gap:4px">
<span class="warn" style="font-size:13px;font-weight:500">Waits for you</span>
<h2 id="decision" style="font-size:22px;line-height:28px">${card.step} sent the work back ${card.iterations ? `${card.iterations} times` : "too often"} — no rounds left</h2>
<span class="muted" style="font-size:14px">${route}the last round's reasons:</span>
</div>
${
  card.reasons.length > 0
    ? html`<ul class="reasons">${card.reasons.map((r) => html`<li>${r.kind ? html`<span class="chip">${r.kind}</span>` : ""}<span>${r.text}</span></li>`)}</ul>`
    : html`<p class="muted">No reason recorded.</p>`
}
<div class="checkout">
<span class="muted" style="font-size:14px">Fix it by hand in the run's checkout</span>
<div class="row"><code class="path">${card.checkoutShown}</code>${actions ? form(actions, `${runHref(page.run)}/open`, html`<button type="submit" class="btn">Open in editor</button>`) : ""}<button type="button" class="btn" data-copy="${card.checkout}">Copy path</button></div>
<div class="changed" aria-live="polite"><span class="hint">Changed in the checkout · live</span>${
    card.changes && card.changes.length > 0
      ? card.changes.slice(0, 12).map(changeLine)
      : html`<span class="muted">nothing yet</span>`
  }${card.changes && card.changes.length > 12 ? html`<span class="muted">+${card.changes.length - 12} more</span>` : ""}</div>
</div>
${
  card.rerun
    ? html`<div class="banner info">↻ ${card.step} runs again — asked${card.rerun.actor ? ` by ${card.rerun.actor}` : ""}${card.rerun.channel === "ui" ? " from the page" : card.rerun.channel === "cli" ? " in the terminal" : ""}</div><div class="actions">${goesOn(page, actions)}</div>`
    : actions
      ? html`<div class="actions">${form(actions, `${runHref(page.run)}/rerun`, html`<button type="submit" class="btn primary big">Run ${card.step} again</button>`)}<span class="hint">same as <code>r</code> on the terminal's card; ${page.terminal ? "the terminal waiting there goes on" : html`no terminal waits: <code>jarvis continue ${shortRunId(page.run.id)}</code> does it`}</span></div>`
      : terminalHint(card, page.terminal, page.run)
}
</section>`;
}

const amount = (n: number) => n.toLocaleString("en-US");

function grantText(s: BudgetStop, g: NonNullable<BudgetCard["granted"]>): string {
  const what = g.finish
    ? `${s.stepId} finishes with what it has`
    : `+${amount(g.amount ?? 0)} ${unitOf(s.dimension)}`;
  const where = g.channel === "ui" ? " from the page" : g.channel === "cli" ? " in the terminal" : "";
  return `↻ ${what} — decided${g.actor ? ` by ${g.actor}` : ""}${where}`;
}

/** The run stopped on a budget: what ran out, then more and go on, or finish with what it has. */
function budgetCardHtml(card: BudgetCard, page: RunPage, actions?: Actions): Html {
  const s = card.stop;
  const unit = unitOf(s.dimension);
  const action = `${runHref(page.run)}/budget`;
  return html`<section class="panel decision" aria-labelledby="decision" data-live="card">
<div class="row" style="flex-direction:column;align-items:flex-start;gap:4px">
<span class="warn" style="font-size:13px;font-weight:500">Waits for you</span>
<h2 id="decision" style="font-size:22px;line-height:28px">${s.stepId} stopped: ${amount(s.used)} of ${amount(s.cap)} ${unit}</h2>
<span class="muted" style="font-size:14px">${sourceOf(s)} · ${
    s.scope === "agent"
      ? "its conversation is kept: more calls go on from where it stopped"
      : "the step goes on from its last model call; the cap grows for this run only"
  }</span>
</div>
${
  card.changes && card.changes.length > 0
    ? html`<div class="changed"><span class="hint">Changed in the checkout so far</span>${card.changes.slice(0, 12).map(changeLine)}${card.changes.length > 12 ? html`<span class="muted">+${card.changes.length - 12} more</span>` : ""}</div>`
    : ""
}
${
  card.granted
    ? html`<div class="banner info">${grantText(s, card.granted)}</div><div class="actions">${goesOn(page, actions)}</div>`
    : actions
      ? html`<div class="actions">${form(
          actions,
          action,
          html`<input type="hidden" name="choice" value="more"><input type="hidden" name="amount" value="${s.suggested}"><button type="submit" class="btn primary big">+${amount(s.suggested)} ${unit} and go on</button>`,
        )}${form(
          actions,
          action,
          html`<input type="hidden" name="choice" value="more"><label class="sr" for="budget-amount">How many more ${unit}</label><input id="budget-amount" class="amount" type="number" name="amount" min="1" step="1" required placeholder="another amount"><button type="submit" class="btn">Grant</button>`,
          html` class="row"`,
        )}${form(
          actions,
          action,
          html`<input type="hidden" name="choice" value="finish"><button type="submit" class="btn">Finish with what it has</button>`,
        )}</div>
<p class="hint">Finish: the step writes its result from what it has, marked incomplete for the steps after it. Same as <code>enter</code> / <code>m</code> / <code>f</code> on the terminal's card; ${page.terminal ? "the terminal waiting there goes on" : html`no terminal waits: <code>jarvis continue ${shortRunId(page.run.id)}</code> goes on`}.</p>`
      : terminalHint(card, page.terminal, page.run)
}
</section>`;
}

/** The brief of a gated document, as the terminal's card shows it before the decision. */
function briefHtml(card: ApprovalCard): Html {
  const f = card.facts;
  const partial = incompleteOf(card.artifact);
  return html`${f?.summary ? html`<p>${cut(f.summary, 320)}</p>` : ""}
${
  f && f.counts.length > 0
    ? html`<p class="muted">${join(
        f.counts.map((c) => (c.warn ? html`<span class="warn">${c.text}</span>` : c.text)),
        " · ",
      )}</p>`
    : ""
}
${f?.risks.slice(0, 2).map((r) => html`<p><span class="warn">risk</span> ${cut(r, 160)}</p>`) ?? ""}
${card.excerpt ? html`<pre class="path" style="white-space:pre-wrap">${card.excerpt}</pre>` : ""}
${partial ? html`<p class="warn">⚠ incomplete: agent ${partial.agentId} hit its ${partial.limit} limit</p>` : ""}
${
  card.files && card.files.length > 0
    ? html`<div class="changed"><span class="hint">${card.files.length} file${card.files.length === 1 ? "" : "s"} changed</span>${card.files
        .slice(0, 8)
        .map(
          (x) =>
            html`<span><span class="ok">+${x.added}</span> <span class="bad">−${x.removed}</span> ${x.path}</span>`,
        )}${card.files.length > 8 ? html`<span class="muted">+${card.files.length - 8} more</span>` : ""}</div>`
    : ""
}`;
}

function approvalCardHtml(card: ApprovalCard, page: RunPage, actions?: Actions): Html {
  const title = card.facts?.title ?? `${card.type}/${card.artifact.name}`;
  return html`<section class="panel decision" aria-labelledby="decision" data-live="card">
<div class="row" style="flex-direction:column;align-items:flex-start;gap:4px">
<span class="warn" style="font-size:13px;font-weight:500">Waits for you · approve ${card.type}</span>
<h2 id="decision" style="font-size:22px;line-height:28px">${title}</h2>
<span class="meta">${card.type}/${card.artifact.name}@${card.artifact.version}</span>
</div>
${briefHtml(card)}
${card.decision ? html`<div class="banner ok">${decisionText(card)}</div><div class="actions">${goesOn(page, actions)}</div>` : ""}
<div class="actions"><a class="btn primary big" href="${artifactHref(page.run, card.artifact)}">Review the ${card.type}</a></div>
${card.decision ? "" : terminalHint(card, page.terminal, page.run)}
</section>`;
}

/** Cancel, in two clicks (no dialogs): as `jarvis cancel` — at once when idle, else at the next safe point. */
function cancelHtml(run: Run, actions: Actions): Html {
  const short = shortRunId(run.id);
  const busy = run.lease !== undefined && Date.parse(run.lease.until) >= Date.now();
  return html`<details class="cancel" data-dismiss><summary class="btn small danger">Cancel run…</summary>
<div class="cancel-pop" role="dialog" aria-label="Cancel run ${short}">
<p><b>Cancel run ${short}?</b></p>
<p class="hint">${busy ? "A process runs it: it stops after its current model or tool call." : "Nothing runs it now: it is cancelled at once."} The checkout and the artifacts stay; it cannot be resumed.</p>
${form(
  actions,
  `/runs/${encodeURIComponent(short)}/cancel`,
  html`<div class="row"><button type="submit" class="btn small danger-fill">Cancel the run</button><button type="button" class="btn small" data-close>Keep it</button></div>`,
)}
</div>
</details>`;
}

/** A run parked on a quota window or a model: not failed — when it goes on, and who resumes it. */
function waitHtml(page: RunPage, wait: BudgetWait, now: number, actions?: Actions): Html {
  const short = shortRunId(page.run.id);
  const what =
    wait.kind === "model"
      ? html`Waits for the model <code>${wait.model ?? "?"}</code> to answer again`
      : html`Waits for the quota window${wait.pool ? html` of pool <code>${wait.pool}</code>` : ""}`;
  const who = page.driven
    ? html`<span class="hint">This page resumes it then — keep <code>jarvis ui</code> open.</span>`
    : html`<span class="hint">No process waits for it: resume it here, or <code>jarvis resume ${short}</code>.</span>`;
  return html`<section class="panel decision budgetwait" aria-labelledby="wait-h" data-live="card">
<div class="row"><span class="pill wait">⏸ paused, not failed</span><h2 id="wait-h">${what}</h2></div>
<p>Goes on by itself at <b>${whenText(wait.resumeAfter, now)}</b>.${wait.detail ? html` <span class="hint">Window: ${wait.detail}.</span>` : ""}</p>
<div class="actions">${who}${
    actions
      ? html`<form method="post" action="/runs/${encodeURIComponent(short)}/resume"><input type="hidden" name="t" value="${actions.token}"><button type="submit" class="btn">Resume now</button></form><span class="hint">tries at once — if the window is still full, it waits again</span>`
      : html`<button type="button" class="btn" data-copy="jarvis resume ${short}">Copy command</button>`
  }</div>
</section>`;
}

function nowHtml(page: RunPage, now: number, actions?: Actions): Html {
  const a = page.activity;
  if (!a?.step || !page.leaseLive) {
    const stopped =
      page.run.state === "SUSPENDED"
        ? "stopped with Ctrl-C — it goes on from where it stopped"
        : page.run.state === "RUNNING"
          ? "no process drives this run (interrupted or crashed)"
          : undefined;
    // an empty region, not none: the live refresh replaces it, so a finished run's spinner goes away
    if (!stopped) return html`<div data-live="card" hidden></div>`;
    const cmd = `jarvis resume ${shortRunId(page.run.id)}`;
    return html`<section class="panel now" aria-label="Now" data-live="card"><div class="row"><span class="warn">⏸ ${stopped}</span></div>
<div class="actions">${
      page.resumable && actions
        ? html`${resumeForm(actions, page.run)}<span class="hint">goes on in the background, or <code>${cmd}</code> in a terminal</span>`
        : html`<span class="hint">Go on with <code>${cmd}</code></span><button type="button" class="btn" data-copy="${cmd}">Copy command</button>`
    }</div></section>`;
  }
  const last = a.lastTool
    ? `last: ${a.lastTool.capability}${a.lastTool.detail ? ` ${a.lastTool.detail}` : ""}${a.lastTool.ok ? "" : " ✗"}`
    : "";
  return html`<section class="panel now" aria-label="Now" data-live="card">
<div class="row"><span class="spin" aria-hidden="true"></span><b>${a.step.id}${a.step.iteration > 1 ? `#${a.step.iteration}` : ""}${a.step.agent && a.step.agent !== a.step.id ? ` · ${a.step.agent}` : ""}</b><span class="meta">${ticking(now - Date.parse(a.step.startedAt))} · ${callText(a)}</span></div>
${a.batch ? batchHtml(a.batch) : ""}
${toolBudget(a, now)}
${last ? html`<span class="meta">${last}</span>` : ""}
</section>`;
}

/** Lines of Activity shown open; the rest of the run's feed is one click away. */
export const FEED_SHOWN = 5;

function feedLine(f: FeedItem): Html {
  return f.sub
    ? html`<li><time datetime="${f.ts}">${wallClock(f.ts)}</time><div class="grp"><span>${f.text}</span>${f.sub.map((c) => html`<span class="sub${c.tone ? ` ${c.tone}` : ""}">${c.text}</span>`)}</div></li>`
    : html`<li><time datetime="${f.ts}">${wallClock(f.ts)}</time><span${f.tone ? html` class="${f.tone}"` : ""}>${f.text}</span></li>`;
}

/** The newest few lines, and above them everything earlier, folded (it stays open across live refreshes). */
function feedHtml(feed: readonly FeedItem[]): Html {
  const earlier = feed.slice(0, Math.max(0, feed.length - FEED_SHOWN));
  const recent = feed.slice(-FEED_SHOWN);
  return html`<section class="panel feed" aria-labelledby="activity" data-live="feed">
<h2 id="activity">Activity</h2>
${
  feed.length > 0
    ? html`${
        earlier.length > 0
          ? html`<details class="earlier" data-keep="feed-earlier"><summary>${earlier.length} earlier</summary><ol>${earlier.map(feedLine)}</ol></details>`
          : ""
      }<ol>${recent.map(feedLine)}</ol>`
    : html`<p class="muted">Nothing yet.</p>`
}
</section>`;
}

export function runContent(page: RunPage, now: number, actions?: Actions, notice?: Html): Html {
  const r = page.run;
  const t = page.tokens;
  const extra =
    r.state === "WAITING_HUMAN"
      ? (r.waitingFor?.kind ?? undefined)
      : r.state === "RUNNING" && page.activity?.step
        ? `${page.activity.step.id}${page.activity.step.iteration > 1 ? `#${page.activity.step.iteration}` : ""}`
        : undefined;
  const meta = [
    r.workflow,
    `run ${shortRunId(r.id)}`,
    duration(page.workedMs),
    `${t.calls} model call${t.calls === 1 ? "" : "s"}`,
    ...(t.calls > 0 ? [`in ${kilo(t.promptTokens)} · out ${kilo(t.outputTokens)} tok`] : []),
  ].join(" · ");
  const card = page.card;
  const rest = r.task.split("\n").slice(1).join("\n").trim();
  return html`<div class="lede-col" style="display:flex;flex-direction:column;gap:8px" data-live="head">
<div class="row">${statePill(r, extra)}<span class="meta" style="font-size:13px">${meta}</span></div>
<div class="runtitle">
<div class="runtext">
<h1>${firstLine(r.task, 300)}</h1>
${rest ? html`<p class="muted" style="white-space:pre-wrap">${cut(rest, 600)}</p>` : ""}
${r.stateReason && r.state !== "RUNNING" && r.state !== "WAITING_BUDGET" ? html`<p class="muted">${r.stateReason}</p>` : ""}
${page.continuedFrom ? continuedFromHtml(page.continuedFrom) : ""}
</div>
${actions && !isTerminal(r.state) ? (cancelling(r) ? html`<span class="btn small danger" aria-disabled="true">Cancelling…</span>` : cancelHtml(r, actions)) : ""}
</div>
</div>
${notice ?? ""}
${cancelling(r) ? html`<div class="banner bad" data-live="cancelling" role="status"><span class="spin" aria-hidden="true"></span> Cancelling — the run stops after its current model or tool call (a model call can take a minute or two); then it is CANCELLED, its checkout and artifacts stay</div>` : html`<div data-live="cancelling" hidden></div>`}
<div class="cols">
<section class="panel side steps" aria-labelledby="steps" data-live="steps">
<h2 id="steps">Steps</h2>
<ol style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px">${page.steps.map((s) => stepRow(s, now))}</ol>
</section>
<div class="mainc">
${card ? (card.kind === "loop" ? loopCardHtml(card, page, actions) : card.kind === "approval" ? approvalCardHtml(card, page, actions) : card.kind === "budget" ? budgetCardHtml(card, page, actions) : card.kind === "clarify" ? clarifyCardHtml(card, page, actions) : otherCardHtml(card.what, page)) : page.wait ? waitHtml(page, page.wait, now, actions) : page.next || page.continuedBy ? continuationHtml(page, actions) : nowHtml(page, now, actions)}
${feedHtml(page.feed)}
<section class="panel arts" aria-labelledby="artifacts" data-live="arts">
<h2 id="artifacts">Artifacts</h2>
${
  page.artifacts.length > 0
    ? html`<ul>${page.artifacts.map(
        (a) =>
          html`<li><a href="${artifactHref(r, a)}">${a.type}/${a.name}@${a.version}</a><span class="meta">${a.stepId ?? "-"}${a.iteration && a.iteration > 1 ? `#${a.iteration}` : ""}</span>${a.state ? html`<span class="${a.state === "approved" ? "ok" : "warn"}" style="font-size:13px">${a.state}</span>` : ""}</li>`,
      )}</ul>`
    : html`<p class="muted">No artifacts yet.</p>`
}
</section>
</div>
</div>`;
}

/** The new run's line: where it came from and what it brought. */
function continuedFromHtml(from: NonNullable<RunPage["continuedFrom"]>): Html {
  const carried =
    from.contradictions > 0 ? ` · ${plural(from.contradictions, "contradiction")} carried over` : "";
  return html`<p class="muted">continued from <a href="/runs/${shortRunId(from.id)}">${from.workflow} ${shortRunId(from.id)}</a>${carried}</p>`;
}

/**
 * A finished research/spec: "Continue to sdd" (as `jarvis continue <run>`), or where it went on.
 * Pilot: a research ended and going on took a terminal.
 */
function continuationHtml(page: RunPage, actions?: Actions): Html {
  const r = page.run;
  const by = page.continuedBy;
  if (by) {
    const where =
      by.state === "COMPLETED"
        ? "completed"
        : by.step
          ? `${by.step} · ${by.state.toLowerCase().replace("_", " ")}`
          : by.state.toLowerCase();
    return html`<section class="panel card" aria-label="Continued" data-live="card">
<div class="row"><span class="pill info">→ continued in ${by.workflow}</span><span class="meta">run ${shortRunId(by.id)} · started ${wallClock(by.createdAt).slice(0, 5)} · ${where}</span></div>
<p>This ${r.workflow} is the input of that run; it can't be continued twice.</p>
<div class="actions"><a class="btn primary" href="/runs/${shortRunId(by.id)}">Open the ${by.workflow} run</a></div>
</section>`;
  }
  const next = page.next;
  if (!next) return html`<div data-live="card" hidden></div>`;
  const cmd = `jarvis continue ${shortRunId(r.id)}`;
  const carried = [
    "its findings",
    ...(next.contradictions > 0 ? [plural(next.contradictions, "contradiction")] : []),
    "the dependencies",
  ];
  const approval = next.rest.includes("spec")
    ? "; the spec waits for your approval before any code is written"
    : "";
  return html`<section class="panel decision" aria-labelledby="decision" data-live="card">
<span class="ok" style="font-size:13px;font-weight:500">${r.workflow === "spec" ? "The spec is approved" : "Research is done"}</span>
<h2 id="decision">Take it into the full cycle</h2>
<p>${next.workflow} starts at <b>${next.startAt}</b> with this ${r.workflow}: ${carried.join(", ")} go in as they are — the steps done here do not run again.</p>
<p>Then ${next.rest.join(" → ")}${approval}.</p>
<div class="actions">${
    actions?.canLaunch
      ? html`${form(actions, `/runs/${shortRunId(r.id)}/continue`, html`<button type="submit" class="btn primary big">Continue to ${next.workflow}</button>`)}<span class="hint">same as <code>${cmd}</code></span>`
      : html`<span class="hint">Go on with <code>${cmd}</code></span><button type="button" class="btn" data-copy="${cmd}">Copy command</button>`
  }</div>
</section>`;
}

/**
 * A clarification thread answered on the page (ADR-0019 §4): the same moves as `jarvis attach` — an
 * answer (Jarvis asks on or proposes the rule), accepting the proposed rule, or a rule of one's own.
 */
function clarifyCardHtml(card: ClarifyCard, page: RunPage, actions?: Actions): Html {
  const r = page.run;
  const step = card.thread.stepId;
  const p = card.proposal;
  const turns = card.messages.map(
    (m) =>
      html`<li class="msg ${m.role}"><span class="who">${m.role === "jarvis" ? "Jarvis" : m.actor}</span><div class="said">${m.proposal ? m.text.replace(/\n+Proposed rule: [\s\S]*$/, "") : m.text}</div></li>`,
  );
  const list = (title: string, items: readonly string[]) =>
    items.length > 0
      ? html`<p class="meta">${title}</p><ul>${items.map((x) => html`<li>${x}</li>`)}</ul>`
      : "";
  const rule = p
    ? html`<div class="rule"><span class="meta">Proposed rule</span><p><b>${p.rule}</b></p>${list("Requirement corrections", p.requirementCorrections)}${list("Assumptions", p.assumptions)}</div>`
    : "";
  const thinking = card.thinking
    ? html`<div class="row"><span class="spin" aria-hidden="true"></span><span class="meta">Jarvis thinks over your answer: asks on or proposes the rule</span></div>`
    : "";
  const cmd = `jarvis continue ${shortRunId(r.id)}`;
  const moves = actions
    ? form(
        actions,
        `${runHref(r)}/clarify`,
        html`${
          card.exhausted
            ? html`<p class="hint">The thread's turns are used up (<code>human.clarification.maxTurns</code>): accept the proposed rule or write the rule yourself.</p>`
            : html`<label class="field grow">Your answer<textarea name="text" rows="3" maxlength="4000" placeholder="Answer the question: Jarvis asks on or proposes the rule"${card.thinking ? " disabled" : ""}></textarea></label>`
        }
<div class="actions">${card.exhausted ? "" : html`<button type="submit" name="move" value="say" class="${p ? "btn" : "btn primary"}"${card.thinking ? " disabled" : ""}>Send the answer</button>`}${p ? html`<button type="submit" name="move" value="accept" class="btn primary"${card.thinking ? " disabled" : ""}>Accept the rule and go on</button>` : ""}</div>
<details class="ownrule"${card.exhausted && !p ? " open" : ""}><summary>Write the rule yourself</summary>
<label class="field grow">The rule<textarea name="rule" rows="2" maxlength="2000" placeholder="State it so it can be tested: states, conditions, edge cases">${p?.rule ?? ""}</textarea></label>
<div class="actions"><button type="submit" name="move" value="rule" class="btn">Accept this rule and go on</button></div>
</details>`,
        html` class="clarify"`,
      )
    : html`<div class="actions"><span class="hint">Answer in the terminal: <code>${cmd}</code></span><button type="button" class="btn" data-copy="${cmd}">Copy command</button></div>`;
  return html`<section class="panel decision" aria-labelledby="decision" data-live="card">
<span class="warn" style="font-size:13px;font-weight:500">Waits for you · ${step}</span>
<h2 id="decision">${step} asks before going on</h2>
<ol class="convo">${turns}</ol>
${thinking}
${rule}
${moves}
${page.terminal ? html`<p class="hint">A terminal waits at this run too: an answer here or there counts once.</p>` : ""}
</section>`;
}

function otherCardHtml(what: string, page: RunPage): Html {
  const cmd = `jarvis continue ${shortRunId(page.run.id)}`;
  return html`<section class="panel decision" aria-labelledby="decision" data-live="card">
<span class="warn" style="font-size:13px;font-weight:500">Waits for you</span>
<h2 id="decision">The run waits for ${what}</h2>
<p>${page.run.stateReason ?? ""}</p>
<div class="actions"><span class="hint">Answer in the terminal: <code>${cmd}</code></span><button type="button" class="btn" data-copy="${cmd}">Copy command</button></div>
</section>`;
}

/* ---- one artifact ---- */

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The document as the terminal's `jarvis show` reads it: a result document as markdown, else as is. */
export function documentHtml(name: string, text: string, doc?: Record<string, unknown>): Html {
  // the page's h1 is the title already
  if (doc) {
    const { title: _title, ...rest } = doc;
    return markdownToHtml(documentToMarkdown(rest), { shift: 0 });
  }
  if (name.endsWith(".json")) {
    const v = parseJson(text);
    return html`<pre><code>${v === undefined ? text : JSON.stringify(v, null, 2)}</code></pre>`;
  }
  if (/\.(md|markdown)$/i.test(name) || /^#{1,6}\s/m.test(text)) return markdownToHtml(text);
  return html`<pre><code>${text}</code></pre>`;
}

export function diffFileHtml(f: DiffFile, index: number, comments: boolean): Html {
  const status =
    f.status === "added"
      ? " · new"
      : f.status === "deleted"
        ? " · deleted"
        : f.status === "renamed"
          ? ` · from ${f.oldPath ?? "?"}`
          : "";
  const shown = f.lines.slice(0, 3000);
  const rows = shown.map((l) => {
    if (l.kind === "hunk")
      return html`<div class="dl hunk"><span class="n"></span><span class="n"></span><span class="s"></span><span class="c">${l.text}</span></div>`;
    if (l.kind === "note")
      return html`<div class="dl note"><span class="n"></span><span class="n"></span><span class="s"></span><span class="c">${l.text}</span></div>`;
    const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : "";
    const line = l.newLine ?? l.oldLine;
    const can = comments && l.newLine !== undefined;
    return html`<div class="dl ${l.kind === "context" ? "ctx" : l.kind}"${can ? html` data-path="${f.path}" data-line="${line}"` : ""}>${comments ? html`<span class="cm">${can ? html`<button type="button" data-comment aria-label="Comment on ${f.path} line ${line}">+</button>` : ""}</span>` : ""}<span class="n">${l.oldLine ?? ""}</span><span class="n">${l.newLine ?? ""}</span><span class="s" aria-hidden="true">${sign}</span><span class="c">${l.text}</span></div>`;
  });
  return html`<details class="panel file"${index < 12 ? html` open` : ""}>
<summary><span class="fname">${f.path}</span><span class="fstat"><span class="ok">+${f.added}</span> <span class="bad">−${f.removed}</span>${status}</span></summary>
<div class="scroll"><div class="diff" role="table" aria-label="Changes in ${f.path}">${rows}${f.lines.length > shown.length ? html`<div class="dl note"><span class="c">… ${f.lines.length - shown.length} more lines: jarvis diff</span></div>` : ""}</div></div>
</details>`;
}

export interface ArtifactExtras {
  readonly diff?: readonly DiffFile[];
  /** Why there is no diff (the checkout is gone, not a worktree). */
  readonly diffNote?: string;
  /** Forms to decide here; without, the page says where to decide (in the terminal). */
  readonly actions?: Actions;
  readonly banner?: Html;
  readonly comments?: boolean;
  /** Jarvis prepares answers to the open questions right now (they were not ready at the gate). */
  readonly preparing?: boolean;
}

const sourceChips = (sources: readonly string[]) =>
  sources.length > 0
    ? html`<span class="src">${sources.map((x) => html`<span>${cut(x, 80)}</span>`)}</span>`
    : "";

/**
 * The document's open questions as a form (pilot: eight questions of a spec sat in a side column, the
 * answers went into one textarea by hand): per question Jarvis's answer from the sources with where it
 * stands, the options when the sources do not say, one's own answer, «ask the analyst», «not in scope».
 * The inputs belong to the decision form: «Send back» carries the answers.
 */
function questionsHtml(page: ArtifactPage, extras: ArtifactExtras): Html {
  const q = page.questions;
  if (!q) return html``;
  const live = page.awaited && extras.actions !== undefined;
  const items = q.suggestions?.items ?? [];
  const fromSources = items.filter((x) => x.kind === "answer").length;
  const calls = items.filter((x) => x.kind === "decision").length;
  const tally = q.suggestions
    ? [
        fromSources > 0 ? `${fromSources} answered from the sources` : "",
        calls > 0 ? `${calls} your call` : "",
        items.length - fromSources - calls > 0 ? `${items.length - fromSources - calls} need you` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const radio = (n: number, value: string, checked: boolean) =>
    live
      ? html`<input type="radio" name="qa-${String(n)}" value="${value}" form="decide-form"${checked ? " checked" : ""}>`
      : "";
  const card = (question: string, i: number): Html => {
    const n = i + 1;
    const s = items[i];
    const given = q.given?.find((g) => g.question === question);
    const picked =
      s?.kind === "answer" ? "jarvis" : s?.kind === "decision" ? s.options.findIndex((o) => o.suggested) : -1;
    const hint =
      s?.kind === "answer" && s.answer
        ? html`<label class="opt">${radio(n, "jarvis", true)}<span><span class="lbl">✦ From the sources</span><span class="said">${s.answer}</span>${sourceChips(s.sources)}</span></label>`
        : s?.kind === "decision"
          ? html`<p class="lbl">✦ The sources don't say — your call</p>${s.options.map(
              (o, k) =>
                html`<label class="opt">${radio(n, `opt-${String(k)}`, o.suggested)}<span><span class="said">${o.text}</span>${o.note || o.suggested ? html`<small>${o.suggested ? "suggested" : ""}${o.suggested && o.note ? ": " : ""}${o.note}</small>` : ""}</span></label>`,
            )}`
          : s?.unbacked && s.answer
            ? html`<label class="opt guess">${radio(n, "jarvis", false)}<span><span class="lbl">✦ Jarvis's guess — no source confirms it</span><span class="said">${s.answer}</span></span></label>`
            : s
              ? html`<p class="lbl">✦ Only someone else can say: the analyst, legal, another team</p>`
              : "";
    const own = live
      ? html`<label class="opt own">${radio(n, "own", picked === -1)}<span><span class="lbl">My answer</span><textarea name="qa-text-${String(n)}" form="decide-form" rows="2" maxlength="4000" placeholder="${s?.kind === "answer" ? "Instead of Jarvis's answer…" : "Your answer…"}" data-own="${String(n)}"></textarea></span></label>
<div class="qrow"><label class="pick">${radio(n, "analyst", false)} Ask the analyst</label><label class="pick">${radio(n, "scope", false)} Not in scope</label></div>`
      : "";
    const answered = given
      ? html`<div class="done">${given.mode === "analyst" ? "↗ for the analyst" : given.mode === "scope" ? "out of scope" : given.text} <span class="meta">— answered</span></div>`
      : "";
    return html`<fieldset class="q">
<legend class="sr">Question ${String(n)}</legend><span class="n${answered ? " ok" : ""}" aria-hidden="true">${answered ? "✓" : String(n)}</span>
<div class="body"><p class="qtext">${question}</p>${s && s.about.length > 0 ? html`<div class="about">${s.about.map((x) => html`<span class="tag">${x}</span>`)}</div>` : ""}
${answered || html`${hint}${own}`}</div>
</fieldset>`;
  };
  const preparing =
    extras.preparing && !q.suggestions
      ? html`<div class="qs-prep row"><span class="spin" aria-hidden="true"></span><span class="meta">Jarvis prepares answers from the issue, its pages, the design and the research — about a minute</span></div>`
      : "";
  return html`<section class="panel qs" id="questions" aria-labelledby="qs-h" data-live="questions">
<div class="qs-head"><span class="pill wait">${q.list.length} open question${q.list.length === 1 ? "" : "s"}</span><h2 id="qs-h">${live ? "Answer before accepting" : "Open questions"}</h2>${tally ? html`<span class="meta">${tally}</span>` : ""}</div>
${preparing}
${q.list.map(card)}
${
  live
    ? html`<div class="dock"><span class="sum">Answered questions go back with «Send back» — the next version must follow them; the rest stays open. Anything else: the note on the right.</span>
<button type="submit" form="decide-form" name="decision" value="request_changes" class="btn strong big">Send back with the answers</button>
<button type="submit" form="decide-form" name="decision" value="approve" class="btn accept big">Accept as is</button></div>`
    : ""
}
</section>`;
}

export function artifactContent(page: ArtifactPage, extras: ArtifactExtras): Html {
  const a = page.artifact;
  const f = page.facts;
  const title = f?.title ?? `${a.type}/${a.name}`;
  const tone =
    page.state === "accepted"
      ? "ok"
      : page.state === "rejected"
        ? "bad"
        : page.state === "sent back"
          ? "wait"
          : "info";
  const glyph = { ok: "✓", bad: "✗", wait: "↻", info: "⏸" }[tone];
  const who =
    a.provenance.kind === "agent"
      ? `agent ${a.provenance.agentId}`
      : a.provenance.kind === "human"
        ? `${a.provenance.actor.id}`
        : a.provenance.kind;
  const partial = incompleteOf(a);
  const diff = extras.diff;
  const requirements = Array.isArray(f?.doc.requirements) ? (f?.doc.requirements as unknown[]) : [];
  const reqText = (x: unknown): string => {
    if (typeof x === "string") return x;
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      return [o.id, o.text ?? o.title ?? o.summary].filter((v) => typeof v === "string").join(" ");
    }
    return "";
  };
  const aside =
    page.awaited || page.decision || f
      ? html`<aside class="panel aside" aria-labelledby="your-decision" data-live="decision">
<h2 id="your-decision">${page.awaited ? "Your decision" : page.decision ? "Decision" : "In brief"}</h2>
${f?.summary ? html`<p style="font-size:14px;line-height:21px;color:var(--ink-2)">${cut(f.summary, 400)}</p>` : ""}
${
  requirements.length > 0
    ? html`<div class="facts"><span class="lbl">Requirements</span>${requirements.slice(0, 8).map((x) => html`<span>${cut(reqText(x), 140)}</span>`)}${requirements.length > 8 ? html`<span class="muted">+${requirements.length - 8} more</span>` : ""}</div>`
    : ""
}
${f && f.risks.length > 0 ? html`<div class="facts"><span class="lbl">Risks</span>${f.risks.slice(0, 4).map((x) => html`<span>${cut(x, 200)}</span>`)}</div>` : ""}
${f && f.openQuestions.length > 0 && !page.questions ? html`<div class="facts"><span class="lbl warn">Open questions</span>${f.openQuestions.map((x, i) => html`<span>${i + 1}) ${cut(x, 200)}</span>`)}</div>` : ""}
${
  page.decision
    ? html`<div class="banner ${tone === "info" ? "info" : tone === "wait" ? "info" : tone}">${glyph} ${page.state} by ${page.decision.approval.actor.id}${page.decision.channel === "ui" ? " in the browser" : page.decision.channel === "cli" ? " in the terminal" : ""}${page.decision.approval.comment ? html`<br><span style="white-space:pre-wrap">${page.decision.approval.comment.length > 1200 ? `${page.decision.approval.comment.slice(0, 1199)}…` : page.decision.approval.comment}</span>` : ""}</div>`
    : ""
}
${page.decision && page.atGate ? html`<div class="decide">${goesOn(page, extras.actions)}</div>` : ""}
${
  page.awaited && extras.actions
    ? form(
        extras.actions,
        `${runHref(page.run)}/decide`,
        html`<input type="hidden" name="artifact" value="${a.artifactId}"><input type="hidden" name="version" value="${a.version}"><input type="hidden" name="lines" value="">
<div class="decide">
<label for="comment">${page.questions ? "Anything else to change" : "What to change"} <span class="muted">(for Send back; ${page.questions ? "the answers on the left and " : ""}line comments on the diff go with it)</span></label>
<textarea id="comment" name="comment" rows="3"></textarea>
${
  page.questions
    ? html`<a class="btn big" href="#questions">Answer the questions, then decide</a>`
    : html`<button type="submit" name="decision" value="approve" class="btn accept big">Accept</button>
<button type="submit" name="decision" value="request_changes" class="btn strong big" data-send-back>Send back</button>`
}
<span class="hint">Same as <code>a</code> / <code>c</code> on the terminal's card. ${page.terminal ? "The terminal waiting there picks the decision up and goes on." : html`No terminal waits: the run goes on with <code>jarvis continue ${shortRunId(page.run.id)}</code>.`}</span>
</div>`,
        html` data-decision id="decide-form"`,
      )
    : page.awaited
      ? html`<div class="decide"><span class="hint">Decide in the terminal: <code>jarvis continue ${shortRunId(page.run.id)}</code> — <code>a</code> accepts, <code>c</code> sends back.</span><button type="button" class="btn" data-copy="jarvis continue ${shortRunId(page.run.id)}">Copy command</button></div>`
      : ""
}
</aside>`
      : "";
  return html`<div style="display:flex;flex-direction:column;gap:8px" data-live="head">
<div class="row">${page.state ? html`<span class="pill ${tone}">${glyph} ${page.state}</span>` : ""}<span class="meta" style="font-size:13px">${a.type}/${a.name}@${a.version} · ${a.stepId ?? "-"}${a.iteration && a.iteration > 1 ? `#${a.iteration}` : ""} · ${who} · run ${shortRunId(page.run.id)}</span></div>
<h1>${title}</h1>
${
  page.versions.length > 1
    ? html`<nav class="versions" aria-label="Versions"><span style="background:none;color:var(--muted);padding:0">version</span>${page.versions.map(
        (v) =>
          v === a.version
            ? html`<span aria-current="page">${v}</span>`
            : html`<a href="${artifactHref(page.run, { type: a.type, name: a.name, version: v })}">${v}</a>`,
      )}</nav>`
    : ""
}
</div>
${extras.banner ?? ""}
${partial ? html`<div class="banner bad">⚠ incomplete: agent ${partial.agentId} hit its ${partial.limit} limit — what it did not cover is unknown</div>` : ""}
${
  diff || page.questions
    ? html`<nav class="tabs" aria-label="Sections">${page.questions ? html`<a href="#questions">Questions <span class="muted">${page.questions.list.length}</span></a>` : ""}<a href="#document">${diff ? "Summary" : "Document"}</a>${diff ? html`<a href="#files">Files changed <span class="muted">${diff.length}</span></a>` : ""}</nav>`
    : ""
}
<div class="cols">
<div class="mainc">
${questionsHtml(page, extras)}
<section id="document" class="panel doc" aria-label="Document">${documentHtml(a.name, page.text, f?.doc)}</section>
${
  diff
    ? html`<section id="files" class="group" aria-labelledby="files-h"><h2 id="files-h">Files changed <span class="muted" style="font-weight:400">${diff.length}</span></h2>${
        diff.length > 0
          ? diff.map((x, i) =>
              diffFileHtml(x, i, extras.comments === true && page.awaited && extras.actions !== undefined),
            )
          : html`<div class="panel empty">No changes against the base.</div>`
      }</section>`
    : extras.diffNote
      ? html`<p class="muted">${extras.diffNote}</p>`
      : ""
}
</div>
${aside}
</div>`;
}

export function errorContent(status: number, message: string, hint?: Part): Html {
  return html`<div class="lede"><h1>${status === 404 ? "Not found" : "Something went wrong"}</h1></div>
<div class="panel empty"><p>${message}</p>${hint ? html`<p class="muted" style="margin-top:8px">${hint}</p>` : ""}</div>`;
}

/** The plain page a request without the session token gets. */
export function forbiddenPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>jarvis ui</title></head><body style="font-family:system-ui,sans-serif;padding:32px"><h1 style="font-size:22px">403 — this page needs its session token</h1><p>Open the address <code>jarvis ui</code> printed in the terminal: it carries the token.</p></body></html>`;
}

export { escapeHtml };

/* ---- the models indicator (ADR-0023): a dot in the header, the details in a popover ---- */

const HEALTH: Record<HealthState, { label: string; pill: string }> = {
  ok: { label: "ok", pill: "ok" },
  busy: { label: "busy", pill: "wait" },
  down: { label: "down", pill: "bad" },
  idle: { label: "idle", pill: "plain" },
};

/** One line for the indicator's tooltip: the worst model and why; and what is unlimited now. */
export function modelsSummary(h: ModelsHealth): string {
  if (h.models.length === 0) return "Models: none configured";
  const worst = h.models.find((m) => m.state === h.state);
  const why = worst?.reasons[0];
  const free = unlimitedNow(h);
  return `Models: ${HEALTH[h.state].label}${worst && h.state !== "ok" && h.state !== "idle" ? ` — ${worst.id}${why ? `: ${why}` : ""}` : ""}${free ? ` · ${free.id}: ${unlimitedText(free.unlimited)}` : ""}`;
}

/** The model unlimited now that matters most: the one whose unlimited hours are on, else a pool with no limits. */
function unlimitedNow(h: ModelsHealth): (ModelHealth & { unlimited: Unlimited }) | undefined {
  const free = h.models.filter((m): m is ModelHealth & { unlimited: Unlimited } => m.unlimited?.now === true);
  return free.find((m) => !(m.unlimited.now && m.unlimited.always)) ?? free[0];
}

/** `∞ until 07:00` on the header's button while a model is not limited; nothing otherwise. */
export function modelsBadge(h: ModelsHealth): string | undefined {
  const free = unlimitedNow(h);
  if (!free?.unlimited.now) return undefined;
  return free.unlimited.until ? `∞ until ${whenAt(free.unlimited.until)}` : "∞";
}

/** `14:30` today, `Mon 07:00` another day. */
function whenAt(ts: string): string {
  const at = new Date(ts);
  const time = at.toTimeString().slice(0, 5);
  return at.toDateString() === new Date().toDateString()
    ? time
    : `${at.toLocaleDateString("en-GB", { weekday: "short" })} ${time}`;
}

function unlimitedText(u: Unlimited): string {
  if (u.now)
    return u.always
      ? "unlimited (its pool has no limits)"
      : `unlimited hours${u.until ? ` until ${whenAt(u.until)}` : ""}`;
  return u.next ? `unlimited hours from ${whenAt(u.next)}` : "";
}

const pct = (share: number) => `${Math.round(share * 100)}%`;
const wall = (ts: string) => new Date(ts).toTimeString().slice(0, 5);

function modelHtml(m: ModelHealth): Html {
  const w = m.window;
  const used = w?.share !== undefined ? Math.min(100, Math.round(w.share * 100)) : undefined;
  const r = m.recent;
  const lineOf = [
    `${r.calls} call${r.calls === 1 ? "" : "s"}`,
    ...(r.failed > 0 ? [`${r.failed} failed`] : []),
    ...(r.retries > 0 ? [`${r.retries} retr${r.retries === 1 ? "y" : "ies"}`] : []),
    ...(r.latencyP50Ms ? [`p50 ${duration(r.latencyP50Ms)}`] : []),
    ...(r.lastCallAt ? [`last ${wall(r.lastCallAt)}`] : []),
  ].join(" · ");
  const waiting = [
    ...m.waiting.model.map((id) => ({ id, why: "the model" })),
    ...m.waiting.quota.map((id) => ({ id, why: "quota" })),
  ];
  return html`<li class="mh">
<div class="row"><span class="dot" data-state="${m.state}" aria-hidden="true"></span><b class="mono">${m.id}</b><span class="pill ${HEALTH[m.state].pill}">${HEALTH[m.state].label}</span>${m.unlimited?.now ? html`<span class="pill ok">∞ ${unlimitedText(m.unlimited)}</span>` : ""}</div>
${m.reasons.length > 0 ? html`<ul class="why">${m.reasons.map((x) => html`<li>${x}</li>`)}</ul>` : ""}
${
  w
    ? html`<div class="win">${used !== undefined ? html`<div class="bar" role="img" aria-label="quota window ${used}% used"><span class="${w.share !== undefined && w.share >= 1 ? "full" : w.share !== undefined && w.share >= w.soft ? "soft" : ""}" style="width:${used}%"></span></div>` : ""}
<span class="meta">${w.inputLimit || w.inputTokens > 0 ? `${kilo(w.inputTokens)}${w.inputLimit ? ` / ${kilo(w.inputLimit)}` : ""} input · ` : ""}${kilo(w.outputTokens)}${w.outputLimit ? ` / ${kilo(w.outputLimit)}` : ""} output tok · ${w.requests}${w.requestLimit ? ` / ${w.requestLimit}` : ""} requests · ${w.minutes} min window${w.share !== undefined ? ` · ${pct(w.share)}` : ""}</span></div>`
    : ""
}
${m.unlimited && !m.unlimited.now && m.unlimited.next ? html`<span class="meta">${unlimitedText(m.unlimited)}</span>` : ""}
${m.inFlight.calls > 0 ? html`<span class="meta now-line"><span class="spin" aria-hidden="true"></span>${m.inFlight.calls} request${m.inFlight.calls === 1 ? "" : "s"} being answered now${m.inFlight.longestMs ? ` · longest ${duration(m.inFlight.longestMs)}` : ""}</span>` : ""}
<span class="meta">last ${r.minutes} min: ${lineOf}</span>
${m.perf ? perfHtml(m.perf) : ""}
${r.lastFailure ? html`<span class="meta">last failure ${wall(r.lastFailure.at)} · ${r.lastFailure.reason}</span>` : ""}
${
  waiting.length > 0
    ? html`<span class="meta">waiting: ${join(
        waiting.map((x) => html`<a href="/runs/${x.id}">${x.id}</a> (${x.why})`),
        ", ",
      )}</span>`
    : ""
}
</li>`;
}

/** The numbers of the last half hour as label/value rows: how fast, how much, how well. */
function perfHtml(p: ModelPerf): Html {
  const pcs = (v: { p50: number; p90: number; max: number } | undefined, f: (n: number) => string) =>
    v ? `p50 ${f(v.p50)} · p90 ${f(v.p90)} · max ${f(v.max)}` : "—";
  const rows: Array<[string, string]> = [
    ["latency", pcs(p.latencyMs, duration)],
    ...(p.firstTokenMs
      ? ([["first token", `${pcs(p.firstTokenMs, duration)} · ${p.streamed} streamed`]] as Array<
          [string, string]
        >)
      : []),
    ["speed", pcs(p.outputPerSecond, (n) => `${Math.round(n)} tok/s`)],
    ["throughput", `${kilo(p.outputPerMinute)} out · ${kilo(p.promptPerMinute)} in tok/min`],
    [
      "per call",
      `in avg ${kilo(p.prompt.avg)} (max ${kilo(p.prompt.max)}) · out avg ${kilo(p.output.avg)} (max ${kilo(p.output.max)})`,
    ],
    ["total", `${kilo(p.prompt.total)} in · ${kilo(p.output.total)} out`],
    [
      "cache",
      `${Math.round(p.cachedShare * 100)}% cached${p.prefixReuseP50 !== undefined ? ` · prefix reusable p50 ${Math.round(p.prefixReuseP50 * 100)}%` : ""}`,
    ],
    [
      "answers",
      `${Math.round(p.successRate * 1000) / 10}% ok${p.retriedCalls > 0 ? ` · ${p.retriedCalls} after a retry` : ""}${p.cut > 0 ? ` · ${p.cut} cut at maxOutput` : ""}`,
    ],
  ];
  return html`<dl class="perf">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

/** The popover's body: each model, then where the full numbers are. */
export function modelsPopover(h: ModelsHealth): Html {
  return html`<div class="pop-head"><b>Models</b><span class="pill ${HEALTH[h.state].pill}">${HEALTH[h.state].label}</span><span class="meta">at ${wall(h.at)}</span></div>
${
  h.models.length > 0
    ? html`<ul class="mhs">${h.models.map(modelHtml)}</ul>`
    : html`<p class="muted">No models configured — add one to ~/.jarvis/config.yaml.</p>`
}
${h.load ? loadHtml(h.load) : ""}
<p class="hint">In the terminal: <code>jarvis models stats</code> (latency, failures, tokens) · <code>jarvis models list</code> (pools, probes)</p>`;
}

/** Requests at once over every run: what a pool's concurrency limit would cap (none is applied yet). */
function loadHtml(load: NonNullable<ModelsHealth["load"]>): Html {
  const n = load.inFlight.length;
  return html`<div class="mh mload"><div class="row"><b>At once</b><span class="meta">${n === 0 ? "no model request now" : `${n} request${n === 1 ? "" : "s"} now`}${load.peak ? ` · peak today ${load.peak.count} at ${wall(load.peak.at)}` : ""}</span></div>
${n > 0 ? html`<ul class="mload-runs">${load.inFlight.map((f) => html`<li><a href="/runs/${f.run}">${f.run}</a> <span class="meta">${f.step}${f.modelId ? ` · ${f.modelId}` : ""} · waiting ${clock(Math.max(0, f.waitingMs))}</span></li>`)}</ul>` : ""}
<p class="hint">Over every run and process. <code>maxConcurrency</code> of a model holds within one run only; nothing caps runs together yet (a pool's <code>limits.concurrency</code>): watch this if the platform starts answering 429.</p></div>`;
}

/** The popover before the first numbers: open at once, saying what it waits for. */
export function modelsPending(): Html {
  return html`<div class="pop-head"><b>Models</b><span class="spin" aria-hidden="true"></span><span class="meta">waiting for data</span></div>
<p class="muted">Collecting the models' stats — each pool's quota window and the last half hour of calls. It shows up here in a moment.</p>`;
}

/**
 * A task started on the page, before its run exists (src/ui/launcher.ts): the run's checkout is being
 * prepared (a worktree, the workspace setup — minutes for a monorepo). The page reloads itself and
 * becomes the run's page as soon as the run begins; a launch that failed shows its output.
 */
export function launchContent(l: LaunchView & { readonly repo: string }, now: number, homeDir: string): Html {
  const failed = l.exitCode !== null;
  const age = ticking(now - Date.parse(l.startedAt));
  return html`<div data-live="launch" style="display:flex;flex-direction:column;gap:28px"><div class="lede-col" style="display:flex;flex-direction:column;gap:8px">
<div class="row"><span class="pill ${failed ? "bad" : "info"}">${failed ? (l.exitCode === 0 ? "ended without a run" : `failed to start · exit ${l.exitCode}`) : "◌ starting"}</span><span class="meta">${l.workflow} · started ${age} ago · ${home(l.repo, homeDir)}</span></div>
<h1>${firstLine(l.task)}</h1>
</div>
${
  failed
    ? html`<section class="panel now"><p>The task did not become a run. Its output is below; fix the cause and start it again.</p><div class="actions"><a class="btn primary" href="/#new">New task</a></div></section>`
    : html`<section class="panel now" aria-live="polite"><div class="row"><span class="spin" aria-hidden="true"></span><b>Preparing the run's checkout</b></div>
<p class="muted">A worktree of the repository and its workspace setup (installing, building) — for a monorepo that takes a few minutes. This page turns into the run's page by itself as soon as the run begins.</p></section>`
}
<section class="panel feed" aria-labelledby="output"><h2 id="output">Output</h2>
${l.tail ? html`<pre class="tail">${l.tail}</pre>` : html`<p class="muted">Nothing yet.</p>`}
<span class="meta">log ${home(l.log, homeDir)}</span></section></div>`;
}

/* ---- the MCP indicator (ADR-0023, ADR-0017): the same dot and popover as the models' ---- */

/** One line for the indicator's tooltip: the worst server and why. */
export function mcpSummary(h: McpHealth): string {
  if (h.servers.length === 0) return "MCP: no servers configured";
  const worst = h.servers.find((s) => s.state === h.state);
  const why = worst?.reasons[0];
  return `MCP: ${HEALTH[h.state].label}${worst && h.state !== "ok" && h.state !== "idle" ? ` — ${worst.id}${why ? `: ${why}` : ""}` : ""}`;
}

const day = (ts: string) => `${ts.slice(0, 10)} ${wall(ts)}`;
const names = (xs: readonly string[]) => (xs.length > 0 ? xs.join(", ") : "—");

function serverHtml(s: McpServerHealth): Html {
  const p = s.probe;
  const check = s.checking
    ? "checking now…"
    : p
      ? p.ok
        ? `answered ${wall(p.at)} · ${p.tools ?? 0} tools · ${duration(p.ms ?? 0)}`
        : `no answer ${wall(p.at)} · ${p.error ?? "error"}`
      : "not checked yet";
  const r = s.recent;
  const calls =
    r.calls + r.denied === 0
      ? "none"
      : [
          `${r.calls} call${r.calls === 1 ? "" : "s"}`,
          ...(r.failed > 0 ? [`${r.failed} failed`] : []),
          ...(r.denied > 0 ? [`${r.denied} denied by policy`] : []),
          ...(r.lastCallAt ? [`last ${wall(r.lastCallAt)}`] : []),
        ].join(" · ");
  const rows: Array<[string, string]> = [
    ...(s.egressException
      ? ([
          ["egress", `out of the project's data class by an exception, reads only: ${s.egressException}`],
        ] as Array<[string, string]>)
      : []),
    ["check", check],
    ["discovered", s.discovered ? `${day(s.discovered.at)} · ${s.discovered.count} tools` : "never"],
    ["exposed", names(s.exposed)],
    ...(s.denied.length > 0
      ? ([["denied", `${names(s.denied)} (allow / deny)`]] as Array<[string, string]>)
      : []),
    ...(s.unmapped.length > 0
      ? ([["unmapped", `${names(s.unmapped)} (the server lacks the tool)`]] as Array<[string, string]>)
      : []),
    ...(s.notAllowed.length > 0
      ? ([
          [
            "not allowed",
            `${s.notAllowed.length} tool${s.notAllowed.length === 1 ? "" : "s"} without a profile entry: ${s.notAllowed.slice(0, 6).join(", ")}${s.notAllowed.length > 6 ? ", …" : ""}`,
          ],
        ] as Array<[string, string]>)
      : []),
    [`last ${r.minutes} min`, calls],
    ...(r.latencyMs
      ? ([
          [
            "latency",
            `p50 ${duration(r.latencyMs.p50)} · p90 ${duration(r.latencyMs.p90)} · max ${duration(r.latencyMs.max)}`,
          ],
        ] as Array<[string, string]>)
      : []),
    ...(r.byCapability.length > 0
      ? ([
          [
            "used",
            r.byCapability
              .map((c) => `${c.name} ${c.calls}${c.failed > 0 ? ` (${c.failed} failed)` : ""}`)
              .join(" · "),
          ],
        ] as Array<[string, string]>)
      : []),
    ...(r.lastFailure
      ? ([
          [
            "last failure",
            `${wall(r.lastFailure.at)} · ${r.lastFailure.capability} · ${r.lastFailure.reason}`,
          ],
        ] as Array<[string, string]>)
      : []),
  ];
  return html`<li class="mh">
<div class="row"><span class="dot" data-state="${s.checking && !p ? "pending" : s.state}" aria-hidden="true"></span><b class="mono">${s.id}</b><span class="pill ${HEALTH[s.state].pill}">${HEALTH[s.state].label}</span><span class="meta">${s.profile ? `profile ${s.profile}` : s.readOnly ? "readOnly" : "no profile"} · ${s.network}${s.egressException ? " ⚠" : s.egressAllowed ? "" : " ✗"} · ${s.transport}</span></div>
${s.reasons.length > 0 ? html`<ul class="why">${s.reasons.map((x) => html`<li>${x}</li>`)}</ul>` : ""}
<span class="meta mono">${s.target}${s.auth ? ` · auth ${s.auth}` : ""}</span>
<dl class="perf">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
</li>`;
}

/** The popover's body: each server, a check on demand, then where the rest is. */
export function mcpPopover(h: McpHealth, options: { readonly checkToken?: string } = {}): Html {
  const checking = h.servers.some((s) => s.checking);
  return html`<div class="pop-head"><b>MCP</b><span class="pill ${HEALTH[h.state].pill}">${HEALTH[h.state].label}</span><span class="meta">at ${wall(h.at)}</span>${
    options.checkToken && h.servers.length > 0
      ? checking
        ? html`<span class="spin" aria-hidden="true"></span>`
        : html`<button type="button" class="btn small" data-mcp-check="${options.checkToken}">Check now</button>`
      : ""
  }</div>
${
  h.servers.length > 0
    ? html`<ul class="mhs">${h.servers.map(serverHtml)}</ul>`
    : html`<p class="muted">No MCP servers — add them under mcp.servers in ~/.jarvis/config.yaml or .jarvis/project.yaml.</p>`
}
<p class="hint">In the terminal: <code>jarvis mcp list --refresh</code> (connect and list) · <code>jarvis doctor</code> (credentials) · <code>jarvis auth set &lt;id&gt;</code> (a token)</p>`;
}

/** The popover before the first answer: open at once, saying what it waits for. */
export function mcpPending(): Html {
  return html`<div class="pop-head"><b>MCP</b><span class="spin" aria-hidden="true"></span><span class="meta">waiting for data</span></div>
<p class="muted">Reading the MCP servers' state and checking that each answers — the first check of a server started by uvx or npx takes a few seconds.</p>`;
}

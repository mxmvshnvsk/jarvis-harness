import { type Activity, clock, kilo } from "../app/activity.ts";
import { type BudgetStop, sourceOf, unitOf } from "../app/budgetStop.ts";
import { type BudgetWait, whenText } from "../app/budgetWait.ts";
import { duration } from "../app/journey.ts";
import type { McpHealth, McpServerHealth } from "../app/mcpHealth.ts";
import type { HealthState, ModelHealth, ModelPerf, ModelsHealth } from "../app/modelHealth.ts";
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
  FeedItem,
  LoopCard,
  RunPage,
  RunsPage,
  StepRow,
  WaitCard,
  WaitingCandidate,
  WaitingRun,
} from "./model.ts";

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
}

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
<div class="models-wrap" data-pop-wrap><button type="button" class="models" data-models aria-expanded="false" aria-controls="models-pop" title="Models: collecting the stats…"><span class="dot" data-state="pending" aria-hidden="true"></span><span>models</span></button>
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
function statePill(run: Run, extra?: string): Html {
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

/** `model call 12, waiting 0:21, receiving ~1.1k tok`: what the step's agent does now. */
function callText(a: Activity): string {
  const step = a.step;
  if (!step) return "starting…";
  if (a.waitingMs === undefined) return `${step.modelCalls} model call${step.modelCalls === 1 ? "" : "s"}`;
  const coming = a.receiving
    ? a.receiving.outputChars > 0
      ? `, receiving ~${kilo(Math.round(a.receiving.outputChars / 4))} tok`
      : `, thinking ~${kilo(Math.round(a.receiving.reasoningChars / 4))} tok`
    : "";
  const retry = a.retrying ? `, retry ${a.retrying.attempt} after ${a.retrying.reason}` : "";
  return `model call ${step.modelCalls + 1}, waiting ${clock(a.waitingMs)}${coming}${retry}`;
}

/** `[8/18] implementation#2 · model call 12, waiting 0:21, receiving ~1.1k tok` */
function activityText(a: Activity | undefined, position?: { index: number; total: number }): string {
  if (!a?.step) return "starting…";
  const pos = position ? `[${position.index}/${position.total}] ` : "";
  const step = `${pos}${a.step.id}${a.step.iteration > 1 ? `#${a.step.iteration}` : ""}${a.step.agent && a.step.agent !== a.step.id ? ` · ${a.step.agent}` : ""}`;
  return `${step} · ${callText(a)}`;
}

function toolBudget(a: Activity | undefined, now: number): Html {
  const step = a?.step;
  const max = step?.maxToolCalls;
  const used = step?.toolCalls ?? 0;
  const pct = max ? Math.min(100, Math.round((used / max) * 100)) : 0;
  const since = step ? clock(Math.max(0, now - Date.parse(step.startedAt))) : "";
  return html`<div class="bar" role="img" aria-label="${max ? `${used} of ${max} tool calls used` : `${used} tool calls`}"><span style="width:${pct}%"></span></div>
<span class="meta">tools ${max ? `${used}/${max}` : used}${since ? ` · ${since}` : ""}</span>`;
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

/** "New task": what to do, which workflow, which repository — started as `jarvis fix "…"` would be. */
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
<label class="field grow">What to do<textarea name="task" rows="3" required maxlength="4000" placeholder="Bug: on the compact form the upload toggle hides attached files — find the cause and fix it"></textarea></label>
<div class="row">
<label class="field">Workflow<select name="workflow">${start.workflows.map((w) => html`<option value="${w.id}"${w.id === "fix" ? " selected" : ""}>${w.label} — ${w.about}</option>`)}</select></label>
${repoField}
<button type="submit" class="btn primary">Start</button>
</div>
<p class="hint">Runs in the background, as <code>jarvis fix "…"</code> without a terminal; where it needs you, it waits here — decide on the page and it goes on.</p>`,
)}
</section>`;
}

function launchHtml(l: LaunchView, now: number, homeDir: string): Html {
  return html`<a class="launch-link" href="/launches/${l.id}">${launchRow(l, now, homeDir)}</a>`;
}

function launchRow(l: LaunchView, now: number, homeDir: string): Html {
  const age = clock(Math.max(0, now - Date.parse(l.startedAt)));
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
<div class="what"><a href="${runHref(r.run)}">${firstLine(r.run.task)}</a><span class="meta">${r.run.workflow} · ${shortRunId(r.run.id)} · ${activityText(r.activity, r.position)}</span></div>
<div class="budget">${toolBudget(r.activity, now)}</div>
<a href="${runHref(r.run)}">Follow</a>
</div>`,
      )
    : html`<div class="panel empty">Nothing runs now.</div>`
}
</section>
<section class="group" aria-labelledby="recent" data-live="recent">
<h2 id="recent">Recent</h2>
${
  page.recent.length > 0
    ? html`<div class="panel scroll recent"><table>
<thead><tr><th scope="col">Run</th><th scope="col">Task</th><th scope="col">Workflow</th><th scope="col">State</th><th scope="col">Took</th><th scope="col">Model</th></tr></thead>
<tbody>${page.recent.map(
        (r) =>
          html`<tr><td class="mono"><a href="${runHref(r.run)}">${shortRunId(r.run.id)}</a></td><td>${firstLine(r.run.task, 90)}</td><td>${r.run.workflow}</td><td>${recentState(r.run)}</td><td>${duration(r.tookMs)}</td><td class="muted">${r.modelCalls} call${r.modelCalls === 1 ? "" : "s"}</td></tr>`,
      )}</tbody></table></div>`
    : html`<div class="panel empty">No runs yet.</div>`
}
</section>`;
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
    if (r.budgetExhausted)
      notes.push(
        `${r.budgetExhausted === "model" ? "model call" : r.budgetExhausted === "budget" ? "budget" : "tool"} limit reached`,
      );
    // the loop's line names the outcome already
    if (r.outcome && r.outcome !== "success" && s.loops.at(-1)?.outcome !== r.outcome) notes.push(r.outcome);
    if (r.status !== "success" && r.reason) notes.push(cut(r.reason, 120));
  }
  if (s.status === "skipped" && r?.reason) notes.push(`skipped: ${r.reason}`);
  const loop = s.loops.at(-1);
  if (loop)
    notes.push(
      `sent the work back to ${loop.to} ${loop.iteration}${loop.max ? `/${loop.max}` : ""} — ${loop.outcome}`,
    );
  if (s.status === "waiting") notes.push(s.paused ? "paused · waits for the quota window" : "waits for you");
  if (s.status === "running") notes.push("running now");
  const took =
    s.status === "running" && s.startedAt
      ? clock(Math.max(0, now - Date.parse(s.startedAt)))
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
<div class="row"><span class="spin" aria-hidden="true"></span><b>${a.step.id}${a.step.iteration > 1 ? `#${a.step.iteration}` : ""}${a.step.agent && a.step.agent !== a.step.id ? ` · ${a.step.agent}` : ""}</b><span class="meta">${clock(Math.max(0, now - Date.parse(a.step.startedAt)))} · ${callText(a)}</span></div>
${toolBudget(a, now)}
${last ? html`<span class="meta">${last}</span>` : ""}
</section>`;
}

function feedHtml(feed: readonly FeedItem[]): Html {
  return html`<section class="panel feed" aria-labelledby="activity" data-live="feed">
<h2 id="activity">Activity</h2>
${
  feed.length > 0
    ? html`<ol>${feed.map((f) => html`<li><time datetime="${f.ts}">${wallClock(f.ts)}</time><span${f.tone ? html` class="${f.tone}"` : ""}>${f.text}</span></li>`)}</ol>`
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
</div>
${actions && !isTerminal(r.state) ? cancelHtml(r, actions) : ""}
</div>
</div>
${notice ?? ""}
<div class="cols">
<section class="panel side steps" aria-labelledby="steps" data-live="steps">
<h2 id="steps">Steps</h2>
<ol style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px">${page.steps.map((s) => stepRow(s, now))}</ol>
</section>
<div class="mainc">
${card ? (card.kind === "loop" ? loopCardHtml(card, page, actions) : card.kind === "approval" ? approvalCardHtml(card, page, actions) : card.kind === "budget" ? budgetCardHtml(card, page, actions) : otherCardHtml(card.what, page)) : page.wait ? waitHtml(page, page.wait, now, actions) : nowHtml(page, now, actions)}
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
${f && f.openQuestions.length > 0 ? html`<div class="facts"><span class="lbl warn">Open questions</span>${f.openQuestions.map((x, i) => html`<span>${i + 1}) ${cut(x, 200)}</span>`)}</div>` : ""}
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
<label for="comment">What to change <span class="muted">(for Send back; line comments on the diff go with it)</span></label>
<textarea id="comment" name="comment" rows="3"></textarea>
<button type="submit" name="decision" value="approve" class="btn accept big">Accept</button>
<button type="submit" name="decision" value="request_changes" class="btn strong big" data-send-back>Send back</button>
<span class="hint">Same as <code>a</code> / <code>c</code> on the terminal's card. ${page.terminal ? "The terminal waiting there picks the decision up and goes on." : html`No terminal waits: the run goes on with <code>jarvis continue ${shortRunId(page.run.id)}</code>.`}</span>
</div>`,
        html` data-decision`,
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
  diff
    ? html`<nav class="tabs" aria-label="Sections"><a href="#document">Summary</a><a href="#files">Files changed <span class="muted">${diff.length}</span></a></nav>`
    : ""
}
<div class="cols">
<div class="mainc">
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

/** One line for the indicator's tooltip: the worst model and why. */
export function modelsSummary(h: ModelsHealth): string {
  if (h.models.length === 0) return "Models: none configured";
  const worst = h.models.find((m) => m.state === h.state);
  const why = worst?.reasons[0];
  return `Models: ${HEALTH[h.state].label}${worst && h.state !== "ok" && h.state !== "idle" ? ` — ${worst.id}${why ? `: ${why}` : ""}` : ""}`;
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
<div class="row"><span class="dot" data-state="${m.state}" aria-hidden="true"></span><b class="mono">${m.id}</b><span class="pill ${HEALTH[m.state].pill}">${HEALTH[m.state].label}</span></div>
${m.reasons.length > 0 ? html`<ul class="why">${m.reasons.map((x) => html`<li>${x}</li>`)}</ul>` : ""}
${
  w
    ? html`<div class="win">${used !== undefined ? html`<div class="bar" role="img" aria-label="quota window ${used}% used"><span class="${w.share !== undefined && w.share >= 1 ? "full" : w.share !== undefined && w.share >= w.soft ? "soft" : ""}" style="width:${used}%"></span></div>` : ""}
<span class="meta">${kilo(w.outputTokens)}${w.outputLimit ? ` / ${kilo(w.outputLimit)}` : ""} output tok · ${w.requests}${w.requestLimit ? ` / ${w.requestLimit}` : ""} requests · ${w.minutes} min window${w.share !== undefined ? ` · ${pct(w.share)}` : ""}</span></div>`
    : ""
}
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
<p class="hint">In the terminal: <code>jarvis models stats</code> (latency, failures, tokens) · <code>jarvis models list</code> (pools, probes)</p>`;
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
  const age = clock(Math.max(0, now - Date.parse(l.startedAt)));
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

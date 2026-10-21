import { type Activity, clock, compactingText, kilo, QUIET_MS, type ToolBatch } from "../app/activity.ts";
import { type BudgetStop, sourceOf, unitOf } from "../app/budgetStop.ts";
import { type BudgetWait, whenText as whenTextEn } from "../app/budgetWait.ts";
import { isStale, issueKeyOf, type StartPoint } from "../app/continuation.ts";
import type { ContractChangeRequest } from "../app/contractChange.ts";
import type { DtoCheck } from "../app/contractFields.ts";
import { duration as durationEn } from "../app/journey.ts";
import type { MasterBudget } from "../app/masterBudget.ts";
import type { McpHealth, McpServerHealth } from "../app/mcpHealth.ts";
import type { HealthState, ModelHealth, ModelPerf, ModelsHealth, Unlimited } from "../app/modelHealth.ts";
import type { PlanProgress } from "../app/planProgress.ts";
import type { RestartPlan } from "../app/restart.ts";
import type { RoundFailure } from "../app/rounds.ts";
import type { SubtaskView } from "../app/subtasks.ts";
import type { TimeItem, TimePart, TimeSplit } from "../app/timeSplit.ts";
import { cdTo, type TryOut, tryCommand } from "../app/tryOut.ts";
import type { Change } from "../cli/checkout.ts";
import { toolMix } from "../cli/progress.ts";
import { documentToMarkdown } from "../cli/render.ts";
import { incompleteOf } from "../cli/style.ts";
import { isTerminal, type Run } from "../core/domain/run.ts";
import type { CandidateReason } from "../evals/candidates.ts";
import type { ScheduledEvalOutcome } from "../evals/schedule.ts";
import type { EgressNotice, ModelEgressNotice } from "../security/policy/egress.ts";
import { shortRunId } from "../storage/runStore.ts";
import { CLIENT_STRINGS } from "./assets.ts";
import { checkLogHtml, checksHtml, checksOf } from "./checks.ts";
import { type DiffFile, escapeHtml, type Html, html, join, markdownToHtml, type Part, raw } from "./html.ts";
import { LANG_COOKIE, lang, plural, t, th, units, when } from "./i18n.ts";
import { KIND_NAME, kindWhy } from "./kinds.ts";
import type {
  ApprovalCard,
  ArtifactPage,
  BudgetCard,
  ClarifyCard,
  ConflictCard,
  ContractCard,
  ContractSideView,
  EffectCard,
  FeedItem,
  LoopCard,
  RunPage,
  RunsPage,
  ScopeCard,
  StepRow,
  StepSkills,
  TestsStop,
  UntrustedView,
  WaitCard,
  WaitingCandidate,
  WaitingRun,
} from "./model.ts";
import { RECENT_PAGE, RECENT_SIZES } from "./model.ts";
import { newTaskHtml, type StartForm } from "./newTask.ts";
import { reasonText } from "./reasons.ts";
import { fileRefHtml, fileRefOf, openHref } from "./refs.ts";

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

/** A POST form with the session token: a foreign page cannot make one (ADR-0023 §5). */
function form(actions: Actions, action: string, body: Part, attrs: Part = ""): Html {
  return html`<form method="post" action="${action}"${attrs}><input type="hidden" name="t" value="${actions.token}">${body}</form>`;
}

/** "Resume": the page drives the run from now on and starts `jarvis resume` (src/app/resumable.ts). */
function resumeForm(actions: Actions, run: Pick<Run, "id">, label = t("Resume")): Html {
  return form(
    actions,
    `${runHref(run)}/resume`,
    html`<button type="submit" class="btn primary">${label}</button>`,
  );
}

/** After a decision: who goes on with it — the terminal at the card, this page, or nobody yet. */
function goesOn(page: Pick<RunPage, "run" | "terminal" | "driven" | "resumable">, actions?: Actions): Html {
  const cmd = `jarvis continue ${shortRunId(page.run.id)}`;
  if (page.terminal)
    return html`<span class="hint">${t("The terminal waiting at the card goes on with it.")}</span>`;
  if (page.resumable && actions)
    return html`${resumeForm(actions, page.run)}<span class="hint">${page.driven ? t("It did not go on by itself") : t("No terminal waits at this run")}: ${t("Resume goes on in the background, or")} <code>${cmd}</code> ${t("in a terminal")}</span>`;
  if (page.driven) return html`<span class="hint">${t("It goes on in the background.")}</span>`;
  return html`<span class="hint">${t("No terminal waits at this run: it goes on with")} <code>${cmd}</code></span><button type="button" class="btn" data-copy="${cmd}">${t("Copy command")}</button>`;
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
  /** Cloud models allowed by the project's exception (ADR-0016 §6): said on every page. */
  readonly modelEgress?: readonly ModelEgressNotice[];
  /** Runs that wait for a person: the count next to Runs in the top bar. */
  readonly waits?: number;
  /** The services of a knowledge repository's map: Services in the top bar. */
  readonly services?: number;
  /** The page's path: which section of the top bar is current. */
  readonly path?: string;
  /** «Report a problem» is on (`feedback.repo`). */
  readonly report?: boolean;
}

/** The top bar's sections: Runs with what waits, Knowledge, Services of a knowledge repository. */
function sectionsHtml(chrome: Chrome): Html {
  const path = chrome.path ?? "";
  const services = path.startsWith("/knowledge/services");
  const at = (on: boolean) => (on ? html` aria-current="page"` : "");
  return html`<nav class="sections" aria-label="${t("Pages")}"><a href="/"${at(chrome.page === "runs" || chrome.page === "run" || chrome.page === "artifact")}>${t("Runs")}${chrome.waits ? html`<span class="n w">${plural(chrome.waits, "waits", "wait")}</span>` : ""}</a><a href="/knowledge"${at(chrome.page === "knowledge" && !services)}>${t("Knowledge")}</a>${chrome.services !== undefined ? html`<a href="/knowledge/services"${at(services)}>${t("Services")}<span class="n">${String(chrome.services)}</span></a>` : ""}</nav>`;
}

/** EN | RU in the top bar: a link that sets the language cookie and comes back here (src/ui/server.ts). */
function langSwitch(path: string): Html {
  const now = lang();
  const other = now === "ru" ? "en" : "ru";
  return html`<a class="theme lang" href="/lang?to=${other}&amp;back=${encodeURIComponent(path)}" hreflang="${other}" title="${now === "ru" ? "English" : "Русский"}" aria-label="${now === "ru" ? "Switch to English" : "Переключить на русский"}" data-lang-cookie="${LANG_COOKIE}">${other.toUpperCase()}</a>`;
}

export function layout(chrome: Chrome, content: Html): string {
  return html`<!doctype html>
<html lang="${lang()}"${chrome.theme ? html` data-theme="${chrome.theme}"` : ""}>
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
${clientStrings()}
</head>
<body data-page="${chrome.page}"${chrome.runId ? html` data-run="${chrome.runId}"` : ""}${chrome.tick ? html` data-tick="${chrome.tick}"` : ""}>
<a class="skip-link" href="#main">${t("Skip to content")}</a>
<header class="top"><div class="bar">
<a class="brand" href="/"><span class="mark" aria-hidden="true"></span>jarvis</a>
${sectionsHtml(chrome)}
${chrome.repos ?? ""}
<div class="status">
<div class="models-wrap" data-pop-wrap><button type="button" class="models" data-mcp aria-expanded="false" aria-controls="mcp-pop" title="${t("MCP: checking the servers…")}"><span class="dot" data-state="pending" aria-hidden="true"></span><span>mcp</span></button>
<div id="mcp-pop" class="pop" role="dialog" aria-label="${t("MCP servers")}" hidden><div data-mcp-body>${mcpPending()}</div></div></div>
<div class="models-wrap" data-pop-wrap><button type="button" class="models" data-models aria-expanded="false" aria-controls="models-pop" title="${t("Models: collecting the stats…")}"><span class="dot" data-state="pending" aria-hidden="true"></span><span>models</span><span class="free" data-badge hidden></span></button>
<div id="models-pop" class="pop" role="dialog" aria-label="${t("Models")}" hidden><div data-models-body>${modelsPending()}</div></div></div>
<span class="live" data-state="connecting" role="status" title="${chrome.address}"><span class="dot" aria-hidden="true"></span><span class="label">${t("connecting…")}</span></span>
<button type="button" class="theme notify" data-notify aria-pressed="false" aria-label="${t("System notifications when a run waits for you")}" title="${t("System notifications when a run waits for you")}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.75a4 4 0 0 0-4 4v2.6L2.75 11h10.5L12 8.35v-2.6a4 4 0 0 0-4-4zM6.5 13a1.5 1.5 0 0 0 3 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"></path></svg></button>
<button type="button" class="theme" data-theme-switch aria-label="${t("Switch the theme")}" title="${t("Switch the theme")}"><svg class="moon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path></svg><svg class="sun" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"></circle><path d="M8 1v1.75M8 13.25V15M1 8h1.75M13.25 8H15M3.05 3.05l1.24 1.24M11.71 11.71l1.24 1.24M3.05 12.95l1.24-1.24M11.71 4.29l1.24-1.24" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path></svg></button>
${chrome.report ? html`<a class="theme" href="/report${chrome.runId ? `?run=${shortRunId(chrome.runId)}` : ""}" aria-label="${t("Report a problem in Jarvis")}" title="${t("Report a problem in Jarvis")}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 6h5v3.5a2.5 2.5 0 0 1-5 0zM6 6V4.75a2 2 0 0 1 4 0V6M2.5 8.5h3M10.5 8.5h3M3 5l2.5 1.5M13 5l-2.5 1.5M3 13l2.5-1.5M13 13l-2.5-1.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"></path></svg></a>` : ""}
${langSwitch(chrome.path ?? "/")}
${chrome.canStart ? html`<a class="btn primary small newtask-btn" href="/#new" data-new-task title="${t("New task (N)")}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"></path></svg>${t("New task")}<kbd aria-hidden="true">N</kbd></a>` : ""}
</div>
</div></header>
${
  (chrome.egress && chrome.egress.length > 0) || (chrome.modelEgress && chrome.modelEgress.length > 0)
    ? html`<div class="egress" role="note"><div class="wrap">${(chrome.egress ?? []).map(
        (n) =>
          html`<p><span aria-hidden="true">⚠</span> <b>dataClass ${n.dataClass}</b> — ${th("MCP server {server} goes to the {network} by an exception, reads only: {reason}", { server: html`<code>${n.server}</code>`, network: n.network, reason: n.reason })}</p>`,
      )}${(chrome.modelEgress ?? []).map(
        (n) =>
          html`<p><span aria-hidden="true">⚠</span> <b>dataClass ${n.dataClass}</b> — ${th("model {model} is a cloud model, allowed by an exception: {reason}", { model: html`<code>${n.model}</code>`, reason: n.reason })}</p>`,
      )}</div></div>`
    : ""
}
<main id="main" class="wrap">
${chrome.back ? html`<nav class="crumb" aria-label="${t("Back")}"><a href="${chrome.back.href}">← ${chrome.back.label}</a></nav>` : ""}
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
  if (m < 1) return t("just now");
  if (m < 60) return units(`${m}m`);
  const h = Math.floor(m / 60);
  return units(h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`);
}

/** How long, in the page's language. */
const duration = (ms: number): string => units(durationEn(ms));
/** When a wait ends, in the page's language. */
const whenText = (iso: string | undefined, now?: number): string => when(whenTextEn(iso, now));

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
/** A process drives it now: it can stop at a safe point and keep its place. */
const pausable = (page: Pick<RunPage, "run" | "leaseLive">): boolean =>
  page.run.state === "RUNNING" && page.leaseLive === true && !cancelling(page.run);

function statePill(run: Run, extra?: string): Html {
  if (cancelling(run))
    return html`<span class="pill bad"><span class="spin" aria-hidden="true"></span> ${t("CANCELLING")}</span>`;
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
  const label = s === "WAITING_BUDGET" ? t("PAUSED · waits for quota") : t(s);
  return html`<span class="pill ${tone}">${glyph} ${label}${extra ? ` · ${extra}` : ""}</span>`;
}

/** A file of the run as a link to the editor (refs.ts). */
/** The script's strings in the page's language; nothing on an English page. */
function clientStrings(): Html | string {
  if (lang() === "en") return "";
  const dict = Object.fromEntries(CLIENT_STRINGS.map((k) => [k, t(k)]));
  return raw(
    `<script type="application/json" id="jarvis-strings">${JSON.stringify(dict).replace(/</g, "\\u003c")}</script>`,
  );
}

const fileRef = (path: string, line?: number): Html => raw(fileRefHtml(path, line));

function changeLine(c: Change): Html {
  const code = c.code === "??" ? "+" : c.code;
  const tone = code === "D" ? "bad" : code === "+" || code === "A" ? "ok" : "warn";
  return html`<span><span class="${tone}">${code}</span> ${code === "D" ? c.file : fileRef(c.file)}</span>`;
}

function terminalHint(card: WaitCard, terminal: boolean, run: Run): Html {
  const cmd = `jarvis continue ${shortRunId(run.id)}`;
  if (terminal)
    return html`<p class="hint">${t("A terminal waits at this card: what you decide there shows here, and the other way round.")}</p>`;
  const key =
    card.kind === "loop"
      ? html` (<code>r</code> ${t("runs {step} again", { step: card.step })})`
      : card.kind === "budget"
        ? html` (<code>enter</code> ${t("more")}, <code>f</code> ${t("finish")})`
        : "";
  return html`<div class="actions"><span class="hint">${t("Decide in the terminal:")} <code>${cmd}</code>${key}</span><button type="button" class="btn" data-copy="${cmd}">${t("Copy command")}</button></div>`;
}

/* ---- runs ---- */

/** A module research whose candidate waits for a review on the Modules page. */
function candidateCardHtml(c: WaitingCandidate, now: number): Html {
  const href = `/knowledge/modules?path=${encodeURIComponent(c.module)}`;
  return html`<article class="panel card">
<div class="row"><span class="pill info">⏸ ${t("knowledge · module")}</span><span class="meta">onboard-module · ${c.run} · ${t("waiting {ago}", { ago: ago(c.at, now) })}</span></div>
<h3>${t("Review what the research found:")} <code>${c.module}</code></h3>
<p>${c.claims ? t("{kept} of {proposed} claims confirmed against the code", { kept: c.claims.kept, proposed: c.claims.proposed }) : t("A module document")}${c.review > 0 ? ` · ${t("{n} to check", { n: plural(c.review, "generalisation") })}` : ""}. ${t("Nothing is written until you accept it.")}</p>
<div class="actions"><a class="btn primary" href="${href}">${t("Review the module")}</a><a class="btn" href="/runs/${encodeURIComponent(c.run)}">${t("Open the run")}</a></div>
</article>`;
}

function waitingCardHtml(w: WaitingRun, now: number, actions?: Actions): Html {
  const { run, card } = w;
  const meta = html`<span class="meta">${run.workflow} · ${shortRunId(run.id)} · ${t("waiting {ago}", { ago: ago(run.updatedAt, now) })}${w.terminal ? ` · ${t("a terminal waits")}` : ""}</span>`;
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
    const more = card.reasons.length > 2 ? ` ${t("+{n} more", { n: card.reasons.length - 2 })}` : "";
    return html`<article class="panel card">
<div class="row"><span class="pill wait">⏸ ${card.tests ? t("tests failed") : t("loop used up")} · ${card.step}</span>${meta}</div>
<h3>${firstLine(run.task)}</h3>
<p>${card.iterations ? t("{step} sent the work back {times}", { step: card.step, times: plural(card.iterations, "time") }) : t("{step} sent the work back too often", { step: card.step })}${card.reasons.length > 0 ? html`: ${reasons}${more}` : "."}</p>
<div class="actions">${resume}<a class="${primary}" href="${runHref(run)}">${t("Open the run")}</a>${actions ? form(actions, `${runHref(run)}/open`, html`<button type="submit" class="btn">${t("Open in editor")}</button>`) : ""}</div>
</article>`;
  }
  if (card.kind === "budget") {
    const s = card.stop;
    return html`<article class="panel card">
<div class="row"><span class="pill wait">⏸ ${t("budget")} · ${s.stepId}</span>${meta}</div>
<h3>${firstLine(run.task)}</h3>
<p>${t("{step} stopped at {used} of {cap} {unit}", { step: s.stepId, used: amount(s.used), cap: amount(s.cap), unit: unitOf(s.dimension) })} — ${sourceOf(s)}.${card.granted ? html` <span class="ok">${grantText(s, card.granted)}</span>` : ""}</p>
<div class="actions">${resume}<a class="${primary}" href="${runHref(run)}">${t("Open the run")}</a></div>
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
<div class="row"><span class="pill info">⏸ ${t("approval")} · ${card.type}</span>${meta}</div>
<h3>${firstLine(run.task)}</h3>
${gist ? html`<p>${gist}</p>` : ""}
${card.decision ? html`<p class="ok">${decisionText(card)}${w.terminal ? ` — ${t("the terminal goes on")}` : resume ? ` — ${t("nothing goes on with it yet")}` : html` — ${t("the run waits for")} <code>jarvis continue</code>`}</p>` : ""}
<div class="actions">${resume}<a class="${primary}" href="${artifactHref(run, card.artifact)}">${t("Review the {type}", { type: card.type })}</a><a class="btn" href="${runHref(run)}">${t("Open the run")}</a></div>
</article>`;
  }
  if (card.kind === "clarify") {
    const question = card.messages.find((m) => m.role === "jarvis")?.text ?? "";
    return html`<article class="panel card">
<div class="row"><span class="pill wait">⏸ ${t("clarification")} · ${card.thread.stepId}</span>${meta}</div>
<h3>${firstLine(run.task)}</h3>
${question ? html`<p>${cut(question, 220)}</p>` : ""}
${card.proposal ? html`<p class="ok">${t("Jarvis proposes a rule — accept it or answer on")}</p>` : ""}
<div class="actions"><a class="btn primary" href="${runHref(run)}#decision">${t("Answer")}</a></div>
</article>`;
  }
  if (card.kind === "effect")
    return html`<article class="panel card">
<div class="row"><span class="pill wait">⏸ ${t("did it happen?")} · ${card.capability}</span>${meta}</div>
<h3>${firstLine(run.task)}</h3>
<p>${t("{step} started {capability} and lost track of whether it finished.", { step: card.step, capability: card.capability })}</p>
<div class="actions"><a class="btn primary" href="${runHref(run)}#decision">${t("Decide")}</a></div>
</article>`;
  if (card.kind === "scope")
    return html`<article class="panel card">
<div class="row"><span class="pill wait">⏸ ${t("spans services")} · ${[...new Set(card.report.spans.map((x) => x.service))].join(", ")}</span>${meta}</div>
<h3>${firstLine(run.task)}</h3>
<p>${t("The impact reaches other services: on as a task across services, or only {service}", { service: card.report.service })}</p>
<div class="actions"><a class="btn primary" href="${runHref(run)}#decision">${t("Decide")}</a></div>
</article>`;
  if (card.kind === "conflict") {
    return html`<article class="panel card">
<div class="row"><span class="pill wait">⏸ ${t("conflict")} · ${card.step}</span>${meta}</div>
<h3>${firstLine(run.task)}</h3>
<p>${t("{step} and a hand edit both changed {files}:", { step: card.step, files: plural(card.files.length, "file") })} ${cut(card.files.join(", "), 160)}${card.resolved ? html` <span class="ok">— ${t("decided: {choice}", { choice: card.resolved.choice })}</span>` : ""}</p>
<div class="actions">${resume}<a class="${primary}" href="${runHref(run)}#decision">${card.resolved ? t("Open the run") : t("Decide")}</a></div>
</article>`;
  }
  if (card.kind === "contract")
    return html`<article class="panel card">
<div class="row"><span class="pill wait">⏸ ${t("contract change")}${card.request ? html` · <code>${card.request.item}</code>` : ""}</span>${meta}</div>
<h3>${firstLine(run.task)}</h3>
<p>${t("The subtask asks its master to change the contract; decide on the master's page")}</p>
<div class="actions"><a class="btn primary" href="/runs/${shortRunId(card.master.id)}#contract-requests">${t("Open the master")}</a></div>
</article>`;
  return html`<article class="panel card">
<div class="row"><span class="pill wait">⏸ ${card.what}</span>${meta}</div>
<h3>${firstLine(run.task)}</h3>
<p>${t("Answer in the terminal:")} <code>jarvis continue ${shortRunId(run.id)}</code></p>
<div class="actions"><a class="btn primary" href="${runHref(run)}">${t("Open the run")}</a></div>
</article>`;
}

function decisionText(card: ApprovalCard): string {
  const d = card.decision;
  if (!d) return "";
  const verb =
    d.approval.decision === "approve"
      ? `✓ ${t("accepted")}`
      : d.approval.decision === "reject"
        ? `✗ ${t("rejected")}`
        : `↻ ${t("sent back")}`;
  return `${verb} ${t("by {who}", { who: d.approval.actor.id })}${d.channel === "ui" ? ` ${t("in the browser")}` : d.channel === "cli" ? ` ${t("in the terminal")}` : ""}`;
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
  if (!step) return html`${t("starting…")}`;
  // the tools of the last answer still run: the model is not asked yet
  if (a.batch?.running)
    return html`${t("model call {n} asked for {tools} · running them", { n: a.batch.modelCall, tools: plural(a.batch.size, "tool") })}`;
  if (a.waitingMs === undefined) return html`${plural(step.modelCalls, "model call")}`;
  const coming = a.receiving
    ? a.receiving.outputChars > 0
      ? `, ${t("receiving ~{n} tok", { n: kilo(Math.round(a.receiving.outputChars / 4)) })}`
      : `, ${t("thinking ~{n} tok", { n: kilo(Math.round(a.receiving.reasoningChars / 4)) })}`
    : "";
  const retry = a.retrying
    ? `, ${t("retry {n} after {why}", { n: a.retrying.attempt, why: a.retrying.reason })}`
    : "";
  // a stream that began and went quiet (it reports every few seconds): a slow or stuck provider, say so
  const quiet =
    a.receiving && a.quietMs !== undefined && a.quietMs >= QUIET_MS
      ? html`, <span class="warn">${t("nothing from the model for")} ${ticking(a.quietMs)}</span>`
      : "";
  if (a.compacting)
    return html`${compactingText(a.compacting)}, ${ticking(a.compacting.ms)}${coming}${quiet}${retry}`;
  return html`${t("model call {n}, waiting", { n: step.modelCalls + 1 })} ${ticking(a.waitingMs)}${coming}${quiet}${retry}`;
}

/** `[8/18] implementation#2 · model call 12, waiting 0:21, receiving ~1.1k tok` */
function activityText(a: Activity | undefined, position?: { index: number; total: number }): Html {
  if (!a?.step) return html`${t("starting…")}`;
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
  return html`<div class="bar" role="img" aria-label="${max ? t("{n} of {m} tool calls used", { n: used, m: max }) : plural(used, "tool call")}"><span style="width:${pct}%"></span></div>
<span class="meta">${t("tools")} ${max ? `${used}/${max}` : used}${since ? html` · ${since}` : ""}${step && step.modelCalls > 1 && used > 0 ? html` · ${perCall(used, step.modelCalls, t("tools per model call"))}` : ""}</span>`;
}

function recentState(run: Run): Html {
  const why = run.stateReason ? ` · ${cut(reasonText(run.stateReason), 48)}` : "";
  switch (run.state) {
    case "COMPLETED":
      return html`<span class="ok">✓ ${t("COMPLETED")}</span>`;
    case "FAILED":
      return html`<span class="bad">✗ ${t("FAILED")}${why}</span>`;
    case "CANCELLED":
      return html`<span class="muted">– ${t("CANCELLED")}${why}</span>`;
    case "RUNNING":
      return html`<span class="warn">⏸ ${t("interrupted")} · <code>jarvis resume</code></span>`;
    case "WAITING_BUDGET":
      return html`<span class="warn">⏸ ${run.waitingFor?.kind === "model" ? t("waits for the model") : t("waits for quota")}</span>`;
    default:
      return html`<span class="muted">${run.state}${why}</span>`;
  }
}

export function repoPicker(page: RunsPage): Html {
  if (page.repos.length < 2) return html``;
  return html`<form class="repo" method="get" action="/"><label class="sr" for="repo">${t("Repository")}</label>
<select id="repo" name="repo" data-autosubmit title="${page.repos.find((r) => r.root === page.repo)?.root ?? t("all repositories")}">
<option value=""${page.repo ? "" : html` selected`}>${t("all repositories")}</option>
${page.repos.map((r) => html`<option value="${r.root}" title="${r.root}"${r.root === page.repo ? html` selected` : ""}>${r.name.length > 32 ? `${r.name.slice(0, 31)}…` : r.name} (${r.runs})</option>`)}
</select><button type="submit" class="btn sr">${t("Show")}</button></form>`;
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

export type { StartForm } from "./newTask.ts";

const home = (path: string, dir: string) =>
  dir && path.startsWith(`${dir}/`) ? `~${path.slice(dir.length)}` : path;

/** `20:35` today, `Oct 3, 14:10` before. */
function whenShort(iso: string, now: number): string {
  const d = new Date(iso);
  const hm = wallClock(iso).slice(0, 5);
  return d.toDateString() === new Date(now).toDateString()
    ? hm
    : `${d.toLocaleString("en-US", { month: "short", day: "numeric" })}, ${hm}`;
}

/**
 * Under "New task": a cancelled or failed run of the same task and workflow that can start again from
 * a step (src/app/restart.ts) — offered, not picked: the new task starts from the beginning otherwise.
 */
export function restartHintHtml(run: Run, plan: RestartPlan, actions: Actions): Html {
  const short = shortRunId(run.id);
  const kept = plan.steps.slice(
    0,
    plan.steps.findIndex((s) => s.id === plan.startAt),
  );
  const approved = kept.filter((s) => s.approved && s.kind !== "approval").map((s) => s.id);
  const gates = kept.filter((s) => s.kind === "approval" && s.approved).length;
  const what = kept
    .filter((s) => s.kind !== "approval")
    .map((s) => (approved.includes(s.id) ? `${s.id} (${t("approved")})` : s.id));
  return html`<div class="banner info"><b>${run.state === "FAILED" ? t("A failed {workflow} of this task", { workflow: run.workflow }) : t("A cancelled {workflow} of this task", { workflow: run.workflow })}</b> (<a href="/runs/${short}">${short}</a>${run.currentStep ? `, ${t("stopped at {step}", { step: run.currentStep })}` : ""}) ${th("can start again from {step}: {kept} go in", { step: html`<b>${plan.startAt}</b>`, kept: what.join(", ") })}${gates > 0 ? `, ${t("{n} kept", { n: plural(gates, "approval") })}` : ""}. ${form(actions, `/runs/${short}/restart`, html`<input type="hidden" name="step" value="${plan.startAt}"><button type="submit" class="btn">${t("Start again from {step}", { step: plan.startAt })}</button>`, ' style="display:inline"')}</div>`;
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
    return html`<p class="hint">${key ? t("No finished research of {key} in this repository — {workflow} runs from the start.", { key, workflow: input.workflow }) : t("No finished research of this task in this repository — {workflow} runs from the start.", { workflow: input.workflow })}</p>`;
  const r = point.run;
  const stale = isStale(point);
  const facts = [
    shortRunId(r.id),
    ...(point.contradictions > 0 ? [plural(point.contradictions, "contradiction")] : []),
    ...(point.since && !stale
      ? [
          point.since.commits === 0
            ? t("no new commits since")
            : t("{n} since, none touch what it read", { n: plural(point.since.commits, "commit") }),
        ]
      : []),
    ...(point.since ? [] : [t("can't tell whether the code changed since")]),
  ];
  const touched = point.since?.touched ?? [];
  const shown = touched.slice(0, 3);
  return html`<div class="from">
<label class="check"><input type="checkbox" name="from" value="${r.id}"${stale ? "" : " checked"}> <span><b>${t("Start from the {workflow} of {when}", { workflow: r.workflow, when: whenShort(r.updatedAt, now) })}</b> <span class="meta">— ${facts.join(" · ")}</span></span></label>
${
  stale
    ? html`<p class="sub warn">⚠ ${th("code changed since: {commits}, {files} it read among them ({list}) — a new research is safer", { commits: plural(point.since?.commits ?? 0, "commit"), files: plural(touched.length, "file"), list: html`${shown.map((f, i) => html`${i > 0 ? ", " : ""}${fileRef(f)}`)}${touched.length > shown.length ? ", …" : ""}` })}</p>`
    : ""
}
<p class="sub hint">${stale ? t("Unchecked: {workflow} runs from the start, with a new research.", { workflow: input.workflow }) : t("{workflow} begins at {step} with it; the steps it did are not run again.", { workflow: input.workflow, step: point.continuation.startAt })} <a href="/runs/${shortRunId(r.id)}" target="_blank" rel="noopener">${t("Open the {workflow}", { workflow: r.workflow })}</a></p>
</div>`;
}

function launchHtml(l: LaunchView, now: number, homeDir: string): Html {
  return html`<a class="launch-link" href="/launches/${l.id}">${launchRow(l, now, homeDir)}</a>`;
}

function launchRow(l: LaunchView, now: number, homeDir: string): Html {
  const age = ticking(now - Date.parse(l.startedAt));
  if (l.exitCode !== null)
    return html`<div class="panel running launch failed">
<div class="what"><b>${firstLine(l.task)}</b><span class="meta">${l.workflow} · ${l.exitCode === 0 ? t("ended without a run") : t("failed to start (exit {code})", { code: l.exitCode })} · ${t("log")} ${home(l.log, homeDir)}</span>
${l.tail ? html`<pre class="tail">${l.tail}</pre>` : ""}</div></div>`;
  return html`<div class="panel running launch">
<div class="what"><b>${firstLine(l.task)}</b><span class="meta">${l.workflow} · ${t("starting")} ${age} · ${t("preparing the checkout (a workspace setup can take minutes)")} · ${t("log")} ${home(l.log, homeDir)}</span></div>
<span class="spin" aria-hidden="true"></span></div>`;
}

export function runsContent(page: RunsPage, now: number, actions?: Actions, start?: StartForm): Html {
  const waits = page.waiting.length + page.candidates.length;
  const sum = [
    plural(waits, "waits for you", "wait for you"),
    plural(page.running.length, "running", "running"),
    t("{n} today", { n: page.today.runs }),
    t("{calls} today", { calls: plural(page.today.modelCalls, "model call") }),
  ].join(" · ");
  const launches = start?.launches ?? [];
  return html`<div class="lede" data-live="lede"><h1>${t("Runs")}</h1><span class="muted">${sum}</span></div>
${start?.notice ?? ""}
${page.evalNotices.map(evalNoticeHtml)}
${start && actions ? newTaskHtml(start, actions) : ""}
<section class="group" aria-labelledby="waits" data-live="waiting">
<h2 id="waits">${t("Waits for you")}</h2>
${
  waits > 0
    ? html`<div class="cards">${page.waiting.map((w) => waitingCardHtml(w, now, actions))}${page.candidates.map((c) => candidateCardHtml(c, now))}</div>`
    : html`<div class="panel empty">${t("Nothing waits for you.")}</div>`
}
</section>
${((w) =>
  w
    ? dockHtml(
        html`<span class="pill wait">${plural(waits, "waits", "wait")}</span><div class="what"><b>${firstLine(w.run.task, 120)}</b><span>${w.run.workflow} · ${w.run.currentStep ?? ""} · ${t("waiting {ago}", { ago: ago(w.run.updatedAt, now) })}</span></div><span class="grow"></span>${start && actions ? html`<span class="hint">${t("New task")} <kbd class="key">N</kbd></span>` : ""}${actions && w.card.kind === "loop" ? form(actions, `${runHref(w.run)}/open`, html`<button type="submit" class="btn">${t("Open in editor")}</button>`) : ""}<a class="btn primary" href="${runHref(w.run)}">${t("Open the run")}</a>`,
      )
    : dockHtml(""))(page.waiting[0])}
<section class="group" aria-labelledby="running" data-live="running">
<h2 id="running">${t("Running")}</h2>
${launches.map((l) => launchHtml(l, now, start?.homeDir ?? ""))}
${
  page.running.length > 0 || launches.length > 0
    ? page.running.map((r) =>
        r.wait
          ? html`<div class="panel running paused">
<div class="what"><a href="${runHref(r.run)}">${firstLine(r.run.task)}</a><span class="meta">${r.run.workflow} · ${shortRunId(r.run.id)} · ⏸ ${r.wait.kind === "model" ? t("waits for the model {model}", { model: r.wait.model ?? "" }) : r.wait.pool ? t("waits for the quota window of {pool}", { pool: r.wait.pool }) : t("waits for the quota window")} · ${t("goes on {when}", { when: whenText(r.wait.resumeAfter, now) })}</span></div>
<a href="${runHref(r.run)}">${t("Open")}</a>
</div>`
          : html`<div class="panel running">
<div class="what"><a href="${runHref(r.run)}">${firstLine(r.run.task)}</a><span class="meta">${cancelling(r.run) ? html`<span class="bad">${t("cancelling…")}</span> · ` : ""}${r.run.workflow} · ${shortRunId(r.run.id)} · ${activityText(r.activity, r.position)}${r.planProgress ? html` · <b class="planat">${t("plan {at}", { at: planAt(r.planProgress) })}</b>${r.planProgress.current !== undefined ? ` ${cut(r.planProgress.steps[r.planProgress.current]?.description ?? "", 70)}` : ""}` : ""}</span></div>
<div class="budget">${toolBudget(r.activity, now)}</div>
<a href="${runHref(r.run)}">${t("Follow")}</a>
</div>`,
      )
    : html`<div class="panel empty">${t("Nothing runs now.")}</div>`
}
</section>
${evalsGroupHtml(page)}
<section class="group" aria-labelledby="recent">
<div class="group-head"><h2 id="recent">${t("Recent")}</h2>
<form class="search" role="search" method="get" action="/">
<input type="search" name="q" value="${page.recent.query}" placeholder="${t("Search runs: id, task, state…")}" title="${t("Every word in some field: id, task, workflow, state and its reason, author, repository, branch, step, date; a quoted phrase as a whole")}" aria-label="${t("Search runs")}" autocomplete="off" data-search>
<input type="hidden" name="repo" value="${page.repo ?? ""}"><button type="submit" class="btn sr">${t("Search")}</button>
</form></div>
${recentHtml(page)}
</section>`;
}

/** A scheduled eval suite whose last run regressed against its baseline or did not run (src/evals/schedule.ts). */
function evalNoticeHtml(o: ScheduledEvalOutcome): Html {
  const cmd = `jarvis evals diff ${o.suite}`;
  return html`<div class="banner bad" role="status">${
    o.error
      ? th("Scheduled evals: suite {suite} did not run — {error}", {
          suite: html`<b>${o.suite}</b>`,
          error: o.error.slice(0, 200),
        })
      : th("Scheduled evals: suite {suite} regressed against its baseline — {what}", {
          suite: html`<b>${o.suite}</b>`,
          what: o.regressions.join("; "),
        })
  } <span class="meta">${o.at.slice(0, 16).replace("T", " ")} · ${t("pool {pool}", { pool: o.pool })}</span> <code>${o.error ? "jarvis evals schedule" : cmd}</code></div>`;
}

/** Why a run is worth an eval case, in a line (src/evals/candidates.ts). */
export function evalReasonText(r: CandidateReason): string {
  if (r.kind === "sent-back")
    return t("{type} sent back {times}", { type: r.type, times: plural(r.times, "time") });
  if (r.kind === "loop")
    return t("back edge {edge} went round {times}", { edge: r.edge, times: plural(r.times, "time") });
  return t("{type} edited by a person (versions {versions})", {
    type: r.type,
    versions: r.versions.join(", "),
  });
}

/** Finished runs worth keeping as eval cases: each with why, the page that makes the case. */
function evalsGroupHtml(page: RunsPage): Html | string {
  const list = page.evalCandidates;
  if (list.length === 0) return "";
  const shown = list.slice(0, 5);
  return html`<section class="group" aria-labelledby="eval-candidates">
<h2 id="eval-candidates">${t("Worth keeping as eval cases")}</h2>
${shown.map(
  (c) => html`<div class="panel running">
<div class="what"><a href="/runs/${shortRunId(c.runId)}">${firstLine(c.task)}</a><span class="meta">${c.workflow} · ${shortRunId(c.runId)} · ${c.reasons.map(evalReasonText).join("; ")}</span></div>
<a href="/runs/${shortRunId(c.runId)}#decision">${t("Open")}</a>
</div>`,
)}
${list.length > shown.length ? html`<p class="hint">${th("{n} more: {cmd}", { n: list.length - shown.length, cmd: html`<code>jarvis evals candidates</code>` })}</p>` : ""}
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
      ? html`<div class="sizes" role="group" aria-label="${t("Rows per page")}">${RECENT_SIZES.map((n) =>
          n === list.pageSize
            ? html`<a href="${href(1, n)}" data-size="${String(n)}" aria-current="true">${String(n)}</a>`
            : html`<a href="${href(1, n)}" data-size="${String(n)}">${String(n)}</a>`,
        )}</div>`
      : html``;
  const pages =
    list.total > list.pageSize
      ? html`<span class="pages">${list.page > 1 ? html`<a href="${href(list.page - 1)}" rel="prev">${t("← Newer")}</a>` : html`<span class="muted">${t("← Newer")}</span>`}<span class="muted">${t("{from}–{to} of {total}", { from, to, total: list.total })}</span>${list.page < last ? html`<a href="${href(list.page + 1)}" rel="next">${t("Older →")}</a>` : html`<span class="muted">${t("Older →")}</span>`}</span>`
      : list.query && list.total > 0
        ? html`<span class="pages muted">${t("{n} found", { n: list.total })}</span>`
        : html``;
  const pager =
    list.total > RECENT_SIZES[0] || (list.query && list.total > 0)
      ? html`<nav class="pager" aria-label="${t("Recent runs, pages")}">${sizes}${pages}</nav>`
      : html``;
  const body =
    list.runs.length > 0
      ? html`<div class="panel scroll recent"><table>
<thead><tr><th scope="col">Run</th><th scope="col">${t("Task")}</th><th scope="col">Workflow</th><th scope="col">${t("State")}</th><th scope="col">${t("Took")}</th><th scope="col">${t("Model")}</th></tr></thead>
<tbody>${list.runs.map(
          (r) =>
            html`<tr><td class="mono"><a href="${runHref(r.run)}">${marked(shortRunId(r.run.id), list.terms)}</a></td><td>${marked(firstLine(r.run.task, 90), list.terms)}</td><td>${marked(r.run.workflow === "sdd-cross" ? "sdd (cross-repos)" : r.run.workflow, list.terms)}${r.run.options?.parent ? html` <span class="meta" title="${t("a subtask of a task across services")}">· ${t("subtask {key} of", { key: r.run.options.parent.key })} <a href="/runs/${shortRunId(r.run.options.parent.runId)}">${shortRunId(r.run.options.parent.runId)}</a></span>` : ""}</td><td>${recentState(r.run)}</td><td>${duration(r.tookMs)}</td><td class="muted">${plural(r.modelCalls, "call")}</td></tr>`,
        )}</tbody></table></div>`
      : list.query
        ? html`<div class="panel empty">${t("No runs match «{q}».", { q: list.query })}</div>`
        : html`<div class="panel empty">${t("No runs yet.")}</div>`;
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
  return html`<span class="kpi" title="${t("tool calls per model call: independent reads in one turn")}">⇉ ${(tools / calls).toFixed(1)} ${label}</span>`;
}

/** `repo.read` → `read`, `confluence.get` → `confluence`: what a lane did, short. */
/** A short label that fits the lane: `read`, `search`, `knowledge`, `jira`. */
function verbOf(capability: string): string {
  return capability
    .replace(/^repo\./, "")
    .replace(/^knowledge\.read$/, "knowledge")
    .replace(/^knowledge\./, "k.")
    .replace(/\.get$/, "");
}

/** `12ms`, `0.4s`, `3.1s`. */
function quick(ms: number): string {
  return ms < 100 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The tools of one answer as lanes on one clock: which ran side by side, which held the batch up. */
function batchHtml(b: ToolBatch): Html {
  const total = Math.max(1, b.ms);
  const done = b.calls.filter((c) => c.ok !== undefined).length;
  const head = b.parallel ? `⇉ ${t("{n} in parallel", { n: b.size })}` : t("{n} in a row", { n: b.size });
  const state = b.running
    ? `· ${t("{t} so far", { t: quick(b.ms) })} · ${t("{n} done", { n: done })}`
    : `· ${t("the last batch, model call {n}", { n: b.modelCall })} · ${quick(b.ms)}`;
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
  return html`<div class="lane">${mark}<span class="k" title="${c.capability}">${verbOf(c.capability)}</span><span class="p">${c.detail ?? ""}</span><span class="track"><span${c.ok === undefined ? html` class="run"` : ""} style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></span></span><span class="t">${quick(c.ms)}${c.ok === undefined ? "…" : ""}</span></div>`;
})}
</div>`;
}

/* ---- one run ---- */

/** Under a step: the skills its agent got, and why — named by the workflow, or picked by the task. */
function stepSkillsHtml(k: StepSkills): Html {
  const names = k.refs.map((r) => r.replace(/^skill:/, ""));
  const why =
    k.how === "step"
      ? t("named by the workflow step")
      : t("picked by {what}", {
          what: [
            k.kind ? t("kind {kind}", { kind: k.kind }) : "",
            ...(k.stacks.length > 0 ? [t("stack {stacks}", { stacks: k.stacks.join(", ") })] : []),
          ]
            .filter(Boolean)
            .join(", "),
        });
  return html`<span class="note">${t("skills:")} ${names.length > 0 ? names.join(", ") : t("none")} — ${why}${k.missing.length > 0 ? html` · <span class="bad">${t("no such skill: {ids}", { ids: k.missing.join(", ") })}</span>` : ""}</span>`;
}

function stepRow(s: StepRow, now: number, plan?: PlanProgress): Html {
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
    if (r.quick?.used) notes.push(`${r.quick.tool}, ${t("no model call")}`);
    else if (r.agent) notes.push(r.agent);
    if (r.modelCalls > 0) notes.push(plural(r.modelCalls, "call"));
    if (r.tools && Object.keys(r.tools).length > 0) notes.push(toolMix(r.tools));
    // tool definitions a fifth of the input or more: worth seeing (ADR-0013 §5)
    if (r.toolSchema && r.toolSchema.share >= 0.2)
      notes.push(
        t("tool schemas {tokens} — {share}% of the input", {
          tokens: kilo(r.toolSchema.tokens),
          share: Math.round(r.toolSchema.share * 100),
        }),
      );
    const tools = r.tools ? Object.values(r.tools).reduce((n, k) => n + k, 0) : 0;
    if (tools > 0 && r.modelCalls > 1) notes.push(`⇉ ${(tools / r.modelCalls).toFixed(1)} ${t("per call")}`);
    if (r.contradictions)
      notes.push(`⚠ ${t("{n} in the requirements", { n: plural(r.contradictions, "contradiction") })}`);
    if (r.budgetExhausted)
      notes.push(
        r.budgetExhausted === "model"
          ? t("model call limit reached")
          : r.budgetExhausted === "budget"
            ? t("budget limit reached")
            : t("tool limit reached"),
      );
    // the loop's line names the outcome already
    if (r.outcome && r.outcome !== "success" && s.loops.at(-1)?.outcome !== r.outcome) notes.push(r.outcome);
    if (r.status !== "success" && r.reason) notes.push(cut(r.reason, 120));
  }
  if (s.status === "skipped" && r?.reason) notes.push(`${t("skipped")}: ${r.reason}`);
  if (s.carriedFrom)
    notes.unshift(
      t("done in {workflow} {id}", { workflow: s.carriedFrom.workflow, id: shortRunId(s.carriedFrom.id) }),
    );
  const loop = s.loops.at(-1);
  if (loop)
    notes.push(
      `${t("sent the work back to {to}", { to: loop.to })} ${loop.iteration}${loop.max ? `/${loop.max}` : ""} — ${loop.outcome}`,
    );
  if (s.status === "waiting")
    notes.push(s.paused ? t("paused · waits for the quota window") : t("waits for you"));
  if (s.status === "running")
    notes.push(plan ? `${t("running now")} · ${t("plan {at}", { at: planAt(plan) })}` : t("running now"));
  const took =
    s.status === "running" && s.startedAt
      ? ticking(now - Date.parse(s.startedAt))
      : r && s.status !== "skipped"
        ? duration(r.durationMs)
        : "";
  const tone = icon?.[1] === "info" ? "" : icon?.[1];
  return html`<li class="step ${s.status}${s.child ? " child" : ""}${s.status === "waiting" || s.status === "running" ? " focus" : ""}">
<span class="ic ${tone ?? ""}" aria-hidden="true">${icon?.[0] ?? ""}</span>
<span class="nm"><b>${s.id}${iteration}<span class="sr"> — ${s.status}</span></b>${notes.length > 0 ? html`<span class="note">${notes.join(" · ")}</span>` : ""}${s.skills && (s.skills.refs.length > 0 || s.skills.how === "step") ? stepSkillsHtml(s.skills) : ""}</span>
<span class="took">${took}</span>
</li>`;
}

function loopCardHtml(card: LoopCard, page: RunPage, actions?: Actions): Html {
  if (card.tests) return testsCardHtml(card, page, actions);
  const route = card.from ? `${card.from} → ${card.to} · ${card.outcome} · ` : "";
  // the step the used-up edge went back to, when it is another step than the one that stopped
  const back = card.to && card.to !== card.step ? card.to : undefined;
  return html`<section class="panel decision" aria-labelledby="decision" data-live="card">
<div class="row" style="flex-direction:column;align-items:flex-start;gap:4px">
<span class="warn" style="font-size:13px;font-weight:500">${t("Waits for you")}</span>
<h2 id="decision" style="font-size:22px;line-height:28px">${card.iterations ? t("{step} sent the work back {times}", { step: card.step, times: plural(card.iterations, "time") }) : t("{step} sent the work back too often", { step: card.step })} — ${t("no rounds left")}</h2>
<span class="muted" style="font-size:14px">${route}${t("the last round's reasons:")}</span>
</div>
${
  card.reasons.length > 0
    ? html`<ul class="reasons">${card.reasons.map((r) => html`<li>${r.kind ? html`<span class="chip">${r.kind}</span>` : ""}<span>${r.text}</span></li>`)}</ul>`
    : html`<p class="muted">${t("No reason recorded.")}</p>`
}
<div class="checkout">
<span class="muted" style="font-size:14px">${t("Fix it by hand in the run's checkout")}</span>
<div class="row"><code class="path">${card.checkoutShown}</code>${actions ? form(actions, `${runHref(page.run)}/open`, html`<button type="submit" class="btn">${t("Open in editor")}</button>`) : ""}<button type="button" class="btn" data-copy="${card.checkout}">${t("Copy path")}</button></div>
<div class="changed" aria-live="polite"><span class="hint">${t("Changed in the checkout · live")}</span>${
    card.changes && card.changes.length > 0
      ? card.changes.slice(0, 12).map(changeLine)
      : html`<span class="muted">${t("nothing yet")}</span>`
  }${card.changes && card.changes.length > 12 ? html`<span class="muted">+${card.changes.length - 12} more</span>` : ""}</div>
</div>
${
  card.rerun
    ? html`<div class="banner info">↻ ${card.rerun.step && card.rerun.step !== card.step ? t("one more round of {step}, then {next}", { step: card.rerun.step, next: card.step }) : t("{step} runs again", { step: card.step })} — ${t("asked")}${card.rerun.actor ? ` ${t("by {who}", { who: card.rerun.actor })}` : ""}${card.rerun.channel === "ui" ? ` ${t("from the page")}` : card.rerun.channel === "cli" ? ` ${t("in the terminal")}` : ""}</div><div class="actions">${goesOn(page, actions)}</div>`
    : actions
      ? html`<div class="actions">${
          back
            ? form(
                actions,
                `${runHref(page.run)}/rerun`,
                html`<input type="hidden" name="back" value="${back}"><button type="submit" class="btn primary big">${t("One more round of {step}", { step: back })}</button>`,
              )
            : ""
        }${form(actions, `${runHref(page.run)}/rerun`, html`<button type="submit" class="btn${back ? "" : " primary"} big">${t("Run {step} again", { step: card.step })}</button>`)}<span class="hint">${back ? html`${t("one more round: {back} with the reasons above and your notes, then {step}; run again: only {step}, after you fixed the checkout yourself", { back, step: card.step })} (<code>r</code>)` : html`${t("same as")} <code>r</code> ${t("on the terminal's card")}`}; ${page.terminal ? t("the terminal waiting there goes on") : html`${t("no terminal waits:")} <code>jarvis continue ${shortRunId(page.run.id)}</code> ${t("does it")}`}</span></div>
${notesBox(page, back ?? card.step, actions)}`
      : terminalHint(card, page.terminal, page.run)
}
</section>`;
}

const TESTS_TITLE: Record<TestsStop["why"], string> = {
  "same-failure": "Tests failed again the same way",
  "not-started": "The tests did not run",
  "every-failure": "Tests failed",
  "rounds-used-up": "Tests still fail — no rounds left",
};
// the keys of the titles, for the dictionary's check (tests/ui/i18n.test.ts)
// t("Tests failed again the same way") t("The tests did not run") t("Tests failed") t("Tests still fail — no rounds left")

function testsLead(ts: TestsStop, card: LoopCard): Html {
  const back = card.to ?? "the implementation";
  const left = Math.max(0, ts.rounds - ts.round);
  switch (ts.why) {
    case "same-failure":
      return html`${ts.failures.length === 1 ? t("Round {n} failed exactly as round {m}: the same test with the same assertion.", { n: ts.round, m: ts.round - 1 }) : t("Round {n} failed exactly as round {m}: the same {failures}.", { n: ts.round, m: ts.round - 1, failures: plural(ts.failures.length, "failure") })} ${t("Another round with the same input is unlikely to help, so Jarvis asks you before spending it")}${left > 0 ? html` — ${plural(left, "round left", "rounds left")}` : ""}.`;
    case "not-started":
      return html`${t("{checks} stopped before any test ran: the build or the environment broke, not a test. The output below says where; a model rarely fixes that by trying again.", { checks: ts.notStarted.join(", ") })}`;
    case "every-failure":
      return html`${t("The project asks a person on every failed check")} (<code>human.checks.ask: every-failure</code>): ${t("decide what {back} does with it.", { back })}`;
    default:
      return html`${t("{back} had {rounds} and the checks still fail. Decide what happens next.", { back, rounds: plural(ts.rounds, "round") })}`;
  }
}

function roundsStrip(ts: TestsStop): Html {
  return html`<div class="rounds-strip">${ts.history.map(
    (r) =>
      html`<div class="rb${r.failed > 0 || r.notStarted ? " bad" : ""}"><b>${t("Round {n}", { n: r.round })} · ${r.notStarted ? t("no test ran") : r.failed > 0 ? t("{n} failed", { n: r.failed }) : t("passed")}</b><span class="meta">${r.same ? t("the same as round {n}", { n: r.round - 1 }) : r.round === ts.round ? t("this round") : ""}</span></div>`,
  )}</div>`;
}

function roundFailureHtml(f: RoundFailure, repeated: boolean, round: number): Html {
  const title =
    [f.suite?.split(".").at(-1), f.name?.replace(/\(\)$/, "")].filter(Boolean).join(" › ") || f.check;
  return html`<article class="tf">
<div class="tf-head"><h3>${title}</h3>${f.at ? html`<code class="meta">${f.at}</code>` : ""}<span class="grow"></span>${repeated ? html`<span class="pill bad">${t("same as round {n}", { n: round - 1 })}</span>` : ""}<span class="pill plain">${f.check}</span></div>
<dl class="tf-facts">
<dt>${t("Failure")}</dt><dd><pre>${f.message || "—"}</pre></dd>
${f.expected !== undefined && f.actual !== undefined ? html`<dt>${t("Expected")}</dt><dd><code class="ok">${f.expected}</code></dd><dt>${t("Got")}</dt><dd><code class="bad">${f.actual}</code></dd>` : ""}
</dl>
</article>`;
}

/** The choices for failed checks: the person's words go with each (src/ui/server.ts, `/tests`). */
function testsChoices(card: LoopCard, page: RunPage, actions: Actions): Html {
  const ts = card.tests as TestsStop;
  const back = card.to ?? "implementation";
  const choice = (value: string, title: string, about: string, go: string, checked = false) =>
    html`<label class="choice"><input type="radio" name="choice" value="${value}" data-go="${go}"${checked ? " checked" : ""}><span><b>${title}</b><span class="about">${about}</span></span></label>`;
  return form(
    actions,
    `${runHref(page.run)}/tests`,
    html`<fieldset class="choices" data-choices><legend class="sr">${t("What to do")}</legend>
${choice("hint", t("Send back with a hint"), t("{back} gets your words as binding, with these failures and the whole output.", { back }), t("Send back to {back}", { back }), true)}
${choice("test-wrong", t("The test is wrong — let it change the test"), t("{back} changes the test, not the code, and says which and why; review sees it.", { back }), t("Send back: change the test"))}
${choice("myself", t("I fix it myself in the checkout"), t("Then the checks run again — not another round of {back}.", { back }), t("Run {step} again", { step: card.step }))}
${choice("go-on", t("Not this task's — go on without it"), t("{step} counts as passed; the failures stay recorded and the next steps get your words.", { step: card.step }), t("Go on without it"))}
${choice("spec", t("Back to the spec"), t("The task is not what the spec says: the spec gets your words and comes to you again."), t("Back to the spec"))}
</fieldset>
<label class="field grow">${t("Your words — needed for a hint; for the others, why")}<textarea name="text" rows="3" maxlength="4000" placeholder="${ts.failures[0]?.at ? t("«The value comes rounded from {file} — round once, at the end»", { file: ts.failures[0].at.split(":")[0] ?? "" }) : t("A hint, a decision, where to look")}"></textarea></label>
`,
    html` id="tests-form"`,
  );
}

function testsCardHtml(card: LoopCard, page: RunPage, actions?: Actions): Html {
  const ts = card.tests as TestsStop;
  const repeated = new Set(ts.repeated);
  const command = ts.logs[0]?.command;
  return html`<section class="panel decision tests-stop" aria-labelledby="decision" data-live="card">
<div class="row" style="flex-direction:column;align-items:flex-start;gap:4px">
<span class="warn" style="font-size:13px;font-weight:500">${t("Waits for you")} · ${card.step} · ${t("round {n} of {m}", { n: ts.round, m: ts.rounds })}</span>
<h2 id="decision" style="font-size:22px;line-height:28px">${t(TESTS_TITLE[ts.why])}</h2>
<p style="margin:0">${testsLead(ts, card)}</p>
</div>
${roundsStrip(ts)}
${ts.failures.slice(0, 4).map((f) => roundFailureHtml(f, repeated.has(f.signature), ts.round))}
${ts.failures.length > 4 ? html`<p class="hint">${t("{n} more in", { n: ts.failures.length - 4 })} <a href="${ts.checksHref}">${t("the checks of this round")}</a>.</p>` : ""}
${ts.said ? html`<blockquote class="said"><span class="hint">${t("{step}, end of its last round", { step: card.to ?? "implementation" })}</span>${ts.said}</blockquote>` : ""}
<div class="row" style="flex-wrap:wrap;gap:8px 16px">${ts.logs.map((l) => html`<a href="${l.href}">${t("Whole output of {check}", { check: l.check })}</a>`)}<a href="${ts.checksHref}">${t("The checks of round {n}", { n: ts.round })}</a>${command ? html`<code class="meta">${command}</code><button type="button" class="btn small" data-copy="cd ${card.checkout} && ${command}">${t("Copy to run it yourself")}</button>` : ""}</div>
${
  card.rerun || card.goOn
    ? html`<div class="banner info">↻ ${card.goOn ? t("goes on without the failed checks") : card.rerun?.step && card.rerun.step !== card.step ? t("one more round of {step}, then {next}", { step: card.rerun.step, next: card.step }) : t("{step} runs again", { step: card.step })} — ${t("decided")}${(card.goOn ?? card.rerun)?.actor ? ` ${t("by {who}", { who: (card.goOn ?? card.rerun)?.actor ?? "" })}` : ""}</div><div class="actions">${goesOn(page, actions)}</div>`
    : actions
      ? testsChoices(card, page, actions)
      : terminalHint(card, page.terminal, page.run)
}
<details class="checkout-fold"><summary class="meta">${t("The run's checkout")} · ${card.checkoutShown}</summary>
<div class="checkout">
<div class="row"><code class="path">${card.checkoutShown}</code>${actions ? form(actions, `${runHref(page.run)}/open`, html`<button type="submit" class="btn">${t("Open in editor")}</button>`) : ""}<button type="button" class="btn" data-copy="${card.checkout}">${t("Copy path")}</button></div>
<div class="changed" aria-live="polite"><span class="hint">${t("Changed in the checkout · live")}</span>${
    card.changes && card.changes.length > 0
      ? card.changes.slice(0, 12).map(changeLine)
      : html`<span class="muted">${t("nothing yet")}</span>`
  }</div>
</div></details>
</section>`;
}

const amount = (n: number) => n.toLocaleString("en-US");

function grantText(s: BudgetStop, g: NonNullable<BudgetCard["granted"]>): string {
  const what = g.finish
    ? t("{step} finishes with what it has", { step: s.stepId })
    : `+${amount(g.amount ?? 0)} ${unitOf(s.dimension)}`;
  const where =
    g.channel === "ui" ? ` ${t("from the page")}` : g.channel === "cli" ? ` ${t("in the terminal")}` : "";
  return `↻ ${what} — ${t("decided")}${g.actor ? ` ${t("by {who}", { who: g.actor })}` : ""}${where}`;
}

/** The run stopped on a budget: what ran out, then more and go on, or finish with what it has. */
function budgetCardHtml(card: BudgetCard, page: RunPage, actions?: Actions): Html {
  const s = card.stop;
  const unit = unitOf(s.dimension);
  const action = `${runHref(page.run)}/budget`;
  return html`<section class="panel decision" aria-labelledby="decision" data-live="card">
<div class="row" style="flex-direction:column;align-items:flex-start;gap:4px">
<span class="warn" style="font-size:13px;font-weight:500">${t("Waits for you")}</span>
<h2 id="decision" style="font-size:22px;line-height:28px">${t("{step} stopped: {used} of {cap} {unit}", { step: s.stepId, used: amount(s.used), cap: amount(s.cap), unit })}</h2>
<span class="muted" style="font-size:14px">${sourceOf(s)} · ${
    s.scope === "agent"
      ? t("its conversation is kept: more calls go on from where it stopped")
      : t("the step goes on from its last model call; the cap grows for this run only")
  }</span>
</div>
${
  card.changes && card.changes.length > 0
    ? html`<div class="changed"><span class="hint">${t("Changed in the checkout so far")}</span>${card.changes.slice(0, 12).map(changeLine)}${card.changes.length > 12 ? html`<span class="muted">+${card.changes.length - 12} more</span>` : ""}</div>`
    : ""
}
${
  card.granted
    ? html`<div class="banner info">${grantText(s, card.granted)}</div><div class="actions">${goesOn(page, actions)}</div>`
    : actions
      ? html`<div class="actions">${form(
          actions,
          action,
          html`<input type="hidden" name="choice" value="more"><input type="hidden" name="amount" value="${s.suggested}"><button type="submit" class="btn primary big">${t("+{n} {unit} and go on", { n: amount(s.suggested), unit })}</button>`,
        )}${form(
          actions,
          action,
          html`<input type="hidden" name="choice" value="more"><label class="sr" for="budget-amount">${t("How many more {unit}", { unit })}</label><input id="budget-amount" class="amount" type="number" name="amount" min="1" step="1" required placeholder="${t("another amount")}"><button type="submit" class="btn">${t("Grant")}</button>`,
          html` class="row"`,
        )}${form(
          actions,
          action,
          html`<input type="hidden" name="choice" value="finish"><button type="submit" class="btn">${t("Finish with what it has")}</button>`,
        )}</div>
<p class="hint">${t("Finish: the step writes its result from what it has, marked incomplete for the steps after it.")} ${t("Same as")} <code>enter</code> / <code>m</code> / <code>f</code> ${t("on the terminal's card")}; ${page.terminal ? t("the terminal waiting there goes on") : html`${t("no terminal waits:")} <code>jarvis continue ${shortRunId(page.run.id)}</code> ${t("goes on")}`}.</p>`
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
${f?.risks.slice(0, 2).map((r) => html`<p><span class="warn">${t("risk")}</span> ${cut(r, 160)}</p>`) ?? ""}
${card.excerpt ? html`<pre class="path" style="white-space:pre-wrap">${card.excerpt}</pre>` : ""}
${partial ? html`<p class="warn">⚠ ${t("incomplete: agent {agent} hit its {limit} limit", { agent: partial.agentId, limit: partial.limit })}</p>` : ""}
${
  card.files && card.files.length > 0
    ? html`<div class="changed"><span class="hint">${t("{n} changed", { n: plural(card.files.length, "file") })}</span>${card.files
        .slice(0, 8)
        .map(
          (x) =>
            html`<span><span class="ok">+${x.added}</span> <span class="bad">−${x.removed}</span> ${fileRef(x.path)}</span>`,
        )}${card.files.length > 8 ? html`<span class="muted">+${card.files.length - 8} more</span>` : ""}</div>`
    : ""
}`;
}

/** The run page's approval card: into the checkout and start, in one line to paste. */
function tryLine(tr: TryOut): Html {
  return html`<div class="trybar"><span class="lbl">${t("Try it before you decide")}</span><div class="row"><code class="path">${tryCommand(tr)}</code><button type="button" class="btn" data-copy="${tryCommand(tr)}">${t("Copy")}</button></div>${
    tr.start.length === 0
      ? html`<span class="hint">${t("No start command known: set")} <code>workspace.try.run</code> ${t("in .jarvis/project.yaml")}</span>`
      : tr.guessed
        ? html`<span class="hint">${t("start command guessed from package.json — set")} <code>workspace.try.run</code> ${t("to be sure")}</span>`
        : ""
  }</div>`;
}

/**
 * «Try it» on the implementation's page: where the result is, how to start it, what to check by hand,
 * what Accept and Send back lead to. Pilot: «there is no obviousness of the action to accept or not».
 */
function tryHtml(tr: TryOut, page: ArtifactPage, extras: ArtifactExtras): Html {
  const cmd = (c: string) =>
    html`<div class="cmd"><code>${c}</code><button type="button" class="btn small" data-copy="${c}">${t("Copy")}</button></div>`;
  const back = `${artifactHref(page.run, page.artifact)}`;
  return html`<section id="try" class="panel tryit" aria-labelledby="try-h">
<h2 id="try-h">${t("Try it before you decide")}</h2>
<ol class="trysteps">
<li><b>${t("Go to the run's checkout")}</b>${tr.branch ? html` <span class="meta">branch ${tr.branch}</span>` : ""}
<span class="hint">${tr.setup ? html`${t("dependencies are there:")} <code>${tr.setup}</code> ${t("ran when the run started")}` : t("the run's own copy of the repository")}</span>
${cmd(cdTo(tr.checkoutShown))}</li>
<li><b>${t("Start the project")}</b>
${
  tr.start.length > 0
    ? html`${tr.rebuild.length > 0 ? html`<span class="hint">${t("the run changed what the project reads built — rebuild first")} (<code>tools.rebuild</code>)</span>${tr.rebuild.map(cmd)}` : ""}<span class="hint">${tr.guessed ? html`${t("guessed from package.json — set")} <code>workspace.try.run</code> ${t("in .jarvis/project.yaml to be sure")}` : t("from workspace.try in .jarvis/project.yaml")}</span>${tr.start.map(cmd)}`
    : html`<span class="hint warn">${t("no start command known — set")} <code>workspace.try.run</code> ${t("in .jarvis/project.yaml")} (<code>yarn start-dev</code>)</span>`
}${tr.url ? html`<span class="hint">${t("then open")} <a href="${tr.url}" target="_blank" rel="noopener">${tr.url}</a></span>` : ""}${tr.note ? html`<span class="hint">${tr.note}</span>` : ""}</li>
${
  tr.checks.length > 0
    ? html`<li><b>${t("Check by hand")}</b> <span class="hint">${t("the spec's acceptance criteria")}</span>
<ul class="checks">${tr.checks.map(
        (c) =>
          html`<li><span class="rq">${c.id ? html`<b>${c.id}</b> ` : ""}${cut(c.text, 200)}</span><ul>${c.acceptance.map((x) => html`<li><label><input type="checkbox"> ${cut(x, 240)}</label></li>`)}</ul></li>`,
      )}</ul></li>`
    : ""
}
</ol>
<div class="row tryact">${tr.start.length > 0 ? html`<button type="button" class="btn primary" data-copy="${tryCommand(tr)}">${t("Copy: cd and start")}</button>` : ""}${
    extras.actions
      ? form(
          extras.actions,
          `${runHref(page.run)}/open`,
          html`<input type="hidden" name="return" value="${back}"><button type="submit" class="btn">${t("Open in editor")}</button>`,
        )
      : ""
  }${tr.range ? html`<button type="button" class="btn" data-copy="git diff ${tr.range}">${t("Copy git diff")}</button>` : ""}</div>
${
  tr.inRepo
    ? html`<details class="inrepo"><summary>${t("Or in your main repository")}</summary><span class="hint">${t("a branch of your own from the run's branch (the run's branch itself is taken by its checkout); your uncommitted changes go along")}</span>${cmd(cdTo(tr.inRepo.repoShown))}${tr.inRepo.commands.map(cmd)}</details>`
    : ""
}
${tr.verified ? html`<p class="hint">${t("Jarvis already ran: tests")} ${tr.verified.passed ? html`<span class="ok">✓ ${t("passed")}</span>` : html`<span class="bad">✗ ${t("{n} failing", { n: tr.verified.failures })}</span>`}${tr.verified.commands.length > 0 ? html` — ${tr.verified.commands.slice(0, 3).map((c, i) => html`${i > 0 ? ", " : ""}<code>${cut(c, 80)}</code>`)}` : ""}</p>` : ""}
<div class="facts after">${tr.onAccept ? html`<span><b>${t("Accept")}</b> → ${tr.onAccept}; ${t("the branch stays — then")} <b>Apply</b> ${t("on the run's page (or")} <code>${tr.apply}</code>) ${t("lands it on your branch as one commit")}</span>` : ""}${tr.onSendBack ? html`<span><b>${t("Send back")}</b> → ${tr.onSendBack}</span>` : ""}<span><b>${t("Fixed something yourself")}</b> ${t("in the checkout → it goes in as a")} <code>human edit</code> ${t("when the run goes on")}</span></div>
</section>`;
}

function approvalCardHtml(card: ApprovalCard, page: RunPage, actions?: Actions): Html {
  const title = card.facts?.title ?? `${card.type}/${card.artifact.name}`;
  return html`<section class="panel decision" aria-labelledby="decision" data-live="card">
<div class="row" style="flex-direction:column;align-items:flex-start;gap:4px">
<span class="warn" style="font-size:13px;font-weight:500">${t("Waits for you")} · ${t("approve {type}", { type: card.type })}</span>
<h2 id="decision" style="font-size:22px;line-height:28px">${title}</h2>
<span class="meta">${card.type}/${card.artifact.name}@${card.artifact.version}</span>
</div>
${briefHtml(card)}
${card.decision ? html`<div class="banner ok">${decisionText(card)}</div><div class="actions">${goesOn(page, actions)}</div>` : ""}
${card.tryOut && !card.decision ? tryLine(card.tryOut) : ""}
<div class="actions"><a class="btn primary big" href="${artifactHref(page.run, card.artifact)}">${t("Review the {type}", { type: card.type })}</a></div>
${card.decision ? "" : terminalHint(card, page.terminal, page.run)}
</section>`;
}

/** Cancel, in two clicks (no dialogs): as `jarvis cancel` — at once when idle, else at the next safe point. */
function cancelHtml(run: Run, actions: Actions): Html {
  const short = shortRunId(run.id);
  const busy = run.lease !== undefined && Date.parse(run.lease.until) >= Date.now();
  return html`<details class="cancel" data-dismiss><summary class="btn small danger">${t("Cancel run…")}</summary>
<div class="cancel-pop" role="dialog" aria-label="${t("Cancel run {id}", { id: short })}">
<p><b>${t("Cancel run {id}?", { id: short })}</b></p>
<p class="hint">${busy ? t("A process runs it: it stops after its current model or tool call.") : t("Nothing runs it now: it is cancelled at once.")} ${t("The checkout and the artifacts stay; it cannot be resumed.")}</p>
${form(
  actions,
  `/runs/${encodeURIComponent(short)}/cancel`,
  html`<div class="row"><button type="submit" class="btn small danger-fill">${t("Cancel the run")}</button><button type="button" class="btn small" data-close>${t("Keep it")}</button></div>`,
)}
</div>
</details>`;
}

/** A run parked on a quota window or a model: not failed — when it goes on, and who resumes it. */
function waitHtml(page: RunPage, wait: BudgetWait, now: number, actions?: Actions): Html {
  const short = shortRunId(page.run.id);
  const what =
    wait.kind === "model"
      ? html`${t("Waits for the model")} <code>${wait.model ?? "?"}</code> ${t("to answer again")}`
      : html`${t("Waits for the quota window")}${wait.pool ? html` ${t("of pool")} <code>${wait.pool}</code>` : ""}`;
  const who = page.driven
    ? html`<span class="hint">${t("This page resumes it then — keep")} <code>jarvis ui</code> ${t("open.")}</span>`
    : html`<span class="hint">${t("No process waits for it: resume it here, or")} <code>jarvis resume ${short}</code>.</span>`;
  return html`<section class="panel decision budgetwait" aria-labelledby="wait-h" data-live="card">
<div class="row"><span class="pill wait">⏸ ${t("paused, not failed")}</span><h2 id="wait-h">${what}</h2></div>
<p>${t("Goes on by itself at")} <b>${whenText(wait.resumeAfter, now)}</b>.${wait.detail ? html` <span class="hint">${t("Window:")} ${wait.detail}.</span>` : ""}</p>
<div class="actions">${who}${
    actions
      ? html`<form method="post" action="/runs/${encodeURIComponent(short)}/resume"><input type="hidden" name="t" value="${actions.token}"><button type="submit" class="btn">${t("Resume now")}</button></form><span class="hint">${t("tries at once — if the window is still full, it waits again")}</span>`
      : html`<button type="button" class="btn" data-copy="jarvis resume ${short}">${t("Copy command")}</button>`
  }</div>
</section>`;
}

function nowHtml(page: RunPage, now: number, actions?: Actions): Html {
  const a = page.activity;
  if (!a?.step || !page.leaseLive) {
    const stopped =
      page.run.state === "SUSPENDED"
        ? page.run.stateReason?.startsWith("paused")
          ? `${reasonText(page.run.stateReason).split(";")[0]} — ${t("Resume goes on from where it stopped")}`
          : t("stopped with Ctrl-C — it goes on from where it stopped")
        : page.run.state === "RUNNING"
          ? t("no process drives this run (interrupted or crashed)")
          : undefined;
    // failed on the model, not on its own work: when the model answers again, try the step again
    if (page.resumable === "retry") {
      const cmd = `jarvis resume ${shortRunId(page.run.id)}`;
      return html`<section class="panel now" aria-label="${t("Now")}" data-live="card"><div class="row"><span class="bad">✗ ${t("the model failed the run — its work is kept")}</span></div>
<p class="muted" style="margin:0;font-size:14px;overflow-wrap:anywhere">${cut(reasonText(page.run.stateReason ?? ""), 300)}</p>
<div class="actions">${
        actions
          ? html`${resumeForm(actions, page.run, t("Try again"))}<span class="hint">${t("once the model answers again: the step goes on from its last checkpoint; or")} <code>${cmd}</code></span>`
          : html`<span class="hint">${t("Once the model answers again:")} <code>${cmd}</code></span><button type="button" class="btn" data-copy="${cmd}">${t("Copy command")}</button>`
      }</div></section>`;
    }
    // an empty region, not none: the live refresh replaces it, so a finished run's spinner goes away
    if (!stopped) return html`<div data-live="card" hidden></div>`;
    const cmd = `jarvis resume ${shortRunId(page.run.id)}`;
    return html`<section class="panel now" aria-label="${t("Now")}" data-live="card"><div class="row"><span class="warn">⏸ ${stopped}</span></div>
<div class="actions">${
      page.resumable && actions
        ? html`${resumeForm(actions, page.run)}<span class="hint">${t("goes on in the background, or")} <code>${cmd}</code> ${t("in a terminal")}</span>`
        : html`<span class="hint">${t("Go on with")} <code>${cmd}</code></span><button type="button" class="btn" data-copy="${cmd}">${t("Copy command")}</button>`
    }</div></section>`;
  }
  const last = a.lastTool
    ? `${t("last:")} ${a.lastTool.capability}${a.lastTool.detail ? ` ${a.lastTool.detail}` : ""}${a.lastTool.ok ? "" : " ✗"}`
    : "";
  return html`<section class="panel now" aria-label="${t("Now")}" data-live="card">
<div class="row"><span class="spin" aria-hidden="true"></span><b>${a.step.id}${a.step.iteration > 1 ? `#${a.step.iteration}` : ""}${a.step.agent && a.step.agent !== a.step.id ? ` · ${a.step.agent}` : ""}</b><span class="meta">${ticking(now - Date.parse(a.step.startedAt))} · ${callText(a)}</span></div>
${a.resumed ? html`<span class="hint resumed">↻ ${t("resumed {at} after {after}", { at: wallClock(a.resumed.at).slice(0, 5), after: a.resumed.after })}${a.resumed.times > 1 ? ` (${t("{n}× this round", { n: a.resumed.times })})` : ""} — ${t("the same round goes on from its checkpoint: its conversation, tool calls and plan marks are kept")}</span>` : ""}
${page.fixing ? fixWidget(page.fixing) : page.planProgress ? planWidget(page.planProgress, page.planProgress.lastFile) : ""}
${a.batch ? batchHtml(a.batch) : ""}
${toolBudget(a, now)}
${last ? html`<span class="meta">${last}</span>` : ""}
${notesBox(page, a.step.id, actions, a.step.agent === "implementation")}
</section>`;
}

/**
 * While a run works: «Ask me when tests fail» for this run and «Stop after this step» (src/app/steer.ts)
 * — switches, each a form of its own, so they work without the script.
 */
function steerHtml(
  page: RunPage,
  step: { readonly id: string; readonly iteration: number },
  actions?: Actions,
): Html {
  const s = page.steer;
  if (!s || !actions) return html``;
  const action = `${runHref(page.run)}/steer`;
  const after = s.stopAfter;
  const stopping = after !== undefined && after.step === step.id && after.iteration === step.iteration;
  const sw = (what: string, on: boolean, label: string, title: string) =>
    form(
      actions,
      action,
      html`<input type="hidden" name="what" value="${what}"><input type="hidden" name="on" value="${on ? "off" : "on"}"><button type="submit" class="sw${on ? " on" : ""}" role="switch" aria-checked="${on ? "true" : "false"}" title="${title}"><i aria-hidden="true"></i>${label}</button>`,
      html` class="swf"`,
    );
  return html`<div class="steer">${sw(
    "ask",
    s.askOnFailure,
    t("Ask me when tests fail"),
    s.askOnFailure
      ? t("every failed check stops this run for you")
      : `${t("the project's setting:")} ${s.projectAsk === "same-failure" ? t("asks when a round fails as the one before") : s.projectAsk === "every-failure" ? t("asks on every failure") : t("asks when the rounds are used up")}`,
  )}${sw("stop-after", stopping, t("Stop after {step}", { step: step.id }), stopping ? `${t("it pauses when {step} ends", { step: step.id })}${after?.by ? ` — ${t("asked by {who}", { who: after.by })}` : ""}` : t("pause when {step} ends, before the next step", { step: step.id }))}<span class="hint">${t("for this run")}</span></div>`;
}

/** A step on its second round: what it fixes, folded into one line like the plan. */
function fixWidget(f: NonNullable<RunPage["fixing"]>): Html {
  const n = f.reasons.length;
  const r = f.review;
  const head = r
    ? html`<span class="d">${t("Fixing what {who} sent back at {step}", { who: r.by, step: f.from })}${r.comment ? html`: <span class="muted">${cut(r.comment.split("\n").find((l) => l.trim()) ?? "", 120)}</span>` : ` (${t("no comment")})`}</span>`
    : html`<span class="d">${n > 0 ? t("Fixing {defects} {step} found", { defects: plural(n, "defect"), step: f.from }) : t("Fixing what {step} found", { step: f.from })}</span>`;
  return html`<details class="planw fixw" data-keep="fixing"${r ? html` open` : ""}>
<summary><span class="of">${f.max ? t("Round {n} of {m}", { n: f.round, m: f.max }) : t("Round {n}", { n: f.round })}</span>${head}</summary>
${
  r
    ? html`<div class="planbox sentback"><span class="meta">${r.decision === "reject" ? t("rejected") : t("sent back")} ${r.ref} ${t("by {who}", { who: r.by })}${r.channel === "ui" ? ` ${t("in the browser")}` : r.channel === "cli" ? ` ${t("in the terminal")}` : ""} — ${t("the agent gets it as is, binding")}</span>${r.comment ? html`<div class="said">${cut(r.comment, 4000)}</div>` : html`<span class="muted">${t("No comment was given.")}</span>`}</div>`
    : ""
}
${
  n > 0 || !r
    ? html`<div class="planbox"><ol class="plist">${f.reasons.map(
        (r, i) =>
          html`<li class="on"><span class="bad">✗</span><span class="n">${String(i + 1)}</span><span class="d">${cut(r.text, 600)}</span><span class="f">${r.step}</span></li>`,
      )}</ol></div>`
    : ""
}
</details>`;
}

/**
 * A note to the running step: the agent gets it before its next model call, binding, and so does every
 * agent after it (src/interaction/notes.ts).
 */
function notesBox(page: RunPage, step: string, actions?: Actions, hint = false): Html {
  const notes = page.notes ?? [];
  const add = actions
    ? html`<details class="addnote" data-keep="${hint ? "hint" : "addnote"}"${hint ? " open" : ""}><summary>✎ ${hint ? t("A hint for {step}", { step }) : t("Add a note for {step}", { step })}</summary>
${form(
  actions,
  `${runHref(page.run)}/note`,
  html`<label class="field grow">${t("The agent gets it before its next model call, as binding — and every step after it")}<textarea name="text" rows="3" maxlength="4000" required placeholder="${t("A correction, a decision, a hint: «the slots method serves the courier app too»")}"></textarea></label><div class="actions"><button type="submit" class="btn primary">${t("Send to the agent")}</button></div>`,
)}</details>`
    : "";
  if (notes.length === 0) return html`${add}`;
  // the same text sent twice (a double click, a second window) is one note
  const groups: Array<{ note: (typeof notes)[number]; times: number; delivered: boolean }> = [];
  for (const n of notes) {
    const same = groups.find((g) => g.note.text.trim() === n.text.trim());
    if (same) {
      same.times += 1;
      same.delivered = same.delivered && n.delivered;
    } else groups.push({ note: n, times: 1, delivered: n.delivered });
  }
  const pending = groups.filter((g) => !g.delivered).length;
  const last = groups.at(-1) as (typeof groups)[number];
  // folded once the agents have them; open while one is on its way (a new key: the fold follows);
  // «Add a note» stays outside the fold — a new person would not look for it inside
  return html`<details class="planw notesw" data-keep="notes-${pending > 0 ? "pending" : "delivered"}"${pending > 0 ? html` open` : ""}>
<summary><span class="of">${t("Notes")} ${String(groups.length)}</span><span class="${pending > 0 ? "warn" : "ok"}">${pending > 0 ? `◌ ${t("{n} on its way", { n: pending })}` : `✓ ${t("the agents have them")}`}</span><span class="d muted">${cut(last.note.text.split("\n").find((l) => l.trim()) ?? "", 90)}</span></summary>
<div class="planbox"><ul class="notes">${groups.map(
    (g) =>
      html`<li><span class="${g.delivered ? "ok" : "warn"}">${g.delivered ? `✓ ${t("the agent got it")}` : `◌ ${t("goes with its next model call")}`}</span> <span class="meta">${g.note.by}${g.note.stepId ? ` · ${g.note.stepId}` : ""}${g.times > 1 ? ` · ${t("sent {times}", { times: plural(g.times, "time") })}` : ""}</span><div class="said">${g.note.text}</div></li>`,
  )}</ul></div>
</details>
${add}`;
}

const planAt = (p: PlanProgress): string =>
  p.current !== undefined
    ? t("{n} of {m}", { n: p.current + 1, m: p.steps.length })
    : t("{n} of {m} done", { n: p.done, m: p.steps.length });

/**
 * An implementation's place in its plan: one line folded («Plan 3 of 7: …»), the panel open — the step
 * now with its files and check, a bar of the steps, the whole plan. Stays open across refreshes.
 */
function planWidget(p: PlanProgress, lastFile?: string): Html {
  const now = p.current !== undefined ? p.steps[p.current] : undefined;
  const glyph = (st: string) =>
    st === "done"
      ? html`<span class="ok">✓</span>`
      : st === "on"
        ? html`<span class="spin" aria-hidden="true"></span>`
        : html`<span class="muted">·</span>`;
  const files = (n: number) => plural(n, "file");
  return html`<details class="planw" data-keep="plan">
<summary><span class="of">${t("Plan {at}", { at: planAt(p) })}</span>${now ? html`<span class="d">${now.description}</span>` : html`<span class="d muted">${t("every step of the plan is done; the result comes next")}</span>`}${p.outOfOrder ? html`<span class="warn" style="font-size:12px">${t("out of plan order")}</span>` : ""}</summary>
<div class="planbox">
<div class="segs" aria-label="${t("{n} of {m} done", { n: p.done, m: p.steps.length })}">${p.steps.map((s) => html`<i class="${s.status === "done" ? "ok" : s.status === "on" ? "on" : ""}"></i>`)}</div>
${
  now
    ? html`<div class="pmeta">${now.files.length > 0 ? html`<span><span class="k">${t("files")}</span> ${now.files.map((f, i) => html`${i > 0 ? " · " : ""}${fileRef(f)}`)}</span>` : ""}${now.verification ? html`<span><span class="k">${t("check")}</span> ${now.verification}</span>` : ""}${lastFile || now.files.length > 0 ? html`<span><span class="k">${t("now")}</span> ${lastFile ? html`${t("edit")} ${fileRef(lastFile)}` : t("reading")}${now.files.length > 0 ? ` · ${t("{n} of {files} touched", { n: now.touched, files: files(now.files.length) })}` : ""}</span>` : ""}</div>`
    : ""
}
<ol class="plist">${p.steps.map(
    (s, i) =>
      html`<li class="${s.status}">${glyph(s.status)}<span class="n">${String(i + 1)}</span><span class="d">${s.description}</span><span class="f">${s.status === "on" && lastFile && s.files.includes(lastFile) ? t("editing {file}", { file: lastFile.split("/").pop() ?? "" }) : s.files.length > 0 ? files(s.files.length) : ""}</span></li>`,
  )}</ol>
</div>
</details>`;
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
<h2 id="activity">${t("Activity")}</h2>
${
  feed.length > 0
    ? html`${
        earlier.length > 0
          ? html`<details class="earlier" data-keep="feed-earlier"><summary>${t("{n} earlier", { n: earlier.length })}</summary><ol>${earlier.map(feedLine)}</ol></details>`
          : ""
      }<ol>${recent.map(feedLine)}</ol>`
    : html`<p class="muted">${t("Nothing yet.")}</p>`
}
</section>`;
}

const TIME_ROWS: ReadonlyArray<{ part: TimePart; cls: string; name: string; what?: string }> = [
  // t("Working") t("steps ran, the model answered, tools worked") t("Waiting for you") t("Waiting on budget and the model") t("Paused or stopped")
  { part: "working", cls: "w", name: "Working", what: "steps ran, the model answered, tools worked" },
  { part: "human", cls: "h", name: "Waiting for you" },
  { part: "waiting", cls: "b", name: "Waiting on budget and the model" },
  { part: "stopped", cls: "p", name: "Paused or stopped" },
];

/**
 * `2h 19m · 1h 05m working` in the run's head, and on hover (or focus) where the time went:
 * a bar and four rows from the journal's state intervals (src/app/timeSplit.ts).
 */
export function timeHtml(time: TimeSplit): Html {
  const total = time.totalMs;
  const working = time.parts.working.ms;
  const share = (ms: number): number => (total > 0 ? (ms / total) * 100 : 0);
  const pc = (ms: number): string => (ms === 0 ? "" : share(ms) < 1 ? "<1%" : `${Math.round(share(ms))}%`);
  const one = (part: TimePart, i: TimeItem): string =>
    `${i.label} ${duration(i.ms)}${i.times > 1 || (part === "waiting" && i.times > 0) ? ` (×${i.times})` : ""}`;
  const rows = TIME_ROWS.map(({ part, cls, name, what }) => {
    const items = time.parts[part].items;
    const shown = part === "working" ? items.slice(0, 3) : items;
    const list = `${shown.map((i) => one(part, i)).join(part === "working" ? ", " : " · ")}${items.length > shown.length ? "…" : ""}`;
    const sub = [what ? t(what) : "", list].filter((x) => x).join(" · ");
    const ms = time.parts[part].ms;
    return html`<tr><td class="k"><i class="${cls}"></i>${t(name)}</td><td class="v">${ms > 0 ? duration(ms) : "—"}</td><td class="pc">${pc(ms)}</td></tr>${sub ? html`<tr><td colspan="3" class="sub">${sub}</td></tr>` : ""}`;
  });
  const bar = TIME_ROWS.filter(({ part }) => time.parts[part].ms > 0).map(
    ({ part, cls }) => html`<i class="${cls}" style="width:${share(time.parts[part].ms).toFixed(2)}%"></i>`,
  );
  const when = `${t("started {at}", { at: wallClock(time.startedAt).slice(0, 5) })} · ${time.endedAt ? t("ended {at}", { at: wallClock(time.endedAt).slice(0, 5) }) : t("not over yet")}`;
  return html`<span class="timew" tabindex="0" aria-describedby="tpop">${duration(total)}${total - working >= 60_000 ? html` <span class="work">· ${t("{d} working", { d: duration(working) })}</span>` : ""}<span class="tpop" id="tpop" role="tooltip"><b class="ttl">${t("Time of this run")}</b><span class="bar">${bar}</span><table>${rows}<tr class="total"><td>${t("Total")}</td><td class="v">${duration(total)}</td><td class="pc"></td></tr></table><span class="note">${t("From the run's journal, {when}. Working time is what the run cost in time; the rest is where it waited.", { when })}</span></span></span>`;
}

export function runContent(
  page: RunPage,
  now: number,
  actions?: Actions,
  notice?: Html,
  /** Above the run's card: a module research's candidate to decide (src/ui/modules.ts). */
  review?: Html,
  /** Under the artifacts: an ended run's checkout and branch, and their removal. */
  checkout?: Html,
): Html {
  const r = page.run;
  const tk = page.tokens;
  const extra =
    r.state === "WAITING_HUMAN"
      ? (r.waitingFor?.kind ?? undefined)
      : r.state === "RUNNING" && page.activity?.step
        ? `${page.activity.step.id}${page.activity.step.iteration > 1 ? `#${page.activity.step.iteration}` : ""}`
        : undefined;
  const meta = join(
    [
      r.workflow,
      html`<span title="${t("the kind of task the skills and standards were picked by")} — ${kindWhy(page.kind)}">${t(KIND_NAME[page.kind.kind])}</span>`,
      ...(r.options?.autonomous
        ? [
            html`<span class="pill wait" title="${t("No person in the loop: gates pass, a question gets the most cautious assumption, a dead end ends the run")}">${t("autonomous")} · experimental</span>`,
          ]
        : []),
      `run ${shortRunId(r.id)}`,
      page.time ? timeHtml(page.time) : duration(page.workedMs),
      plural(tk.calls, "model call"),
      ...(tk.calls > 0
        ? [
            `${t("in")} ${kilo(tk.promptTokens)}${tk.cachedTokens > 0 ? ` (${tk.cachedEstimated ? "≈ " : ""}${kilo(tk.cachedTokens)} ${t("cached")})` : ""} · ${t("out")} ${kilo(tk.outputTokens)} ${t("tok")}`,
          ]
        : []),
    ],
    " · ",
  );
  const card = page.card;
  const rest = r.task.split("\n").slice(1).join("\n").trim();
  return html`<div class="lede-col" style="display:flex;flex-direction:column;gap:8px" data-live="head">
<div class="row">${statePill(r, extra)}<span class="meta" style="font-size:13px">${meta}</span></div>
<div class="runtitle">
<div class="runtext">
<h1>${firstLine(r.task, 300)}</h1>
${rest ? html`<p class="muted" style="white-space:pre-wrap">${cut(rest, 600)}</p>` : ""}
${r.stateReason && r.state !== "RUNNING" && r.state !== "WAITING_BUDGET" ? html`<p class="muted">${reasonText(r.stateReason)}</p>` : ""}
${page.continuedFrom ? continuedFromHtml(page.continuedFrom) : ""}
${page.subtaskOf ? html`<p class="muted">${t("subtask {key} of {of}", { key: page.subtaskOf.key, of: page.subtaskOf.of })}${page.subtaskOf.service ? ` · ${page.subtaskOf.service}` : ""} ${t("of")} <a href="/runs/${shortRunId(page.subtaskOf.master.id)}">${firstLine(page.subtaskOf.master.task, 120)}</a> — ${t("the contract is the master's")}</p>` : ""}
</div>
<div class="row headact">${actions && !isTerminal(r.state) ? (cancelling(r) ? html`<span class="btn small danger" aria-disabled="true">${t("Cancelling…")}</span>` : cancelHtml(r, actions)) : ""}</div>
</div>
</div>
${notice ?? ""}
${page.pausing && !cancelling(r) ? html`<div class="banner info" data-live="pausing" role="status"><span class="spin" aria-hidden="true"></span> ${t("Pausing")}${page.pausing.by ? ` (${t("asked by {who}", { who: page.pausing.by })})` : ""} — ${t("the run stops after its current model or tool call and keeps its place; then Resume goes on from there")}</div>` : html`<div data-live="pausing" hidden></div>`}
${cancelling(r) ? html`<div class="banner bad" data-live="cancelling" role="status"><span class="spin" aria-hidden="true"></span> ${t("Cancelling — the run stops after its current model or tool call (a model call can take a minute or two); then it is CANCELLED, its checkout and artifacts stay")}</div>` : html`<div data-live="cancelling" hidden></div>`}
${page.untrusted ? untrustedHtml(page.untrusted) : html`<div data-live="untrusted" hidden></div>`}
<div class="cols">
<section class="panel side steps" aria-labelledby="steps" data-live="steps">
<h2 id="steps">${t("Steps")}</h2>
<ol style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px">${page.steps.map((s) => stepRow(s, now, s.status === "running" ? page.planProgress : undefined))}</ol>
</section>
<div class="mainc">
${review ?? ""}
${card ? (card.kind === "loop" ? loopCardHtml(card, page, actions) : card.kind === "approval" ? approvalCardHtml(card, page, actions) : card.kind === "budget" ? budgetCardHtml(card, page, actions) : card.kind === "clarify" ? clarifyCardHtml(card, page, actions) : card.kind === "scope" ? scopeCardHtml(card, page, actions) : card.kind === "effect" ? effectCardHtml(card, page, actions) : card.kind === "conflict" ? conflictCardHtml(card, page, actions) : card.kind === "contract" ? contractWaitHtml(card) : otherCardHtml(card.what, page)) : page.wait ? waitHtml(page, page.wait, now, actions) : page.next || page.continuedBy ? continuationHtml(page, actions) : page.restart && page.resumable !== "retry" ? restartHtml(page, page.restart, actions) : page.evalReady || page.evalCase ? evalHtml(page, actions) : nowHtml(page, now, actions)}
${page.redo && actions?.canLaunch ? redoHtml(page, page.redo, actions) : ""}
${page.contractRequests ? contractRequestsHtml(page, page.contractRequests, actions) : ""}
${page.subtasks ? subtasksHtml(page, actions) : ""}
${page.contractCheck ? contractCheckHtml(page.contractCheck) : ""}
${feedHtml(page.feed)}
<section class="panel arts" aria-labelledby="artifacts" data-live="arts">
<h2 id="artifacts">${t("Artifacts")}</h2>
${
  page.artifacts.length > 0
    ? html`<ul>${page.artifacts.map(
        (a) =>
          html`<li><a href="${artifactHref(r, a)}">${a.type}/${a.name}@${a.version}</a><span class="meta">${a.stepId ?? "-"}${a.iteration && a.iteration > 1 ? `#${a.iteration}` : ""}</span>${a.provenance.kind === "human" ? html`<span class="meta">✎ ${t("edited by a person, {who}", { who: a.provenance.actor.id })}</span>` : ""}${a.state ? html`<span class="${a.state === "approved" ? "ok" : "warn"}" style="font-size:13px">${a.state}</span>` : ""}</li>`,
      )}</ul>`
    : html`<p class="muted">${t("No artifacts yet.")}</p>`
}
</section>
${checkout ?? ""}
</div>
</div>
${runDock(page, actions)}`;
}

/**
 * The page's actions at the bottom of the screen, in reach however long the page: on a sticky strip
 * that is the last thing in the page, a live region of its own.
 */
export function dockHtml(body: Html | string): Html {
  return body
    ? html`<div class="dock" data-live="dock" role="region" aria-label="${t("Actions")}"><div class="dock-in">${body}</div></div>`
    : html`<div data-live="dock" hidden></div>`;
}

/**
 * A run's dock: the button of the decision in the card when failed checks stopped it (it submits the
 * card's form); while it works, its switches and Pause.
 */
function runDock(page: RunPage, actions?: Actions): Html {
  const card = page.card;
  if (!actions) return dockHtml("");
  if (card?.kind === "loop" && card.tests && !card.rerun && !card.goOn) {
    const ts = card.tests;
    const back = card.to ?? "implementation";
    return dockHtml(
      html`<div class="what"><b data-choice-label>${t("Send back with a hint")}</b><span>${card.step} · ${t("round {n} of {m}", { n: ts.round, m: ts.rounds })}</span></div><span class="grow"></span>${form(actions, `${runHref(page.run)}/open`, html`<button type="submit" class="btn">${t("Open in editor")}</button>`)}<button type="submit" form="tests-form" class="btn primary big" data-choice-go>${t("Send back to {back}", { back })}</button>`,
    );
  }
  const a = page.activity;
  if (!card && a?.step && pausable(page)) {
    const pause = page.pausing
      ? html`<span class="btn" aria-disabled="true">${t("Pausing…")}</span>`
      : form(
          actions,
          `/runs/${encodeURIComponent(shortRunId(page.run.id))}/pause`,
          html`<button type="submit" class="btn" title="${t("Stops after the current model or tool call, keeps its place; Resume goes on")}">${t("Pause")}</button>`,
        );
    return dockHtml(
      html`<span class="spin" aria-hidden="true"></span><div class="what"><b>${a.step.id}${a.step.iteration > 1 ? `#${a.step.iteration}` : ""}${page.planProgress ? ` · ${t("plan {at}", { at: planAt(page.planProgress) })}` : ""}</b><span>${callText(a)}</span></div><span class="grow"></span>${steerHtml(page, a.step, actions)}${pause}`,
    );
  }
  return dockHtml("");
}

/**
 * The scope gate (ADR-0025 §7): the requirements tied to other services the catalog links to this one,
 * and the two ways on — a task across services, or only this service (not asked again).
 */
function scopeCardHtml(card: ScopeCard, page: RunPage, actions?: Actions): Html {
  const r = page.run;
  const rep = card.report;
  const others = [...new Set(rep.spans.map((x) => x.service))];
  const choice = (value: "cross" | "single", label: string, primary: boolean) =>
    actions
      ? form(
          actions,
          `/runs/${encodeURIComponent(shortRunId(r.id))}/scope`,
          html`<input type="hidden" name="choice" value="${value}"><button type="submit" class="btn${primary ? " primary" : ""}">${label}</button>`,
        )
      : html`<code>jarvis scope ${shortRunId(r.id)} ${value === "cross" ? "--cross" : "--single --resume"}</code>`;
  return html`<section class="panel decision" aria-labelledby="decision" data-live="card">
<span class="warn" style="font-size:13px;font-weight:500">The impact reaches other services</span>
<h2 id="decision">This task spans ${others.length + 1} services</h2>
<p class="hint">The specification asks for behaviour in other services, and the contract catalog links each of them to ${rep.service} through what this change touches.</p>
<div class="scroll"><table><thead><tr><th scope="col">Requirement</th><th scope="col">Service</th><th scope="col">Link in the catalog</th><th scope="col">Why</th></tr></thead><tbody>
<tr><td class="muted">—</td><td><b>${rep.service}</b> <span class="meta">this run</span></td><td></td><td></td></tr>
${rep.spans.map((x) => html`<tr><td><b>${x.requirement}</b></td><td><b>${x.service}</b></td><td><span class="pill ok">✓ ${x.link ?? ""}</span></td><td class="muted">${x.why}</td></tr>`)}
</tbody></table></div>
${rep.unconfirmed.length > 0 ? html`<p class="hint">Tied by the analysis, not linked in the catalog (a warning, not a stop): ${rep.unconfirmed.map((x, i) => html`${i > 0 ? ", " : ""}<b>${x.service}</b> (${x.requirement})`)}</p>` : ""}
<div class="row" style="flex-wrap:wrap;gap:16px;align-items:stretch">
<div class="panel" style="flex:1 1 320px;display:flex;flex-direction:column;gap:8px"><b>Continue as sdd (cross-repos)</b> <span class="pill info">recommended</span><p class="hint">The research and the approved spec go to a master run in the knowledge repository; this run ends, ${rep.service} gets a subtask of its own. Next you approve the split and the contract.</p>${choice("cross", "Continue as sdd (cross-repos)", true)}</div>
<div class="panel" style="flex:1 1 320px;display:flex;flex-direction:column;gap:8px"><b>Only ${rep.service}</b><p class="hint">Goes on to the plan here. The other services stay tasks of their own. Not asked again in this run.</p>${choice("single", `Only ${rep.service}`, false)}</div>
</div>
</section>`;
}

/** A master's subtasks (ADR-0025 §6): service, state, step, and what a person may do with each. */
function subtasksHtml(page: RunPage, actions?: Actions): Html {
  const r = page.run;
  const views = page.subtasks ?? [];
  const done = views.filter((v) => v.state === "COMPLETED" || v.state === "dropped").length;
  const serviceOf = (key: string) => views.find((v) => v.subtask.key === key)?.subtask.service ?? key;
  const pill = (v: SubtaskView) =>
    v.state === "blocked"
      ? html`<span class="pill plain sub-wait" title="a library of this task is changed first">waits for ${(v.waitsFor ?? []).map(serviceOf).join(", ")}</span>`
      : html`<span class="pill ${v.state === "COMPLETED" ? "ok" : v.state === "FAILED" || v.state === "CANCELLED" ? "bad" : v.state === "WAITING_HUMAN" ? "wait" : v.state === "dropped" || v.state === "queued" ? "plain" : "info"}">${v.state === "WAITING_HUMAN" ? "waits for you" : v.state}</span>`;
  const act = (key: string, what: "start" | "retry" | "drop" | "publish", label: string, primary = false) =>
    actions
      ? form(
          actions,
          `/runs/${encodeURIComponent(shortRunId(r.id))}/subtask`,
          html`<input type="hidden" name="key" value="${key}"><input type="hidden" name="act" value="${what}"><button type="submit" class="btn small${primary ? " primary" : ""}">${label}</button>`,
        )
      : "";
  const published = (v: SubtaskView) => {
    const p = v.published;
    if (!p) return "";
    if (p.skipped)
      return html`<p class="hint sub-pub">Not published: no publish-local — the services build against the version they have.</p>`;
    return p.ok
      ? html`<p class="hint sub-pub">✓ published${p.version ? html` <code>${p.version}</code>` : ""} by <code>${p.command ?? ""}</code></p>`
      : html`<div class="banner bad sub-pub"><b>publish-local failed</b> — <code>${p.command ?? ""}</code>; the services that use it keep waiting.${p.tail ? html`<pre class="tf-tail">${p.tail}</pre>` : ""}</div>`;
  };
  return html`<section class="panel" aria-labelledby="subtasks" data-live="subtasks">
<h2 id="subtasks">Subtasks <span class="meta">${done} of ${views.length} done</span></h2>
${page.masterBudget ? masterBudgetHtml(page.masterBudget) : ""}
<ul style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px">${views.map(
    (
      v,
    ) => html`<li class="row" style="flex-wrap:wrap;gap:8px 14px;padding:8px 0;border-top:1px solid var(--line-soft)">
<span class="meta">${v.subtask.key}</span>${v.run ? html`<a href="/runs/${shortRunId(v.run.id)}" style="font-weight:600">${v.subtask.service}</a>` : html`<b>${v.subtask.service}</b>`}
<span class="muted" style="flex:1 1 260px;min-width:0">${firstLine(v.subtask.task, 140)}${v.run?.currentStep && v.state !== "COMPLETED" ? html` · <span class="meta">${v.run.currentStep}</span>` : ""}</span>
${pill(v)}
${v.state === "queued" ? act(v.subtask.key, "start", "Start now") : ""}${v.state === "blocked" ? act(v.subtask.key, "start", "Start now anyway") : ""}${v.published && !v.published.ok ? act(v.subtask.key, "publish", "Run publish-local again", true) : ""}${v.state === "CANCELLED" || v.state === "FAILED" ? act(v.subtask.key, "retry", "Retry") : ""}${v.state !== "COMPLETED" && v.state !== "dropped" ? act(v.subtask.key, "drop", "Drop") : ""}
${v.state === "blocked" ? html`<p class="hint sub-pub">Starts when ${(v.waitsFor ?? []).map(serviceOf).join(", ")} is accepted and published, against the new version. «Start now anyway» — against the version it has.</p>` : ""}${published(v)}
</li>`,
  )}</ul>
</section>`;
}

/** The master's budget: what its subtasks spent of the sum of their caps, its own steps apart. */
function masterBudgetHtml(b: MasterBudget): Html {
  const dims = (["outputTokens", "inputTokens", "requests"] as const).filter(
    (d) => b.limit[d] !== undefined || b.spent[d] > 0,
  );
  const part = (d: (typeof dims)[number]) => {
    const cap = b.limit[d];
    const unit = unitOf(d);
    return cap === undefined
      ? t("{used} {unit}", { used: amount(b.spent[d]), unit })
      : t("{used} of {cap} {unit}", { used: amount(b.spent[d]), cap: amount(cap), unit });
  };
  const own = b.own.outputTokens + b.own.inputTokens > 0 || b.own.requests > 0;
  return html`<p class="hint sub-budget">${t("Budget, the sum of the subtasks':")} ${dims.length > 0 ? dims.map(part).join(" · ") : t("nothing spent yet")}${Object.keys(b.limit).length === 0 ? ` — ${t("no cap: budget.perRun is not set")}` : ""}${own ? html` · <span class="meta">${t("the master's own steps: {n} output tokens", { n: amount(b.own.outputTokens) })}</span>` : ""}</p>
${b.exhausted ? html`<div class="banner bad">${t("The master's budget is spent ({used} of {cap} {unit}): a subtask makes no more model calls — it stops on a budget stop, where more for it grows the sum", { used: amount(b.exhausted.used), cap: amount(b.exhausted.cap), unit: unitOf(b.exhausted.dimension) })}</div>` : ""}`;
}

/** The contract changes the subtasks ask for (ADR-0025 §6): accept into a new split, or keep it as agreed. */
function contractRequestsHtml(
  page: RunPage,
  requests: readonly ContractChangeRequest[],
  actions?: Actions,
): Html {
  const r = page.run;
  const agreed = (id: string) => page.contractItems?.find((c) => c.id === id);
  const decide = (q: ContractChangeRequest) =>
    actions
      ? html`<div class="row" style="flex-wrap:wrap;gap:12px;align-items:flex-end">${form(
          actions,
          `/runs/${encodeURIComponent(shortRunId(r.id))}/contract`,
          html`<input type="hidden" name="request" value="${q.id}"><input type="hidden" name="choice" value="accept"><label class="hint" for="cc-${q.key}">${t("The contract as it will be")}</label><textarea id="cc-${q.key}" name="change" rows="2" style="width:100%">${q.change}</textarea><button type="submit" class="btn primary">${t("Accept: a new version of the split")}</button>`,
          html` style="flex:1 1 320px;display:flex;flex-direction:column;gap:6px"`,
        )}${form(
          actions,
          `/runs/${encodeURIComponent(shortRunId(r.id))}/contract`,
          html`<input type="hidden" name="request" value="${q.id}"><input type="hidden" name="choice" value="reject"><label class="hint" for="cr-${q.key}">${t("Why it stays (for the subtask)")}</label><input id="cr-${q.key}" name="why" type="text"><button type="submit" class="btn">${t("Reject: keep it as agreed")}</button>`,
          html` style="flex:1 1 240px;display:flex;flex-direction:column;gap:6px"`,
        )}</div>`
      : html`<p class="hint">${t("Decide in the terminal:")} <code>jarvis subtask contract ${shortRunId(r.id)} ${q.key} --accept</code> · <code>--reject</code></p>`;
  return html`<section class="panel decision" aria-labelledby="contract-requests" data-live="contract-requests">
<span class="warn" style="font-size:13px;font-weight:500">${t("Waits for you")}</span>
<h2 id="contract-requests">${t("A subtask asks to change the contract")}</h2>
<p class="hint">${t("Only the master changes the contract. Accepted: the split gets a new version, the other subtasks it touches get it as a note, the asking one analyses its impact again. Rejected: it goes on with the contract as agreed.")}</p>
${requests.map((q) => {
  const was = agreed(q.item);
  return html`<div class="panel" style="display:flex;flex-direction:column;gap:6px">
<div class="row" style="flex-wrap:wrap;gap:6px 12px"><span class="meta">${q.key}</span><a href="/runs/${shortRunId(q.run)}" style="font-weight:600">${q.service}</a><span class="pill plain">${q.kind ?? was?.kind ?? "contract"}</span><code>${q.item}</code></div>
${was ? html`<p class="muted">${t("Agreed: {change}", { change: was.change })}</p>` : html`<p class="muted">${t("Not in the contract yet: accepting adds it")}</p>`}
<p><b>${t("Asks for: {change}", { change: q.change })}</b></p>
${q.why ? html`<p class="hint">${t("Why: {why}", { why: q.why })}</p>` : ""}
${decide(q)}
</div>`;
})}
</section>`;
}

/** A subtask parked on its contract change request: the decision is the master's. */
function contractWaitHtml(card: ContractCard): Html {
  const q = card.request;
  const master = shortRunId(card.master.id);
  return html`<section class="panel decision" aria-labelledby="decision" data-live="card">
<span class="warn" style="font-size:13px;font-weight:500">${t("Waits for the master")}</span>
<h2 id="decision">${t("This subtask asks to change the contract")}</h2>
${q ? html`<p><code>${q.item}</code> — ${q.change}</p>${q.why ? html`<p class="hint">${t("Why: {why}", { why: q.why })}</p>` : ""}` : ""}
<p class="hint">${t("Only the master changes the contract: a person accepts or rejects it on the master's page, then this run goes on.")}</p>
<div class="actions"><a class="btn primary" href="/runs/${master}#contract-requests">${t("Open the master")}</a>${q ? html`<span class="hint"><code>jarvis subtask contract ${master} ${q.key} --accept | --reject</code></span>` : ""}</div>
</section>`;
}

const sideTone = (status: string) =>
  status === "ok" ? "ok" : status === "missing" || status === "mismatch" ? "bad" : "plain";
const sideMark = (status: string) =>
  status === "ok" ? "✓" : status === "missing" ? "✗" : status === "mismatch" ? "≠" : "○";

/** The fields of a DTO between two sides: per field, what changed and whether it holds. */
function dtoCheckHtml(c: DtoCheck): Html {
  const role =
    c.role === "payload"
      ? t("payload")
      : c.role === "request"
        ? t("request body")
        : c.role === "response"
          ? t("response")
          : t("DTO");
  const head = html`<span class="meta">${role} · <code>${c.dto}</code> · ${c.writer} → ${c.reader}</span>`;
  if (!c.fields)
    return html`<div class="dto">${head} <span class="muted">${t("fields not checked: the type is not seen on both sides")}</span>${c.note ? html` <span class="meta" title="${c.note}">ⓘ</span>` : ""}</div>`;
  const change = (x: string) =>
    x === "same"
      ? t("same")
      : x === "added"
        ? t("added")
        : x === "removed"
          ? t("removed")
          : x === "renamed"
            ? t("renamed")
            : t("type changed");
  return html`<div class="dto">${head}
<div class="scroll"><table><thead><tr><th scope="col">${t("Field")}</th><th scope="col">${t("Change")}</th><th scope="col">${t("Writes: {service}", { service: c.writer })}</th><th scope="col">${t("Reads: {service}", { service: c.reader })}</th><th scope="col">${t("Holds")}</th></tr></thead><tbody>
${c.fields.map((f) => html`<tr><td><code>${f.field}</code></td><td>${change(f.change)}</td><td class="muted">${f.writer ?? "—"}</td><td class="muted">${f.reader ?? "—"}</td><td><span class="pill ${f.status === "ok" ? "ok" : "bad"}">${f.status === "ok" ? `✓ ${t("ok")}` : `≠ ${t("mismatch")}`}</span></td></tr>`)}
</tbody></table></div></div>`;
}

/** The contract checked in the subtasks' checkouts: each side's status, the DTOs field by field. */
function contractCheckHtml(check: NonNullable<RunPage["contractCheck"]>): Html {
  const side = (x: ContractSideView) =>
    html`<span class="pill ${sideTone(x.status)}" title="${x.note ?? x.at ?? ""}">${sideMark(x.status)} ${x.service}</span>`;
  return html`<section class="panel" aria-labelledby="contract" data-live="contract">
<h2 id="contract">${t("Contract")} <span class="pill ${check.ok ? "ok" : "bad"}">${check.ok ? t("every side holds") : t("a side does not hold")}</span></h2>
<p class="hint">${t("Checked in each subtask's checkout without a model: the producer sends or serves it, the consumers read or call it, with the same fields where the type is declared.")}</p>
<ul style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px">${check.items.map(
    (i) =>
      html`<li style="display:flex;flex-direction:column;gap:6px"><div class="row" style="flex-wrap:wrap;gap:6px 12px"><span class="pill plain">${i.kind}</span><code>${i.id}</code><span class="muted" style="flex:1 1 220px">${i.change}</span>${side(i.producerSide)}${i.consumerSides.map(side)}</div>${[i.producerSide, ...i.consumerSides].flatMap((s) => (s.fields ?? []).map(dtoCheckHtml))}</li>`,
  )}</ul>
</section>`;
}

/**
 * ADR-0016 §4: untrusted content from the internet is in the run and nobody approved anything since —
 * its effects (a PR, a comment, a push) are held until a person approves the run's artifact.
 */
function untrustedHtml(u: UntrustedView): Html {
  const s = u.source;
  const held =
    u.held.length > 0
      ? html` ${th("Held so far: {list}.", {
          list: join(
            u.held.map((c) => html`<code>${c}</code>`),
            ", ",
          ),
        })}`
      : "";
  const where = html`<code>${s.capability}</code>${s.server ? ` (${t("server {name}", { name: s.server })})` : ""}${s.stepId ? ` ${t("in {step}", { step: s.stepId })}` : ""}`;
  return html`<div class="banner warn" data-live="untrusted" role="note">⚠ ${th("Untrusted content from the internet came in: {where}. Its text went to the agents as data, not instructions; effects — a PR, a comment, a push — wait for a person to approve the run's artifact.", { where })}${held}</div>`;
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
${
  page.nextCross
    ? html`<div class="banner info"><b>It names ${page.nextCross.length} services the catalog links</b> — ${page.nextCross.map((n, i) => html`${i > 0 ? " · " : ""}<b>${n.service}</b> ${n.by}`)}: likely a task across services (recommended)</div>`
    : ""
}
<div class="actions">${
    actions?.canLaunch
      ? html`${
          page.nextCross
            ? form(
                actions,
                `/runs/${shortRunId(r.id)}/continue`,
                html`<input type="hidden" name="workflow" value="sdd-cross"><button type="submit" class="btn primary big">Continue to sdd (cross-repos)</button>`,
              )
            : ""
        }${form(actions, `/runs/${shortRunId(r.id)}/continue`, html`<button type="submit" class="btn${page.nextCross ? "" : " primary"} big">Continue to ${next.workflow}</button>`)}<span class="hint">same as <code>${cmd}</code>${page.nextCross ? html` · <code>jarvis scope ${shortRunId(r.id)} --cross</code>` : ""}</span>`
      : html`<span class="hint">Go on with <code>${cmd}</code></span><button type="button" class="btn" data-copy="${cmd}">Copy command</button>`
  }</div>
</section>`;
}

/**
 * A cancelled or failed run started again from one of its steps (as `jarvis restart <run> --from`):
 * what it did before that step goes in with its approvals, the rest runs anew in a fresh checkout.
 */
function restartHtml(page: RunPage, restart: NonNullable<RunPage["restart"]>, actions?: Actions): Html {
  const r = page.run;
  const short = shortRunId(r.id);
  const steps = restart.steps.filter((s) => s.startable);
  const cmd = `jarvis restart ${short}`;
  const options = steps.slice(1).map((s, i) => {
    const kept = steps.slice(0, i + 1).filter((k) => k.kind !== "approval");
    const approved = kept.filter((k) => k.approved).map((k) => k.id);
    const what =
      kept.length > 0
        ? `${kept.map((k) => k.id).join(", ")} go in${approved.length > 0 ? ` (${approved.join(", ")} approved)` : ""}`
        : "nothing goes in";
    return html`<label class="opt${s.id === restart.startAt ? " rec" : ""}"><input type="radio" name="step" value="${s.id}"${s.id === restart.startAt ? " checked" : ""}><span><b>${s.id}</b> <span class="muted">— ${what}</span></span>${s.id === restart.startAt ? html`<span class="hint">recommended</span>` : ""}</label>`;
  });
  return html`<section class="panel decision" aria-labelledby="decision" data-live="card">
<span class="${r.state === "FAILED" ? "bad" : "warn"}" style="font-size:13px;font-weight:500">${r.state === "FAILED" ? "The run failed" : r.state === "COMPLETED" ? "The run is done" : "The run was cancelled"}${r.currentStep ? ` at ${r.currentStep}` : ""}</span>
<h2 id="decision">Start again from</h2>
<p>A new ${r.workflow} run in a fresh checkout of the current code: what was done before the step you pick goes in with its approvals and does not run again. Code the run wrote is not taken on.</p>
${
  actions?.canLaunch
    ? form(
        actions,
        `/runs/${short}/restart`,
        html`<fieldset class="choose"><legend class="sr">Start again from</legend>${options}</fieldset>
<label for="restart-note" class="muted" style="font-size:14px">For the first step: what to do differently <span class="hint">(optional)</span></label>
<textarea id="restart-note" name="note" rows="2"></textarea>
<div class="actions"><button type="submit" class="btn primary big">Start again</button><span class="hint">same as <code>${cmd} --from &lt;step&gt; --note "…"</code></span></div>`,
      )
    : html`<div class="actions"><span class="hint">Start again with <code>${cmd}</code></span><button type="button" class="btn" data-copy="${cmd}">Copy command</button></div>`
}
${restart.restartedAs ? html`<p class="muted">started again as <a href="/runs/${shortRunId(restart.restartedAs.id)}">${restart.restartedAs.workflow} ${shortRunId(restart.restartedAs.id)}</a> · ${restart.restartedAs.state}</p>` : ""}
</section>`;
}

/**
 * «Redo from a step» (as `jarvis redo <run> <step> --note`): a run that waits, is paused or failed
 * goes back to a step it went through, the note for that step; collapsed until asked for.
 */
function redoHtml(page: RunPage, redo: NonNullable<RunPage["redo"]>, actions: Actions): Html {
  const short = shortRunId(page.run.id);
  return html`<details class="panel redo" id="redo">
<summary><b>Redo from a step…</b> <span class="muted">— back to a step this run went through, with what it should do differently</span></summary>
${form(
  actions,
  `/runs/${short}/redo`,
  html`<div class="redo-body">
<label for="redo-step" class="muted" style="font-size:14px">Step</label>
<select id="redo-step" name="step">${redo.targets.map((t) => html`<option value="${t}"${t === redo.current ? " selected" : ""}>${t}${t === redo.current ? " (now)" : ""}</option>`)}</select>
<label for="redo-note" class="muted" style="font-size:14px">What should it do differently</label>
<textarea id="redo-note" name="note" rows="3" placeholder="It goes to that step only; the steps after it run again as usual"></textarea>
<div class="actions"><button type="submit" class="btn primary">Redo from this step</button><span class="hint">same as <code>jarvis redo ${short} &lt;step&gt; --note "…"</code>; the checkout keeps what the run wrote</span></div>
</div>`,
)}
</details>`;
}

/**
 * A clarification thread answered on the page (ADR-0019 §4): the same moves as `jarvis attach` — an
 * answer (Jarvis asks on or proposes the rule), accepting the proposed rule, or a rule of one's own.
 */
/** The answers the agent offered with its question (src/orchestration/executors.ts). */
const answersOfThread = (thread: ClarifyCard["thread"]): string[] =>
  Array.isArray(thread.meta.answers)
    ? thread.meta.answers.filter((a): a is string => typeof a === "string").slice(0, 4)
    : [];

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
  const earlier =
    card.earlier.length > 0 && actions
      ? html`<div class="earlier">${card.earlier.map(
          (e, i) =>
            html`<div class="rule"><span class="meta">Decided before for this task · run ${shortRunId(e.runId)} · ${whenShort(e.at, Date.now())}</span>${e.question ? html`<p class="muted">${cut(e.question, 240)}</p>` : ""}<p><b>${e.rule}</b></p><div class="actions"><button type="submit" name="move" value="earlier-${String(i)}" class="btn${i === 0 && !p ? " primary" : ""}">Accept this rule and go on</button></div></div>`,
        )}</div>`
      : "";
  const moves = actions
    ? form(
        actions,
        `${runHref(r)}/clarify`,
        html`${earlier}${
          card.exhausted
            ? html`<p class="hint">The thread's turns are used up (<code>human.clarification.maxTurns</code>): accept the proposed rule or write the rule yourself.</p>`
            : html`${((a) =>
                a.length > 0 && !card.thinking
                  ? html`<div class="answers" role="group" aria-label="The answers ${String(card.thread.meta.agent ?? "the agent")} sees">${a.map((x) => html`<button type="submit" name="answer" value="${x}" class="btn small">${x}</button>`)}</div>`
                  : "")(
                answersOfThread(card.thread),
              )}<label class="field grow">Your answer<textarea name="text" rows="3" maxlength="4000" placeholder="${answersOfThread(card.thread).length > 0 ? "Or answer in your words" : "Answer the question: Jarvis asks on or proposes the rule"}"${card.thinking ? " disabled" : ""}></textarea></label>`
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

/**
 * A run done with its implementation accepted: it becomes an eval case — the task, the repository at its
 * base as the fixture, the gold from what the person accepted and answered (src/evals/runToCase.ts).
 */
function evalHtml(page: RunPage, actions?: Actions): Html {
  const short = shortRunId(page.run.id);
  const made = page.evalCase;
  if (made) {
    const cmd = `jarvis evals run --suite ${made.suite} --mode record`;
    return html`<section class="panel card" aria-label="${t("Eval case")}" data-live="card">
<div class="row"><span class="pill ok">✓ ${t("eval case")}</span><span class="meta"><code>${made.dir}</code></span></div>
<p>${th("Review its {file}, then record the model's answers once; after that the case replays without a model, and {baseline} / {diff} catch a regression.", { file: html`<code>case.yaml</code>`, baseline: html`<code>jarvis evals baseline</code>`, diff: html`<code>diff</code>` })}</p>
<div class="actions"><span class="hint"><code>${cmd}</code></span><button type="button" class="btn" data-copy="${cmd}">${t("Copy command")}</button></div>
</section>`;
  }
  const cmd = `jarvis evals run-to-case ${short}`;
  const why = page.evalWhy;
  return html`<section class="panel decision" aria-labelledby="decision" data-live="card">
<span class="ok" style="font-size:13px;font-weight:500">${t("Done and accepted")}</span>
<h2 id="decision">${t("Keep it as an eval case")}</h2>
${
  why
    ? html`<p><b>${t("Worth keeping: Jarvis learned something on this run.")}</b></p><ul class="why">${why.map((r) => html`<li>${evalReasonText(r)}</li>`)}</ul><p class="hint">${th("Not a case? {cmd}", { cmd: html`<code>jarvis evals candidates --dismiss ${short}</code>` })}</p>`
    : html`<p class="hint">${t("It went straight through: nobody sent a document back, no back edge went round, nobody edited the spec. A case from it checks less.")}</p>`
}
<p>${t("The task, the repository at the run's base as the fixture, and the gold from what you accepted: the files the implementation changed, the spec's acceptance criteria, your answers to its open questions, the project's test command. Jarvis is then checked against this run whenever its prompts, models or tools change.")}</p>
${
  actions
    ? form(
        actions,
        `/runs/${encodeURIComponent(short)}/eval`,
        html`<div class="actions"><label class="field" style="max-width:220px">${t("Suite")}<input type="text" name="suite" value="default" pattern="[a-z0-9][a-z0-9-]{0,40}" required></label><button type="submit" class="btn primary big">${t("Make an eval case")}</button><span class="hint">${th("same as {cmd}; it lands in {dir} of the repository", { cmd: html`<code>${cmd}</code>`, dir: html`<code>evals/&lt;suite&gt;/</code>` })}</span></div>`,
      )
    : html`<div class="actions"><span class="hint"><code>${cmd}</code></span><button type="button" class="btn" data-copy="${cmd}">${t("Copy command")}</button></div>`
}
</section>`;
}

/**
 * ADR-0002 §2: the run started a change in an external system and cannot tell whether it happened. The
 * person looks for the marker and says; the page records it (src/app/effects.ts) and the run goes on.
 */
function effectCardHtml(card: EffectCard, page: RunPage, actions?: Actions): Html {
  const short = shortRunId(page.run.id);
  return html`<section class="panel decision" aria-labelledby="decision" data-live="card">
<span class="warn" style="font-size:13px;font-weight:500">${t("Waits for you")} · ${card.step}</span>
<h2 id="decision">${th("Did {capability} happen?", { capability: html`<code>${card.capability}</code>` })}</h2>
<p>${t("The run started it at {at} and lost track of whether it finished; the system cannot be asked. Doing it twice may leave a duplicate — a second comment, a second PR.", { at: wallClock(card.startedAt) })}</p>
<p>${th("Look for {marker} where it writes: a comment, a commit trailer, a PR description.", { marker: html`<code>${card.marker}</code>` })}</p>
<details><summary>${t("What it was asked")}</summary><pre class="log">${card.asked}</pre></details>
${
  actions
    ? form(
        actions,
        `/runs/${encodeURIComponent(short)}/effect`,
        html`<label class="field">${t("Note")} <span class="hint">${t("optional — for the record")}</span><input type="text" name="note" maxlength="400"></label>
<div class="actions"><button type="submit" name="decision" value="happened" class="btn primary">${t("It is there — go on")}</button><button type="submit" name="decision" value="again" class="btn">${t("It is not there — do it again")}</button></div>`,
      )
    : html`<div class="actions"><span class="hint">${th("In the terminal: {cmd}", { cmd: html`<code>jarvis effect ${short}</code>` })}</span></div>`
}
</section>`;
}

/** ADR-0019 §6.3: the ways out of a conflict with a hand edit, as `jarvis answer <run> <choice>`. */
const CONFLICT_CHOICES: ReadonlyArray<{ choice: string; label: string; hint: string }> = [
  // t("Keep mine") t("your files stay; the step starts again from them") t("Take the run's")
  // t("the files go back to the run's last commit; yours are kept under refs/jarvis/set-aside")
  // t("I combined them") t("you merged both by hand in the checkout: it is taken as it is now, the step goes on")
  { choice: "mine", label: "Keep mine", hint: "your files stay; the step starts again from them" },
  {
    choice: "run",
    label: "Take the run's",
    hint: "the files go back to the run's last commit; yours are kept under refs/jarvis/set-aside",
  },
  {
    choice: "merge",
    label: "I combined them",
    hint: "you merged both by hand in the checkout: it is taken as it is now, the step goes on",
  },
];

/** A hand edit of files the step had changed: the files, the checkout, the three ways out. */
function conflictCardHtml(card: ConflictCard, page: RunPage, actions?: Actions): Html {
  const cmd = `jarvis answer ${shortRunId(page.run.id)} mine|run|merge`;
  const buttons = actions
    ? html`<div class="actions">${CONFLICT_CHOICES.map((c, i) =>
        form(
          actions,
          `${runHref(page.run)}/conflict`,
          html`<input type="hidden" name="choice" value="${c.choice}"><button type="submit" class="btn${i === 0 ? " primary" : ""} big" title="${t(c.hint)}">${t(c.label)}</button>`,
        ),
      )}</div>
<ul class="reasons">${CONFLICT_CHOICES.map((c) => html`<li><span class="chip">${t(c.label)}</span><span>${t(c.hint)}</span></li>`)}</ul>`
    : html`<div class="actions"><span class="hint">${th("Decide in the terminal: {cmd}", { cmd: html`<code>${cmd}</code>` })}</span><button type="button" class="btn" data-copy="${cmd}">${t("Copy command")}</button></div>`;
  return html`<section class="panel decision" aria-labelledby="decision" data-live="card">
<div class="row" style="flex-direction:column;align-items:flex-start;gap:4px">
<span class="warn" style="font-size:13px;font-weight:500">${t("Waits for you")}</span>
<h2 id="decision" style="font-size:22px;line-height:28px">${card.files.length === 1 ? t("{step} had changed a file you then changed by hand", { step: card.step }) : t("{step} had changed files you then changed by hand", { step: card.step })}</h2>
<span class="muted" style="font-size:14px">${t("Jarvis does not write over a hand edit: say which version goes on.")}</span>
</div>
<ul class="reasons">${card.files.map((f) => html`<li>${fileRef(f)}</li>`)}</ul>
<div class="checkout">
<span class="muted" style="font-size:14px">${t("The run's checkout")}</span>
<div class="row"><code class="path">${card.checkoutShown}</code>${actions ? form(actions, `${runHref(page.run)}/open`, html`<button type="submit" class="btn">${t("Open in editor")}</button>`) : ""}<button type="button" class="btn" data-copy="${card.checkout}">${t("Copy path")}</button></div>
</div>
${
  card.resolved
    ? html`<div class="banner info">✓ ${card.resolved.by ? t("{choice} — decided by {who}", { choice: card.resolved.choice, who: card.resolved.by }) : t("decided: {choice}", { choice: card.resolved.choice })}</div><div class="actions">${goesOn(page, actions)}</div>`
    : buttons
}
</section>`;
}

// t("a decision")
function otherCardHtml(what: string, page: RunPage): Html {
  const cmd = `jarvis continue ${shortRunId(page.run.id)}`;
  return html`<section class="panel decision" aria-labelledby="decision" data-live="card">
<span class="warn" style="font-size:13px;font-weight:500">${t("Waits for you")}</span>
<h2 id="decision">${t("The run waits for {what}", { what: t(what) })}</h2>
<p>${reasonText(page.run.stateReason ?? "")}</p>
<div class="actions"><span class="hint">${th("Answer in the terminal: {cmd}", { cmd: html`<code>${cmd}</code>` })}</span><button type="button" class="btn" data-copy="${cmd}">${t("Copy command")}</button></div>
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
      ? ` · ${t("new")}`
      : f.status === "deleted"
        ? ` · ${t("deleted")}`
        : f.status === "renamed"
          ? ` · ${t("from {path}", { path: f.oldPath ?? "?" })}`
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
    return html`<div class="dl ${l.kind === "context" ? "ctx" : l.kind}"${can ? html` data-path="${f.path}" data-line="${line}"` : ""}>${comments ? html`<span class="cm">${can ? html`<button type="button" data-comment aria-label="${t("Comment on {path} line {line}", { path: f.path, line: String(line) })}">+</button>` : ""}</span>` : ""}<span class="n">${l.oldLine ?? ""}</span><span class="n">${l.newLine !== undefined && f.status !== "deleted" ? html`<a href="${openHref(f.path, l.newLine)}" title="${t("Open in the editor")}">${l.newLine}</a>` : ""}</span><span class="s" aria-hidden="true">${sign}</span><span class="c">${l.text}</span></div>`;
  });
  return html`<details class="panel file"${index < 12 ? html` open` : ""}>
<summary><span class="fname">${f.path}${f.status !== "deleted" ? html` <a class="open" href="${openHref(f.path)}" title="${t("Open in the editor")}">↗</a>` : ""}</span><span class="fstat"><span class="ok">+${f.added}</span> <span class="bad">−${f.removed}</span>${status}</span></summary>
<div class="scroll"><div class="diff" role="table" aria-label="${t("Changes in {path}", { path: f.path })}">${rows}${f.lines.length > shown.length ? html`<div class="dl note"><span class="c">… ${t("{n} more: jarvis diff", { n: plural(f.lines.length - shown.length, "line") })}</span></div>` : ""}</div></div>
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
  /** The implementation: how to try it before deciding (src/app/tryOut.ts). */
  readonly tryOut?: TryOut;
  /** The split of a task across services: which subtasks wait for a library of the task. */
  readonly startOrder?: ReadonlyArray<{
    readonly service: string;
    readonly library: boolean;
    readonly after: readonly string[];
  }>;
}

/** The split's start order when a library of the map changes: it first, who uses it after its change is accepted. */
// t("{libs} is a library of the map ({kind}): it changes first. The services that use it ({uses}) start once its change is accepted and published by {publish}, against the new version.")
// t("{libs} are libraries of the map ({kind}): they change first. The services that use them ({uses}) start once their changes are accepted and published by {publish}, against the new version.")
export function startOrderHtml(order: NonNullable<ArtifactExtras["startOrder"]>): Html {
  const libs = order.filter((x) => x.library).map((x) => x.service);
  return html`<section class="panel start-order" aria-labelledby="start-h"><h2 id="start-h">${t("How the subtasks start")}</h2>
<p class="hint">${th(libs.length === 1 ? "{libs} is a library of the map ({kind}): it changes first. The services that use it ({uses}) start once its change is accepted and published by {publish}, against the new version." : "{libs} are libraries of the map ({kind}): they change first. The services that use them ({uses}) start once their changes are accepted and published by {publish}, against the new version.", { libs: libs.join(", "), kind: html`<code>kind: library</code>`, uses: html`<code>uses</code>`, publish: html`<code>publish-local</code>` })}</p>
<ol class="start-list">${order.map(
    (x) =>
      html`<li><b>${x.service}</b>${x.library ? html` <span class="pill lib">library</span>` : ""} <span class="muted">${x.after.length > 0 ? t("starts after {list} is accepted", { list: x.after.join(", ") }) : t("starts at once")}</span></li>`,
  )}</ol>
<p class="hint">${t("Started anyway, a service builds against the version it has: «Start now anyway» on the master's page.")}</p>
</section>`;
}

/** A source chip; one that ends with a link (a Figma frame by its name) opens it. */
const sourceChip = (x: string) => {
  const m = /^(.*\S)\s+(https:\/\/\S+)$/.exec(x);
  if (m)
    return html`<a href="${m[2] as string}" target="_blank" rel="noopener">${cut(m[1] as string, 80)}</a>`;
  // a file of the repository opens in the editor
  const ref = fileRefOf(x);
  return ref ? raw(ref) : html`<span>${cut(x, 80)}</span>`;
};
const sourceChips = (sources: readonly string[]) =>
  sources.length > 0 ? html`<span class="src">${sources.map(sourceChip)}</span>` : "";

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
        fromSources > 0 ? t("answered from the sources: {n}", { n: fromSources }) : "",
        calls > 0 ? t("your call: {n}", { n: calls }) : "",
        items.length - fromSources - calls > 0
          ? t("need you: {n}", { n: items.length - fromSources - calls })
          : "",
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
        ? html`<label class="opt">${radio(n, "jarvis", true)}<span><span class="lbl">✦ ${t("From the sources")}</span><span class="said">${s.answer}</span>${sourceChips(s.sources)}</span></label>`
        : s?.kind === "decision"
          ? html`<p class="lbl">✦ ${t("The sources don't settle it — your call")}</p>${sourceChips(s.sources)}${s.options.map(
              (o, k) =>
                html`<label class="opt">${radio(n, `opt-${String(k)}`, o.suggested)}<span><span class="said">${o.text}</span>${o.note || o.suggested ? html`<small>${o.suggested ? t("suggested") : ""}${o.suggested && o.note ? ": " : ""}${o.note}</small>` : ""}</span></label>`,
            )}`
          : s?.unbacked && s.answer
            ? html`<label class="opt guess">${radio(n, "jarvis", false)}<span><span class="lbl">✦ ${t("Jarvis's guess — no source confirms it")}</span><span class="said">${s.answer}</span></span></label>`
            : s
              ? html`<p class="lbl">✦ ${t("Only someone else can say: the analyst, legal, another team")}</p>`
              : "";
    const own = live
      ? html`<label class="opt own">${radio(n, "own", picked === -1)}<span><span class="lbl">${t("My answer")}</span><textarea name="qa-text-${String(n)}" form="decide-form" rows="2" maxlength="4000" placeholder="${s?.kind === "answer" ? t("Instead of Jarvis's answer…") : t("Your answer…")}" data-own="${String(n)}"></textarea></span></label>
<div class="qrow"><label class="pick">${radio(n, "analyst", false)} ${t("Ask the analyst")}</label><label class="pick">${radio(n, "scope", false)} ${t("Not in scope")}</label></div>`
      : "";
    const answered = given
      ? html`<div class="done">${given.mode === "analyst" ? `↗ ${t("for the analyst")}` : given.mode === "scope" ? t("out of scope") : given.text} <span class="meta">— ${t("answered")}</span></div>`
      : "";
    return html`<fieldset class="q">
<legend class="sr">${t("Question {n}", { n })}</legend><span class="n${answered ? " ok" : ""}" aria-hidden="true">${answered ? "✓" : String(n)}</span>
<div class="body"><p class="qtext">${question}</p>${s && s.about.length > 0 ? html`<div class="about">${s.about.map((x) => html`<span class="tag">${x}</span>`)}</div>` : ""}
${answered || html`${hint}${own}`}</div>
</fieldset>`;
  };
  const preparing =
    extras.preparing && !q.suggestions
      ? html`<div class="qs-prep row"><span class="spin" aria-hidden="true"></span><span class="meta">${t("Jarvis prepares answers from the issue, its pages, the design and the research — about a minute")}</span></div>`
      : "";
  return html`<section class="panel qs" id="questions" aria-labelledby="qs-h" data-live="questions">
<div class="qs-head"><span class="pill wait">${plural(q.list.length, "open question")}</span><h2 id="qs-h">${live ? t("Answer before accepting") : t("Open questions")}</h2>${tally ? html`<span class="meta">${tally}</span>` : ""}</div>
${preparing}
${q.list.map(card)}
${
  live && extras.actions
    ? form(
        extras.actions,
        `${runHref(page.run)}/decide`,
        html`<input type="hidden" name="artifact" value="${page.artifact.artifactId}"><input type="hidden" name="version" value="${page.artifact.version}"><input type="hidden" name="lines" value="">
<span class="sum">${t("Answered questions go back with «Send back» — the next version must follow them; the rest stays open.")}</span>
<details class="note"><summary>+ ${t("A note")}</summary><label class="field grow">${t("Anything else to change")}<textarea name="comment" rows="3" placeholder="${t("What the answers above do not cover")}"></textarea></label></details>
<div class="actions"><button type="submit" name="decision" value="request_changes" class="btn strong big">${t("Send back with the answers")}</button>
<button type="submit" name="decision" value="approve" class="btn accept big">${t("Accept as is")}</button>
<span class="hint">${page.terminal ? t("The terminal waiting there picks the decision up and goes on.") : th("Same as {a} / {c} on the terminal's card.", { a: html`<code>a</code>`, c: html`<code>c</code>` })}</span></div>`,
        html` class="dock" data-decision id="decide-form"`,
      )
    : ""
}
</section>`;
}

/** « · made from 12 model calls, 30 tool calls» — nothing for a document written before refs were kept. */
function madeFrom(model: number, tools: number): string {
  if (model + tools === 0) return "";
  return ` · ${t("made from {model}, {tools}", { model: plural(model, "model call"), tools: plural(tools, "tool call") })}`;
}

// t("awaiting your approval")
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
      ? `${t("agent {id}", { id: a.provenance.agentId })}${madeFrom(a.provenance.modelCallRefs.length, a.provenance.toolCallRefs.length)}`
      : a.provenance.kind === "human"
        ? `✎ ${t("edited by a person, {who}", { who: a.provenance.actor.id })}${a.parentVersion ? ` (${t("from @{v}", { v: a.parentVersion })})` : ""}`
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
  // open questions answered here: the decision sits under them, the document below — no side column
  const asked = page.questions !== undefined && page.awaited && extras.actions !== undefined;
  const aside =
    !asked && (page.awaited || page.decision || f)
      ? html`<aside class="panel aside" aria-labelledby="your-decision" data-live="decision">
<h2 id="your-decision">${page.awaited ? t("Your decision") : page.decision ? t("Decision") : t("In brief")}</h2>
${f?.summary ? html`<p style="font-size:14px;line-height:21px;color:var(--ink-2)">${cut(f.summary, 400)}</p>` : ""}
${
  requirements.length > 0
    ? html`<div class="facts"><span class="lbl">${t("Requirements")}</span>${requirements.slice(0, 8).map((x) => html`<span>${cut(reqText(x), 140)}</span>`)}${requirements.length > 8 ? html`<span class="muted">${t("+{n} more", { n: requirements.length - 8 })}</span>` : ""}</div>`
    : ""
}
${f && f.risks.length > 0 ? html`<div class="facts"><span class="lbl">${t("Risks")}</span>${f.risks.slice(0, 4).map((x) => html`<span>${cut(x, 200)}</span>`)}</div>` : ""}
${f && f.openQuestions.length > 0 && !page.questions ? html`<div class="facts"><span class="lbl warn">${t("Open questions")}</span>${f.openQuestions.map((x, i) => html`<span>${i + 1}) ${cut(x, 200)}</span>`)}</div>` : ""}
${
  page.decision
    ? html`<div class="banner ${tone === "info" ? "info" : tone === "wait" ? "info" : tone}">${glyph} ${t("{state} by {actor}", { state: t(page.state), actor: page.decision.approval.actor.id })}${page.decision.channel === "ui" ? ` ${t("in the browser")}` : page.decision.channel === "cli" ? ` ${t("in the terminal")}` : ""}${page.decision.approval.comment ? html`<br><span style="white-space:pre-wrap">${page.decision.approval.comment.length > 1200 ? `${page.decision.approval.comment.slice(0, 1199)}…` : page.decision.approval.comment}</span>` : ""}</div>`
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
<label for="comment">${t("What to change")} <span class="muted">(${t("for Send back; line comments on the diff go with it")})</span></label>
<textarea id="comment" name="comment" rows="3"></textarea>
<button type="submit" name="decision" value="approve" class="btn accept big">${t("Accept")}</button>
<button type="submit" name="decision" value="request_changes" class="btn strong big" data-send-back>${t("Send back")}</button>
<span class="hint">${th("Same as {a} / {c} on the terminal's card.", { a: html`<code>a</code>`, c: html`<code>c</code>` })} ${page.terminal ? t("The terminal waiting there picks the decision up and goes on.") : th("No terminal waits: the run goes on with {cmd}.", { cmd: html`<code>jarvis continue ${shortRunId(page.run.id)}</code>` })}</span>
</div>`,
        html` data-decision`,
      )
    : page.awaited
      ? html`<div class="decide"><span class="hint">${th("Decide in the terminal: {cmd} — {a} accepts, {c} sends back.", { cmd: html`<code>jarvis continue ${shortRunId(page.run.id)}</code>`, a: html`<code>a</code>`, c: html`<code>c</code>` })}</span><button type="button" class="btn" data-copy="jarvis continue ${shortRunId(page.run.id)}">${t("Copy command")}</button></div>`
      : ""
}
</aside>`
      : "";
  return html`<div style="display:flex;flex-direction:column;gap:8px" data-live="head">
<div class="row">${page.state ? html`<span class="pill ${tone}">${glyph} ${t(page.state)}</span>` : ""}<span class="meta" style="font-size:13px">${a.type}/${a.name}@${a.version} · ${a.stepId ?? "-"}${a.iteration && a.iteration > 1 ? `#${a.iteration}` : ""} · ${who} · run ${shortRunId(page.run.id)}</span></div>
<h1>${title}</h1>
${
  page.versions.length > 1
    ? html`<nav class="versions" aria-label="${t("Versions")}"><span style="background:none;color:var(--muted);padding:0">${t("version")}</span>${page.versions.map(
        (v) =>
          v === a.version
            ? html`<span aria-current="page">${v}</span>`
            : html`<a href="${artifactHref(page.run, { type: a.type, name: a.name, version: v })}">${v}</a>`,
      )}</nav>`
    : ""
}
</div>
${extras.banner ?? ""}
${page.editFile ? html`<p class="meta">✎ ${th("Edit it as a file: {file} — the change becomes the next version, yours, before the next step reads it (or {cmd}).", { file: html`<code>${page.editFile}</code>`, cmd: html`<code>jarvis edit ${shortRunId(page.run.id)} ${a.type}</code>` })}</p>` : ""}
${partial ? html`<div class="banner bad">⚠ ${t("incomplete: agent {agent} hit its {limit} limit — what it did not cover is unknown", { agent: partial.agentId, limit: partial.limit })}</div>` : ""}
${
  diff || page.questions || extras.tryOut
    ? html`<nav class="tabs" aria-label="${t("Sections")}">${page.questions ? html`<a href="#questions">${t("Questions")} <span class="muted">${page.questions.list.length}</span></a>` : ""}${extras.tryOut ? html`<a href="#try">${t("Try it")}</a>` : ""}<a href="#document">${diff ? t("Summary") : t("Document")}</a>${diff ? html`<a href="#files">${t("Files changed")} <span class="muted">${diff.length}</span></a>` : ""}</nav>`
    : ""
}
<div class="cols">
<div class="mainc">
${questionsHtml(page, extras)}
${extras.tryOut ? tryHtml(extras.tryOut, page, extras) : ""}
${extras.startOrder?.some((x) => x.library) ? startOrderHtml(extras.startOrder) : ""}
<section id="document" class="panel doc" aria-label="${t("Document")}">${a.type === "check-log" ? checkLogHtml(page.text) : ((checks) => (checks ? checksHtml(page.run, checks) : documentHtml(a.name, page.text, f?.doc)))(a.type === "checks" ? checksOf(parseJson(page.text)) : undefined)}</section>
${
  diff
    ? html`<section id="files" class="group" aria-labelledby="files-h"><h2 id="files-h">${t("Files changed")} <span class="muted" style="font-weight:400">${diff.length}</span></h2>${
        diff.length > 0
          ? diff.map((x, i) =>
              diffFileHtml(x, i, extras.comments === true && page.awaited && extras.actions !== undefined),
            )
          : html`<div class="panel empty">${t("No changes against the base.")}</div>`
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
  return html`<div class="lede"><h1>${status === 404 ? t("Not found") : t("Something went wrong")}</h1></div>
<div class="panel empty"><p>${message}</p>${hint ? html`<p class="muted" style="margin-top:8px">${hint}</p>` : ""}</div>`;
}

/** The plain page a request without the session token gets. */
export function forbiddenPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>jarvis ui</title></head><body style="font-family:system-ui,sans-serif;padding:32px"><h1 style="font-size:22px">403 — this page needs its session token</h1><p>Open the address <code>jarvis ui</code> printed in the terminal: it carries the token.</p></body></html>`;
}

export { escapeHtml };

/* ---- the models indicator (ADR-0023): a dot in the header, the details in a popover ---- */

// t("ok") t("busy") t("down") t("idle")
const HEALTH: Record<HealthState, { label: string; pill: string }> = {
  ok: { label: "ok", pill: "ok" },
  busy: { label: "busy", pill: "wait" },
  down: { label: "down", pill: "bad" },
  idle: { label: "idle", pill: "plain" },
};

/** One line for the indicator's tooltip: the worst model and why; and what is unlimited now. */
export function modelsSummary(h: ModelsHealth): string {
  if (h.models.length === 0) return t("Models: none configured");
  const worst = h.models.find((m) => m.state === h.state);
  const why = worst?.reasons[0];
  const free = unlimitedNow(h);
  return `${t("Models")}: ${t(HEALTH[h.state].label)}${worst && h.state !== "ok" && h.state !== "idle" ? ` — ${worst.id}${why ? `: ${why}` : ""}` : ""}${free ? ` · ${free.id}: ${unlimitedText(free.unlimited)}` : ""}`;
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
  return free.unlimited.until ? `∞ ${t("until {at}", { at: whenAt(free.unlimited.until) })}` : "∞";
}

/** `14:30` today, `Mon 07:00` another day. */
function whenAt(ts: string): string {
  const at = new Date(ts);
  const time = at.toTimeString().slice(0, 5);
  return at.toDateString() === new Date().toDateString()
    ? time
    : `${at.toLocaleDateString(lang() === "ru" ? "ru-RU" : "en-GB", { weekday: "short" })} ${time}`;
}

function unlimitedText(u: Unlimited): string {
  if (u.now)
    return u.always
      ? t("unlimited (its pool has no limits)")
      : u.until
        ? t("unlimited hours until {at}", { at: whenAt(u.until) })
        : t("unlimited hours");
  return u.next ? t("unlimited hours from {at}", { at: whenAt(u.next) }) : "";
}

const pct = (share: number) => `${Math.round(share * 100)}%`;
const wall = (ts: string) => new Date(ts).toTimeString().slice(0, 5);

function modelHtml(m: ModelHealth): Html {
  const w = m.window;
  const used = w?.share !== undefined ? Math.min(100, Math.round(w.share * 100)) : undefined;
  const r = m.recent;
  const lineOf = [
    plural(r.calls, "call"),
    ...(r.failed > 0 ? [t("failed: {n}", { n: r.failed })] : []),
    ...(r.retries > 0 ? [plural(r.retries, "retry", "retries")] : []),
    ...(r.latencyP50Ms ? [`p50 ${duration(r.latencyP50Ms)}`] : []),
    ...(r.lastCallAt ? [t("last at {at}", { at: wall(r.lastCallAt) })] : []),
  ].join(" · ");
  const waiting = [
    ...m.waiting.model.map((id) => ({ id, why: t("the model") })),
    ...m.waiting.quota.map((id) => ({ id, why: t("quota") })),
  ];
  return html`<li class="mh">
<div class="row"><span class="dot" data-state="${m.state}" aria-hidden="true"></span><b class="mono">${m.id}</b><span class="pill ${HEALTH[m.state].pill}">${t(HEALTH[m.state].label)}</span>${m.unlimited?.now ? html`<span class="pill ok">∞ ${unlimitedText(m.unlimited)}</span>` : ""}</div>
${m.reasons.length > 0 ? html`<ul class="why">${m.reasons.map((x) => html`<li>${x}</li>`)}</ul>` : ""}
${
  w
    ? html`<div class="win">${used !== undefined ? html`<div class="bar" role="img" aria-label="${t("quota window {n}% used", { n: used })}"><span class="${w.share !== undefined && w.share >= 1 ? "full" : w.share !== undefined && w.share >= w.soft ? "soft" : ""}" style="width:${used}%"></span></div>` : ""}
<span class="meta">${w.inputLimit || w.inputTokens > 0 ? `${kilo(w.inputTokens)}${w.inputLimit ? ` / ${kilo(w.inputLimit)}` : ""} ${t("input")} · ` : ""}${kilo(w.outputTokens)}${w.outputLimit ? ` / ${kilo(w.outputLimit)}` : ""} ${t("output tok")} · ${w.requests}${w.requestLimit ? ` / ${w.requestLimit}` : ""} ${t("requests")} · ${t("{n} min window", { n: w.minutes })}${w.share !== undefined ? ` · ${pct(w.share)}` : ""}</span></div>`
    : ""
}
${m.unlimited && !m.unlimited.now && m.unlimited.next ? html`<span class="meta">${unlimitedText(m.unlimited)}</span>` : ""}
${m.inFlight.calls > 0 ? html`<span class="meta now-line"><span class="spin" aria-hidden="true"></span>${t("{n} being answered now", { n: plural(m.inFlight.calls, "request") })}${m.inFlight.longestMs ? ` · ${t("longest {d}", { d: units(duration(m.inFlight.longestMs)) })}` : ""}</span>` : ""}
<span class="meta">${t("last {n} min:", { n: r.minutes })} ${lineOf}</span>
${m.perf ? perfHtml(m.perf) : ""}
${r.lastFailure ? html`<span class="meta">${t("last failure {at}", { at: wall(r.lastFailure.at) })} · ${r.lastFailure.reason}</span>` : ""}
${
  waiting.length > 0
    ? html`<span class="meta">${t("waiting:")} ${join(
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
    [t("latency"), pcs(p.latencyMs, duration)],
    ...(p.firstTokenMs
      ? ([
          [t("first token"), `${pcs(p.firstTokenMs, duration)} · ${t("streamed: {n}", { n: p.streamed })}`],
        ] as Array<[string, string]>)
      : []),
    [t("speed"), pcs(p.outputPerSecond, (n) => `${Math.round(n)} tok/s`)],
    [
      t("throughput"),
      t("{out} out · {in} in tok/min", { out: kilo(p.outputPerMinute), in: kilo(p.promptPerMinute) }),
    ],
    [
      t("per call"),
      t("in avg {in} (max {inMax}) · out avg {out} (max {outMax})", {
        in: kilo(p.prompt.avg),
        inMax: kilo(p.prompt.max),
        out: kilo(p.output.avg),
        outMax: kilo(p.output.max),
      }),
    ],
    [t("total"), t("{in} in · {out} out", { in: kilo(p.prompt.total), out: kilo(p.output.total) })],
    [
      t("cache"),
      `${t("{n}% cached", { n: Math.round(p.cachedShare * 100) })}${p.prefixReuseP50 !== undefined ? ` · ${t("prefix reusable p50 {n}%", { n: Math.round(p.prefixReuseP50 * 100) })}` : ""}`,
    ],
    [
      t("answers"),
      `${Math.round(p.successRate * 1000) / 10}% ok${p.retriedCalls > 0 ? ` · ${t("{n} after a retry", { n: p.retriedCalls })}` : ""}${p.cut > 0 ? ` · ${t("{n} cut at maxOutput", { n: p.cut })}` : ""}`,
    ],
  ];
  return html`<dl class="perf">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

/** The popover's body: each model, then where the full numbers are. */
export function modelsPopover(h: ModelsHealth): Html {
  return html`<div class="pop-head"><b>${t("Models")}</b><span class="pill ${HEALTH[h.state].pill}">${t(HEALTH[h.state].label)}</span><span class="meta">${t("at {at}", { at: wall(h.at) })}</span></div>
${
  h.models.length > 0
    ? html`<ul class="mhs">${h.models.map(modelHtml)}</ul>`
    : html`<p class="muted">${t("No models configured — add one to ~/.jarvis/config.yaml.")}</p>`
}
${h.load ? loadHtml(h.load) : ""}
<p class="hint">${th("In the terminal: {stats} (latency, failures, tokens) · {list} (pools, probes)", { stats: html`<code>jarvis models stats</code>`, list: html`<code>jarvis models list</code>` })}</p>`;
}

/** Requests at once over every run: what a pool's concurrency limit would cap (none is applied yet). */
function loadHtml(load: NonNullable<ModelsHealth["load"]>): Html {
  const n = load.inFlight.length;
  return html`<div class="mh mload"><div class="row"><b>${t("At once")}</b><span class="meta">${n === 0 ? t("no model request now") : t("{n} now", { n: plural(n, "request") })}${load.peak ? ` · ${t("peak today {n} at {at}", { n: load.peak.count, at: wall(load.peak.at) })}` : ""}</span></div>
${n > 0 ? html`<ul class="mload-runs">${load.inFlight.map((f) => html`<li><a href="/runs/${f.run}">${f.run}</a> <span class="meta">${f.step}${f.modelId ? ` · ${f.modelId}` : ""} · ${t("waiting {d}", { d: clock(Math.max(0, f.waitingMs)) })}</span></li>`)}</ul>` : ""}
<p class="hint">${th("Over every run and process. {max} of a model holds within one run only; nothing caps runs together yet (a pool's {limit}): watch this if the platform starts answering 429.", { max: html`<code>maxConcurrency</code>`, limit: html`<code>limits.concurrency</code>` })}</p></div>`;
}

/** The popover before the first numbers: open at once, saying what it waits for. */
export function modelsPending(): Html {
  return html`<div class="pop-head"><b>${t("Models")}</b><span class="spin" aria-hidden="true"></span><span class="meta">${t("waiting for data")}</span></div>
<p class="muted">${t("Collecting the models' stats — each pool's quota window and the last half hour of calls. It shows up here in a moment.")}</p>`;
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
<div class="row"><span class="pill ${failed ? "bad" : "info"}">${failed ? (l.exitCode === 0 ? t("ended without a run") : t("failed to start · exit {code}", { code: String(l.exitCode) })) : `◌ ${t("starting")}`}</span><span class="meta">${l.workflow} · ${th("started {age} ago", { age })} · ${home(l.repo, homeDir)}</span></div>
<h1>${firstLine(l.task)}</h1>
</div>
${
  failed
    ? html`<section class="panel now"><p>${t("The task did not become a run. Its output is below; fix the cause and start it again.")}</p><div class="actions"><a class="btn primary" href="/#new">${t("New task")}</a></div></section>`
    : html`<section class="panel now" aria-live="polite"><div class="row"><span class="spin" aria-hidden="true"></span><b>${t("Preparing the run's checkout")}</b></div>
<p class="muted">${t("A worktree of the repository and its workspace setup (installing, building) — for a monorepo that takes a few minutes. This page turns into the run's page by itself as soon as the run begins.")}</p></section>`
}
<section class="panel feed" aria-labelledby="output"><h2 id="output">${t("Output")}</h2>
${l.tail ? html`<pre class="tail">${l.tail}</pre>` : html`<p class="muted">${t("Nothing yet.")}</p>`}
<span class="meta">${t("log")} ${home(l.log, homeDir)}</span></section></div>`;
}

/* ---- the MCP indicator (ADR-0023, ADR-0017): the same dot and popover as the models' ---- */

/** One line for the indicator's tooltip: the worst server and why. */
export function mcpSummary(h: McpHealth): string {
  if (h.servers.length === 0) return t("MCP: no servers configured");
  const worst = h.servers.find((s) => s.state === h.state);
  const why = worst?.reasons[0];
  return `MCP: ${t(h.state === "busy" ? "attention" : HEALTH[h.state].label)}${worst && h.state !== "ok" && h.state !== "idle" ? ` — ${worst.id}${why ? `: ${why}` : ""}` : ""}`;
}

const day = (ts: string) => `${ts.slice(0, 10)} ${wall(ts)}`;
const names = (xs: readonly string[]) => (xs.length > 0 ? xs.join(", ") : "—");

function serverHtml(s: McpServerHealth): Html {
  const p = s.probe;
  const check = s.checking
    ? t("checking now…")
    : p
      ? p.ok
        ? `${t("answered {at}", { at: wall(p.at) })} · ${plural(p.tools ?? 0, "tool")} · ${duration(p.ms ?? 0)}`
        : `${t("no answer {at}", { at: wall(p.at) })} · ${p.error ?? t("error")}`
      : t("not checked yet");
  const r = s.recent;
  const calls =
    r.calls + r.denied === 0
      ? t("none")
      : [
          plural(r.calls, "call"),
          ...(r.failed > 0 ? [t("failed: {n}", { n: r.failed })] : []),
          ...(r.denied > 0 ? [t("denied by policy: {n}", { n: r.denied })] : []),
          ...(r.lastCallAt ? [t("last at {at}", { at: wall(r.lastCallAt) })] : []),
        ].join(" · ");
  const rows: Array<[string, string]> = [
    ...(s.egressException
      ? ([
          [
            "egress",
            t("out of the project's data class by an exception, reads only: {why}", {
              why: s.egressException,
            }),
          ],
        ] as Array<[string, string]>)
      : []),
    [t("check"), check],
    [
      t("discovered"),
      s.discovered ? `${day(s.discovered.at)} · ${plural(s.discovered.count, "tool")}` : t("never"),
    ],
    [t("exposed"), names(s.exposed)],
    ...(s.denied.length > 0
      ? ([[t("denied"), `${names(s.denied)} (allow / deny)`]] as Array<[string, string]>)
      : []),
    ...(s.unmapped.length > 0
      ? ([[t("unmapped"), `${names(s.unmapped)} (${t("the server lacks the tool")})`]] as Array<
          [string, string]
        >)
      : []),
    ...(s.notAllowed.length > 0
      ? ([
          [
            t("not allowed"),
            `${t("{n} without a profile entry:", { n: plural(s.notAllowed.length, "tool") })} ${s.notAllowed.slice(0, 6).join(", ")}${s.notAllowed.length > 6 ? ", …" : ""}`,
          ],
        ] as Array<[string, string]>)
      : []),
    [t("last {n} min", { n: r.minutes }), calls],
    ...(r.latencyMs
      ? ([
          [
            t("latency"),
            `p50 ${duration(r.latencyMs.p50)} · p90 ${duration(r.latencyMs.p90)} · max ${duration(r.latencyMs.max)}`,
          ],
        ] as Array<[string, string]>)
      : []),
    ...(r.byCapability.length > 0
      ? ([
          [
            t("used"),
            r.byCapability
              .map(
                (c) => `${c.name} ${c.calls}${c.failed > 0 ? ` (${t("failed: {n}", { n: c.failed })})` : ""}`,
              )
              .join(" · "),
          ],
        ] as Array<[string, string]>)
      : []),
    ...(r.lastFailure
      ? ([
          [
            t("last failure"),
            `${wall(r.lastFailure.at)} · ${r.lastFailure.capability} · ${r.lastFailure.reason}`,
          ],
        ] as Array<[string, string]>)
      : []),
  ];
  return html`<li class="mh">
<div class="row"><span class="dot" data-state="${s.checking && !p ? "pending" : s.state}" aria-hidden="true"></span><b class="mono">${s.id}</b>${s.egressAllowed ? html`<span class="pill ${HEALTH[s.state].pill}">${t(HEALTH[s.state].label)}</span>` : html`<span class="pill wait" title="${t("the project's dataClass keeps the agents off this network")}">${t("{network}: off for agents", { network: s.network })}</span>`}${s.egressException ? html`<span class="pill wait" title="${s.egressException}">⚠ ${t("{network} by exception", { network: s.network })}</span>` : ""}<span class="meta">${s.profile ? t("profile {name}", { name: s.profile }) : s.readOnly ? "readOnly" : t("no profile")} · ${s.network} · ${s.transport}</span></div>
${
  s.reasons.length > 0
    ? html`<ul class="why">${s.reasons.map((x) =>
        // the network the project keeps the agents off: said in the page's language, with what to do
        x.startsWith("agents do not get it:")
          ? html`<li>${th("Agents do not get it: the project's dataClass keeps them off the {network} network. To let them in, add it to {key} in .jarvis/project.yaml — the top bar then warns about it on every page.", { network: s.network, key: html`<code>egressExceptions</code>` })}</li>`
          : html`<li>${x}</li>`,
      )}</ul>`
    : ""
}
<span class="meta mono">${s.target}${s.auth ? ` · auth ${s.auth}` : ""}</span>
<dl class="perf">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
</li>`;
}

/** The popover's body: each server, a check on demand, then where the rest is. */
export function mcpPopover(h: McpHealth, options: { readonly checkToken?: string } = {}): Html {
  const checking = h.servers.some((s) => s.checking);
  // a server only kept off its network is a warning, not work in progress
  const head = h.state === "busy" ? { label: "attention", pill: "wait" } : HEALTH[h.state];
  // t("attention")
  return html`<div class="pop-head"><b>MCP</b><span class="pill ${head.pill}">${t(head.label)}</span><span class="meta">${t("at {at}", { at: wall(h.at) })}</span>${
    options.checkToken && h.servers.length > 0
      ? checking
        ? html`<span class="spin" aria-hidden="true"></span>`
        : html`<button type="button" class="btn small" data-mcp-check="${options.checkToken}">${t("Check now")}</button>`
      : ""
  }</div>
${
  h.servers.length > 0
    ? html`<ul class="mhs">${h.servers.map(serverHtml)}</ul>`
    : html`<p class="muted">${t("No MCP servers — add them under mcp.servers in ~/.jarvis/config.yaml or .jarvis/project.yaml.")}</p>`
}
<p class="hint">${th("In the terminal: {list} (connect and list) · {doctor} (credentials) · {auth} (a token)", { list: html`<code>jarvis mcp list --refresh</code>`, doctor: html`<code>jarvis doctor</code>`, auth: html`<code>jarvis auth set &lt;id&gt;</code>` })}</p>`;
}

/** The popover before the first answer: open at once, saying what it waits for. */
export function mcpPending(): Html {
  return html`<div class="pop-head"><b>MCP</b><span class="spin" aria-hidden="true"></span><span class="meta">${t("waiting for data")}</span></div>
<p class="muted">${t("Reading the MCP servers' state and checking that each answers — the first check of a server started by uvx or npx takes a few seconds.")}</p>`;
}

import { type Activity, activityOf } from "../app/activity.ts";
import { duration } from "../app/journey.ts";
import type { Runtime } from "../app/runtime.ts";
import type { Run } from "../core/domain/run.ts";
import { type VerifiedAnswer, verifiedOf } from "../knowledge/ask.ts";
import type { GlossaryEntry } from "../knowledge/retrieval/glossary.ts";
import type { KnowledgeRoots } from "../knowledge/standards.ts";
import { shortRunId } from "../storage/runStore.ts";
import { type Html, html, markdownToHtml } from "./html.ts";
import { plural, t, th } from "./i18n.ts";

const tr = t;

import { type KnowledgeCounts, knowledgeTabs } from "./knowledge.ts";
import { type Actions, callText, ticking, wallClock } from "./pages.ts";

/**
 * Knowledge → Ask (ADR-0024): `jarvis ask` in the page. The project's knowledge is searched first (no
 * model, at once); then an agent that may only read the knowledge answers, and every excerpt it quotes is
 * checked against its source. A question is a run of its own (`ask`): in Runs too, and in the list here.
 */

export interface AskSource {
  readonly ref: string;
  readonly kind: string;
  readonly title: string;
  readonly snippet?: string;
  /** How the search found it: `lexical#1,semantic#3`. */
  readonly path?: string;
}

export interface AskView {
  readonly question: string;
  readonly general: boolean;
  readonly sources: readonly AskSource[];
  readonly expansions?: ReadonlyArray<{ readonly term: string; readonly added: readonly string[] }>;
  /** Glossary terms of the question (the search without a model). */
  readonly terms?: readonly GlossaryEntry[];
  readonly run?: Run;
  readonly modelCalls: number;
  readonly tookMs?: number;
  readonly activity?: Activity;
  readonly verified?: VerifiedAnswer;
  readonly problem?: string;
}

export interface AskRecent {
  readonly run: Run;
  readonly question: string;
  readonly label: string;
}

export interface AskPage {
  readonly counts: KnowledgeCounts;
  readonly current?: AskView;
  readonly recent: readonly AskRecent[];
  readonly form: { readonly q: string; readonly mode: "answer" | "sources"; readonly general: boolean };
  readonly error?: string;
}

interface Asked {
  question: string;
  general: boolean;
  sources: AskSource[];
  expansions?: Array<{ term: string; added: string[] }>;
}

/** What the run was asked with, from its `run.created` (older runs: the question alone). */
function askedOf(runtime: Runtime, run: Run): Asked {
  const created = runtime.events.list({ runId: run.id, kind: "run.created", limit: 1 })[0];
  const p = (created?.payload ?? {}) as Record<string, unknown>;
  const a = (p.ask ?? {}) as Partial<Asked>;
  return {
    question:
      typeof a.question === "string"
        ? a.question
        : typeof p.task === "string"
          ? p.task
          : (run.task.split("\n")[0] ?? ""),
    general: a.general === true,
    sources: Array.isArray(a.sources) ? a.sources : [],
    ...(Array.isArray(a.expansions) ? { expansions: a.expansions } : {}),
  };
}

export function askOfRun(runtime: Runtime, roots: KnowledgeRoots, run: Run, now: Date = new Date()): AskView {
  const asked = askedOf(runtime, run);
  const events = runtime.events.list({ runId: run.id, limit: 1_000_000 });
  const modelCalls = events.filter((e) => e.kind === "model.call").length;
  const done = run.state === "COMPLETED" || run.state === "FAILED" || run.state === "CANCELLED";
  const activity = done ? undefined : activityOf(events, now);
  const verified = run.state === "COMPLETED" ? verifiedOf(runtime, roots, run.id) : undefined;
  return {
    ...asked,
    run,
    modelCalls,
    ...(done ? { tookMs: Math.max(0, Date.parse(run.updatedAt) - Date.parse(run.createdAt)) } : {}),
    ...(activity ? { activity } : {}),
    ...(verified ? { verified } : {}),
    ...(run.state === "FAILED" || run.state === "CANCELLED"
      ? {
          problem: run.stateReason ?? t("the answering run ended {state}", { state: run.state }),
        }
      : {}),
  };
}

/** The last questions, newest first, with how each ended. */
export function recentAsks(runtime: Runtime, roots: KnowledgeRoots, limit = 10): AskRecent[] {
  return runtime.runs
    .list({ includeTerminal: true, limit: 1_000_000 })
    .filter((r) => r.workflow === "ask")
    .slice(0, limit)
    .map((run) => {
      const asked = askedOf(runtime, run);
      let label: string;
      if (run.state === "COMPLETED") {
        const v = verifiedOf(runtime, roots, run.id);
        label = v?.found
          ? `${t("answered")} · ${plural(v.citations.length, "source")}`
          : v?.general
            ? t("general knowledge only")
            : t("not in the knowledge");
      } else if (run.state === "FAILED" || run.state === "CANCELLED") label = run.state;
      else label = t("answering…");
      return { run, question: asked.question, label };
    });
}

const askHref = (run: Pick<Run, "id">) => `/knowledge/ask?run=${encodeURIComponent(shortRunId(run.id))}`;

function when(iso: string, now: number): string {
  const d = new Date(iso);
  const today = new Date(now);
  return d.toDateString() === today.toDateString()
    ? t("today {at}", { at: wallClock(iso).slice(0, 5) })
    : d.toISOString().slice(0, 10);
}

function sourcesHtml(view: AskView): Html {
  if (view.sources.length === 0) return html``;
  const cited = new Set((view.verified?.citations ?? []).map((c) => c.ref));
  const expand = view.expansions?.length
    ? html` <span class="hint">— ${t("by words and the glossary:")} ${view.expansions.map((x) => `${x.term} → ${x.added.join(", ")}`).join("; ")}</span>`
    : html` <span class="hint">${t("— by words")}</span>`;
  return html`<h2 class="ask-sec">${t("Found")} · ${String(view.sources.length)}${expand}</h2>
<section class="panel ask-found" aria-label="${t("Found in the knowledge")}">${view.sources.map(
    (s, i) =>
      html`<a class="item" href="${docLink(s.ref)}"><span class="n">${String(i + 1)}</span><span class="t"><b>${s.title || s.ref}${cited.has(s.ref) ? html` <span class="pill ok">${t("cited")}</span>` : ""}</b>${s.snippet ? html`<span>${s.snippet}</span>` : ""}</span><span class="meta">${s.path ?? s.kind}</span></a>`,
  )}</section>`;
}

/** A knowledge document's page; standards and skills by their tab. */
function docLink(ref: string): string {
  const m = /^knowledge:(.+?)(?:#.*)?$/.exec(ref);
  if (m) return `/knowledge/docs?doc=${encodeURIComponent(m[1] as string)}`;
  const st = /^standard:([^@]+)/.exec(ref);
  if (st) return `/knowledge/standards?id=${encodeURIComponent(st[1] as string)}`;
  return "/knowledge";
}

function termsHtml(terms: readonly GlossaryEntry[]): Html {
  if (terms.length === 0) return html``;
  return html`<section class="panel ask-terms" aria-label="${t("Glossary")}">${terms.map(
    (t) =>
      html`<div><b>${t.term}</b>${t.definition ? html` — ${t.definition}` : ""}${t.synonyms.length ? html`<span class="hint">${tr("also:")} ${t.synonyms.join(", ")}</span>` : ""}${t.symbols.length ? html`<span class="meta">${tr("in code:")} ${t.symbols.join(", ")}</span>` : ""}</div>`,
  )}</section>`;
}

function answerHtml(view: AskView, now: number): Html {
  const run = view.run;
  if (!run) return html``;
  const head = html`<span class="q">«${view.question}» · run <a href="/runs/${shortRunId(run.id)}">${shortRunId(run.id)}</a>${view.modelCalls > 0 ? ` · ${plural(view.modelCalls, "model call")}` : ""}${view.tookMs !== undefined ? ` · ${duration(view.tookMs)}` : ""}</span>`;
  if (view.activity && !view.verified && !view.problem)
    return html`<section class="panel ask-answer">${head}<div class="row"><span class="spin" aria-hidden="true"></span><span class="meta">${t("answering")} · ${ticking(now - Date.parse(run.createdAt))} · ${callText(view.activity)}</span></div><p class="hint">${t("The sources below are what the model reads; the answer comes here, its excerpts checked against them.")}</p></section>`;
  if (view.problem)
    return html`<section class="panel ask-answer">${head}<div class="banner bad">${view.problem}</div></section>`;
  const v = view.verified;
  if (!v)
    return html`<section class="panel ask-answer">${head}<p class="muted">${t("No answer document.")}</p></section>`;
  return html`<section class="panel ask-answer">${head}
${
  v.found
    ? html`<div class="a doc">${markdownToHtml(v.answer)}</div>
<ol class="cites">${v.citations.map((c) => html`<li><a href="${docLink(c.ref)}"><code>${c.ref}</code></a><q>${c.quote}</q></li>`)}</ol>`
    : html`<div class="banner wait">${t("The knowledge has no confirmed answer to this question")}${v.rejected.length > 0 ? ` — ${t("the answer's excerpts were not found in their sources")}` : ""}.</div>`
}
${v.gaps.length > 0 ? html`<div class="gaps"><b>${t("Not in the knowledge")}</b><ul>${v.gaps.map((g) => html`<li>${g}</li>`)}</ul></div>` : ""}
${v.general ? html`<div class="general"><b>${t("Not from the knowledge — the model's general knowledge")}</b>${markdownToHtml(v.general)}</div>` : ""}
<div class="checks">${v.citations.length > 0 ? html`<span class="pill ok">✓ ${t("{n} found in their sources", { n: plural(v.citations.length, "excerpt") })}</span>` : ""}${v.rejected.length > 0 ? html`<span class="pill bad">${t("{n} not in the source:", { n: v.rejected.length })} ${v.rejected.map((x) => x.ref).join(", ")}</span>` : ""}<span class="meta">${t("general knowledge:")} ${view.general ? (v.general ? t("used, labelled") : t("allowed, not used")) : t("not allowed")}</span></div>
</section>`;
}

export function askContent(page: AskPage, actions?: Actions, now: number = Date.now()): Html {
  const f = page.form;
  const fields = html`<textarea name="q" rows="3" required maxlength="500" placeholder="${t("Ask about this project: where, how, why, who owns it")}">${f.q}</textarea>
<div class="row">
<div class="seg" role="radiogroup" aria-label="${t("How to answer")}">${
    actions
      ? html`<label><input type="radio" name="mode" value="answer"${f.mode === "answer" ? " checked" : ""}><span>${t("Answer")}</span></label>`
      : ""
  }<label><input type="radio" name="mode" value="sources"${f.mode === "sources" || !actions ? " checked" : ""}><span>${t("Sources only")}</span></label></div>
${actions ? html`<label class="check" style="margin:0"><input type="checkbox" name="general" value="1"${f.general ? " checked" : ""}> ${t("General knowledge too")} <span class="meta">${t("when the project has no answer, labelled")}</span></label>` : ""}
<span style="flex:1"></span><button type="submit" class="btn primary">${t("Ask")}</button>
</div>
<p class="hint">${th("The project's knowledge is searched first, without a model; then the model answers from what was found and every excerpt it quotes is checked against its source. A question is a run of its own ({workflow}), in Runs as well.", { workflow: html`<code>ask</code>` })}</p>`;
  const askForm = actions
    ? html`<form class="panel ask" method="post" action="/knowledge/ask"><input type="hidden" name="t" value="${actions.token}">${fields}</form>`
    : html`<form class="panel ask" method="get" action="/knowledge/ask">${fields}</form>`;
  const v = page.current;
  return html`${knowledgeTabs("ask", page.counts)}
<div class="askwrap">
<div class="askmain">
${askForm}
${page.error ? html`<div class="banner bad">${page.error}</div>` : ""}
<div data-live="ask">${v ? html`${answerHtml(v, now)}${v.terms ? termsHtml(v.terms) : ""}${sourcesHtml(v)}${!v.run && v.sources.length === 0 && !v.terms?.length ? html`<div class="panel empty">${th("Nothing in the knowledge for «{q}». Add a document to {dir} or a term to the glossary.", { q: v.question, dir: html`<code>.jarvis/knowledge/</code>` })}${actions ? html` ${t("Or ask with General knowledge too for a labelled answer.")}` : ""}</div>` : ""}` : ""}</div>
</div>
<aside class="panel ask-recent" aria-label="${t("Recent questions")}" data-live="ask-recent"><h3>${t("Recent questions")}</h3>${
    page.recent.length > 0
      ? page.recent.map(
          (r) =>
            html`<a href="${askHref(r.run)}"${v?.run?.id === r.run.id ? html` aria-current="page"` : ""}>${r.question}<span>${when(r.run.createdAt, now)} · ${r.label}</span></a>`,
        )
      : html`<p class="hint">${t("No questions yet.")}</p>`
  }</aside>
</div>`;
}

import type {
  DocView,
  GlossaryRow,
  GlossaryView,
  SkillView,
  StandardView,
  SymbolCheck,
  Usage,
} from "../app/knowledgeView.ts";
import type { RetrievalResult } from "../knowledge/retrieval/retriever.ts";
import type { TreeNode } from "../onboarding/tree.ts";
import { type Html, html, markdownToHtml } from "./html.ts";
import type { Actions } from "./pages.ts";

/**
 * Knowledge in `jarvis ui` (docs/adr/0024-knowledge-in-web-ui.md): what the agents know, as they get it.
 * Read-only pages over the files — documents, standards and skills are written in an editor, by
 * people or models; the page shows them, says how the agents use them and opens the file. The one
 * thing written here is a new glossary term, checked against the code first.
 */
export interface KnowledgeCounts {
  readonly docs: number;
  readonly standards: number;
  readonly skills: number;
  readonly terms: number;
}

export type KnowledgeTab =
  | "overview"
  | "modules"
  | "docs"
  | "architecture"
  | "standards"
  | "skills"
  | "glossary";

export const ARCHITECTURE = ".jarvis/knowledge/architecture.md";

export function knowledgeTabs(current: KnowledgeTab, counts?: KnowledgeCounts): Html {
  const tab = (id: KnowledgeTab, href: string, label: string, count?: number) =>
    html`<a href="${href}"${id === current ? html` aria-current="page"` : ""}>${label}${count !== undefined ? html` <span class="muted">${String(count)}</span>` : ""}</a>`;
  return html`<div class="lede"><h1>Knowledge</h1><span class="muted">what the agents know about this project</span></div>
<nav class="tabs" aria-label="Knowledge">
${tab("overview", "/knowledge", "Overview")}
${tab("modules", "/knowledge/modules", "Modules")}
${tab("docs", "/knowledge/docs", "Documents", counts?.docs)}
${tab("architecture", `/knowledge/docs?doc=${encodeURIComponent(ARCHITECTURE)}`, "Architecture")}
${tab("standards", "/knowledge/standards", "Standards", counts?.standards)}
${tab("skills", "/knowledge/skills", "Skills", counts?.skills)}
${tab("glossary", "/knowledge/glossary", "Glossary", counts?.terms)}
</nav>`;
}

const docHref = (path: string) => `/knowledge/docs?doc=${encodeURIComponent(path)}`;

function form(actions: Actions, action: string, body: Html, attrs: Html | string = ""): Html {
  return html`<form method="post" action="${action}"${attrs}><input type="hidden" name="t" value="${actions.token}">${body}</form>`;
}

/** Open in editor (the file, in the editor `jarvis ui` was told about) and Copy path. */
function fileActions(path: string, back: string, actions?: Actions): Html {
  return html`<div class="row kfile">${
    actions
      ? form(
          actions,
          "/knowledge/open",
          html`<input type="hidden" name="file" value="${path}"><input type="hidden" name="back" value="${back}"><button type="submit" class="btn small strong">Open in editor</button>`,
        )
      : ""
  }<button type="button" class="btn small" data-copy="${path}">Copy path</button></div>`;
}

function usageHtml(u: Usage | undefined, what: string): Html {
  if (!u) return html`<p class="hint">Not in the context of any recent agent call.</p>`;
  return html`<p class="hint">In the context of ${String(u.calls)} agent call${u.calls === 1 ? "" : "s"} over ${String(u.runs)} run${u.runs === 1 ? "" : "s"}${u.asked > 0 ? html`; asked for by name ${String(u.asked)}×` : ""}${u.lastRun ? html` · last <a href="/runs/${encodeURIComponent(u.lastRun)}">run ${u.lastRun}</a>` : ""}. <span class="muted">${what}</span></p>`;
}

const md = (text: string) => markdownToHtml(text.replace(/^<!--[\s\S]*?-->\n?/gm, ""));

/* ---- overview ---- */

export interface OverviewPage {
  readonly counts: KnowledgeCounts;
  readonly docs: readonly DocView[];
  readonly glossaryProblems: number;
  /** Modules and their first folders that have no document of their own. */
  readonly toResearch: readonly TreeNode[];
  readonly candidates: number;
  readonly query?: string;
  readonly result?: RetrievalResult;
  readonly searchError?: string;
}

/** `knowledge:<name>` / `standard:<id>@v` / `skill:<id>@v` → the page that shows it. */
function refHref(ref: string, docs: readonly DocView[]): string | undefined {
  const [kind, rest] = [ref.slice(0, ref.indexOf(":")), ref.slice(ref.indexOf(":") + 1)];
  const id = rest.replace(/[#@].*$/, "");
  if (kind === "knowledge") {
    const d = docs.find((x) => x.name === id || x.path === id);
    return d ? docHref(d.path) : undefined;
  }
  if (kind === "standard") return `/knowledge/standards?id=${encodeURIComponent(id)}`;
  if (kind === "skill") return `/knowledge/skills?id=${encodeURIComponent(id)}`;
  return undefined;
}

function searchHtml(page: OverviewPage): Html {
  const r = page.result;
  return html`<section class="panel ksearch" aria-labelledby="find-h">
<h2 id="find-h">Would an agent find it?</h2>
<p class="hint">The same search the agents use: the query widened by the glossary, every step shown.</p>
<form method="get" action="/knowledge" role="search" class="row"><label class="field grow"><span class="sr">Query</span><input type="search" name="q" value="${page.query ?? ""}" placeholder="маска телефона в форме заказа" maxlength="300"></label><button type="submit" class="btn strong">Search</button></form>
${page.searchError ? html`<div class="banner bad">${page.searchError}</div>` : ""}
${
  r
    ? html`<div class="row kexp"><span class="hint">widened by the glossary:</span>${
        r.expansions.length > 0
          ? r.expansions.map(
              (e) => html`<span class="pill info">${e.term} → ${e.added.slice(0, 6).join(", ")}</span>`,
            )
          : html`<span class="hint">no term matched</span>`
      }<a class="pill wait" href="/knowledge/glossary?add=${encodeURIComponent(page.query ?? "")}#add">add a term</a><span class="hint">· ${r.indexes.join(" + ")}</span></div>
${
  r.evidence.length > 0
    ? html`<ol class="khits">${r.evidence.slice(0, 10).map((e) => {
        const href = refHref(e.ref, page.docs);
        return html`<li><span class="meta">${e.score.toFixed(2)}</span>${href ? html`<a href="${href}"><code>${e.ref}</code></a>` : html`<code>${e.ref}</code>`}<span>${e.title}</span>${e.snippet ? html`<span class="hint">${e.snippet.slice(0, 200)}</span>` : ""}</li>`;
      })}</ol>`
    : html`<p class="hint">Nothing found — an agent asking this would get no project knowledge.</p>`
}`
    : ""
}
</section>`;
}

export function overviewContent(page: OverviewPage, notice?: Html): Html {
  const stale = page.docs.filter((d) => d.staleCommits);
  const generated = page.docs.filter((d) => d.generated);
  const shown = [...page.docs].sort(
    (a, b) =>
      (b.staleCommits ?? 0) - (a.staleCommits ?? 0) ||
      Number(a.source) - Number(b.source) ||
      a.path.localeCompare(b.path),
  );
  return html`${knowledgeTabs("overview", page.counts)}
${notice ?? ""}
${searchHtml(page)}
<div class="cols">
<section class="panel mainc kdocs" aria-labelledby="docs-h">
<div class="row khead"><h2 id="docs-h">Documents</h2><span class="hint">click to read · edit them in your editor</span></div>
<div class="ktable" role="table" aria-label="Knowledge documents">
<div class="kr kh" role="row"><span role="columnheader">Document</span><span role="columnheader">About (paths)</span><span role="columnheader">Used</span><span role="columnheader">Edited</span></div>
${shown.map(
  (d) =>
    html`<a class="kr${d.staleCommits ? " warn" : ""}" role="row" href="${docHref(d.path)}"><span role="cell"><code>${d.path.replace(/^\.jarvis\/knowledge\//, "")}</code>${d.generated ? html` <span class="pill plain">generated</span>` : ""}${d.source ? html` <span class="pill plain">documentation/</span>` : ""}${d.staleCommits ? html` <span class="pill wait">may be stale</span>` : ""}</span><span role="cell" class="meta">${d.paths.length > 0 ? d.paths.slice(0, 2).join(", ") + (d.paths.length > 2 ? ` +${d.paths.length - 2}` : "") : "everywhere"}</span><span role="cell" class="meta">${d.usage ? `${d.usage.runs} run${d.usage.runs === 1 ? "" : "s"}` : "—"}</span><span role="cell" class="meta">${d.edited ?? "not committed"}</span></a>`,
)}
</div>
</section>
<div class="side kside">
<section class="panel kbox" aria-labelledby="stale-h"><h2 id="stale-h">May be stale</h2>
${stale.length === 0 && generated.length === 0 && page.glossaryProblems === 0 ? html`<p class="hint">Nothing points that way.</p>` : ""}
${stale.map((d) => html`<p><a href="${docHref(d.path)}"><code>${d.path.replace(/^\.jarvis\/knowledge\//, "")}</code></a> — ${String(d.staleCommits)} commit${d.staleCommits === 1 ? "" : "s"} under its paths since its last edit</p>`)}
${generated.length > 0 ? html`<p>${String(generated.length)} document${generated.length === 1 ? "" : "s"} generated by jarvis and never taken over by a person</p>` : ""}
${page.glossaryProblems > 0 ? html`<p><a href="/knowledge/glossary?problems=1">glossary</a> — ${String(page.glossaryProblems)} term${page.glossaryProblems === 1 ? "" : "s"} with a problem</p>` : ""}
</section>
<section class="panel kbox" aria-labelledby="res-h"><div class="row"><h2 id="res-h">Modules to research</h2><a class="hint" href="/knowledge/modules?need=1">all</a></div>
${page.candidates > 0 ? html`<p><a href="/knowledge/modules?need=1">${String(page.candidates)} candidate${page.candidates === 1 ? "" : "s"} wait${page.candidates === 1 ? "s" : ""} for review</a></p>` : ""}
${
  page.toResearch.length > 0
    ? page.toResearch.map(
        (n) =>
          html`<p class="row kres"><a href="/knowledge/modules?path=${encodeURIComponent(n.path)}"><code>${n.path}</code></a><span class="hint">${String(n.files)} files${n.tooBig ? " · in parts" : ""}</span></p>`,
      )
    : html`<p class="hint">Every module has a document.</p>`
}
</section>
</div>
</div>`;
}

/* ---- documents ---- */

export interface DocsPage {
  readonly counts: KnowledgeCounts;
  readonly docs: readonly DocView[];
  readonly selected?: DocView;
  readonly path?: string;
  readonly architecture: boolean;
}

function docGroups(docs: readonly DocView[]): Array<{ title: string; docs: DocView[] }> {
  const own = docs.filter((d) => !d.source);
  const arch = own.filter((d) =>
    d.tags.some((t) => t === "architecture" || t === "module" || t === "conventions"),
  );
  const rest = own.filter((d) => !arch.includes(d));
  return [
    { title: "Architecture and modules", docs: arch },
    { title: "Project", docs: rest },
    { title: "documentation/ · read-only", docs: docs.filter((d) => d.source) },
  ].filter((g) => g.docs.length > 0);
}

export function docsContent(page: DocsPage, actions?: Actions, notice?: Html): Html {
  const d = page.selected;
  const back = d ? docHref(d.path) : "/knowledge/docs";
  return html`${knowledgeTabs(page.architecture ? "architecture" : "docs", page.counts)}
${notice ?? ""}
<div class="kdoccols">
<nav class="panel ktree" aria-label="Documents">
${docGroups(page.docs).map(
  (g) =>
    html`<h3>${g.title}</h3><ul>${g.docs.map(
      (x) =>
        html`<li><a href="${docHref(x.path)}"${x.path === d?.path ? html` aria-current="page"` : ""}><span>${x.path.replace(/^\.jarvis\/knowledge\//, "").replace(/^documentation\//, "")}</span>${x.staleCommits ? html`<span class="pill wait">stale</span>` : x.generated ? html`<span class="pill plain">gen</span>` : ""}</a></li>`,
    )}</ul>`,
)}
</nav>
${
  d
    ? html`<article class="panel kdoc" aria-labelledby="doc-h">
<div class="kdochead"><div class="row"><code id="doc-h" class="kpath">${d.path}</code>${d.source ? html`<span class="pill plain">source · read-only</span>` : ""}${d.generated ? html`<span class="pill plain">generated by jarvis</span>` : ""}</div>
<div class="row kchips">${d.tags.length > 0 ? html`<span class="chip">tags: ${d.tags.join(", ")}</span>` : ""}<span class="chip">paths: ${d.paths.length > 0 ? d.paths.join(", ") : "everywhere"}</span>${d.agents.length > 0 ? html`<span class="chip">agents: ${d.agents.join(", ")}</span>` : ""}<span class="chip">edited: ${d.edited ?? "not committed"}</span></div>
${fileActions(d.path, back, actions)}</div>
<div class="doc">${md(d.body)}</div>
</article>
<aside class="kaside" aria-label="How the agents see it">
<section class="panel kbox"><h2>How the index cuts it</h2><p class="hint">${String(d.sections.length)} unit${d.sections.length === 1 ? "" : "s"}, one per section; a search finds a unit, not the whole file.</p>
<ul class="kunits">${d.sections.slice(0, 30).map((s) => html`<li><span>${s.heading}</span><span class="meta">${String(s.chars)} chars</span></li>`)}</ul></section>
<section class="panel kbox"><h2>Who reads it</h2><p>${d.agents.length > 0 ? d.agents.join(", ") : "every agent"}${d.paths.length > 0 ? html` — when the task touches <code>${d.paths.join(", ")}</code>` : " — in every task"}</p>${usageHtml(d.usage, "")}</section>
${d.staleCommits ? html`<section class="panel kbox warn"><h2>May be stale</h2><p>${String(d.staleCommits)} commit${d.staleCommits === 1 ? "" : "s"} under its paths since its last edit (${d.edited ?? "?"}).</p>${d.paths.length > 0 ? html`<p class="hint">Research the module again on <a href="/knowledge/modules">Modules</a>, or update the document in your editor.</p>` : ""}</section>` : ""}
</aside>`
    : html`<p class="empty">${page.path ? html`No document <code>${page.path}</code>.` : "Pick a document."}</p>`
}
</div>`;
}

/* ---- standards ---- */

export interface StandardsPage {
  readonly counts: KnowledgeCounts;
  readonly standards: readonly StandardView[];
  readonly selected?: StandardView;
  readonly severity?: "required" | "recommended";
}

const sevPill = (s: string) => html`<span class="pill ${s === "required" ? "bad" : "wait"}">${s}</span>`;

export function standardsContent(page: StandardsPage, actions?: Actions, notice?: Html): Html {
  const list = page.standards.filter((s) => !page.severity || s.severity === page.severity);
  const s = page.selected;
  const filter = (k: string | undefined, label: string) =>
    html`<a class="btn small${page.severity === k ? " strong" : ""}" href="/knowledge/standards${k ? `?severity=${k}` : ""}"${page.severity === k ? ' aria-current="true"' : ""}>${label}</a>`;
  const check = s?.verification.check;
  return html`${knowledgeTabs("standards", page.counts)}
${notice ?? ""}
<div class="row"><p class="hint grow">Rules the agents follow and the checks enforce. Written in <code>.jarvis/standards/*.md</code> — this page shows them.</p>
${filter(undefined, `All ${page.standards.length}`)}${filter("required", `Required ${page.standards.filter((x) => x.severity === "required").length}`)}${filter("recommended", `Recommended ${page.standards.filter((x) => x.severity === "recommended").length}`)}</div>
<div class="kdoccols kstd">
<nav class="panel klist" aria-label="Standards">
${list.map(
  (x) =>
    html`<a class="kli" href="/knowledge/standards?id=${encodeURIComponent(x.id)}${page.severity ? `&severity=${page.severity}` : ""}"${x.id === s?.id ? html` aria-current="page"` : ""}><span><code>${x.id}</code><span class="hint">${x.title}</span></span><span class="kmeta">${sevPill(x.severity)}<span class="meta">${x.verification.kind}</span>${x.findings.length > 0 ? html`<span class="meta">${String(x.findings.length)} found</span>` : ""}</span></a>`,
)}
${list.length === 0 ? html`<p class="empty">No standards here: <code>.jarvis/standards/</code> is empty.</p>` : ""}
</nav>
${
  s
    ? html`<article class="panel kdoc" aria-labelledby="std-h">
<div class="kdochead"><div class="row"><h2 id="std-h"><code>${s.id}</code></h2>${sevPill(s.severity)}<span class="hint">v${String(s.version)} · ${s.level}</span></div>
<p class="klead">${s.title}</p>
<dl class="mfacts"><dt>checked by</dt><dd>${s.verification.kind === "semantic" ? "review (semantic)" : html`${s.verification.kind}${check?.tool ? html` — <code>${check.tool}</code>` : ""}`}</dd>
${check?.pattern ? html`<dt>pattern</dt><dd><code>${check.pattern.glob}</code>${check.pattern.mustNot ? html` must not: <code>${check.pattern.mustNot}</code>` : ""}${check.pattern.must ? html` must: <code>${check.pattern.must}</code>` : ""} <span class="hint">(${check.pattern.lines} lines)</span></dd>` : ""}
<dt>applies to</dt><dd>${s.scope.paths.length > 0 ? html`<code>${s.scope.paths.join(", ")}</code>` : "everywhere"}${s.scope.stacks.length > 0 ? ` · ${s.scope.stacks.join(", ")}` : ""}</dd>
${s.source ? html`<dt>source</dt><dd>${s.source.kind}: ${s.source.ref}</dd>` : ""}
</dl>
${fileActions(s.path, `/knowledge/standards?id=${encodeURIComponent(s.id)}`, actions)}</div>
<div class="doc">${md(s.rule)}</div>
<section class="kfound"><h3>In recent runs</h3>
${
  s.findings.length > 0
    ? html`<ul>${s.findings.map((f) => html`<li><a href="/runs/${encodeURIComponent(f.run)}"><code>${f.run}</code></a> ${f.file ? html`<code>${f.file}${f.line ? `:${f.line}` : ""}</code>` : ""} — ${f.detail}</li>`)}</ul>`
    : html`<p class="hint">${s.verification.kind === "semantic" ? "Checked by review: its findings are in the reviews, not counted here." : "No violations in the last runs."}</p>`
}
${usageHtml(s.usage, "")}
</section>
</article>`
    : html`<p class="empty">Pick a standard.</p>`
}
</div>`;
}

/* ---- skills ---- */

export interface SkillsPage {
  readonly counts: KnowledgeCounts;
  readonly skills: readonly SkillView[];
  readonly selected?: SkillView;
}

const ORIGIN: Record<SkillView["origin"], [string, string]> = {
  project: ["Project", ".jarvis/skills/<id>/ — skill.yaml + instructions.md"],
  source: ["From documentation/", "read in place; the id is the file name"],
  user: ["Yours", "~/.jarvis/skills"],
  builtin: ["Built-in", "ship with jarvis; a project skill with the same id wins"],
};

export function skillsContent(page: SkillsPage, actions?: Actions, notice?: Html): Html {
  const v = page.selected;
  const groups = (["project", "source", "user", "builtin"] as const)
    .map((o) => ({ o, list: page.skills.filter((s) => s.origin === o) }))
    .filter((g) => g.list.length > 0);
  const key = (s: SkillView) => `${s.skill.id}${s.overridden ? "@builtin" : ""}`;
  const k = v?.skill;
  return html`${knowledgeTabs("skills", page.counts)}
${notice ?? ""}
<p class="hint">How to do one kind of work. An agent call gets the best matching ones in full (<code>context.maxSkills</code>); the rest are listed as available on request.</p>
<div class="kdoccols kstd">
<nav class="panel klist" aria-label="Skills">
${groups.map(
  (g) =>
    html`<h3>${ORIGIN[g.o][0]} <span class="hint">${ORIGIN[g.o][1]}</span></h3>${g.list.map(
      (s) =>
        html`<a class="kli${s.overridden ? " off" : ""}" href="/knowledge/skills?id=${encodeURIComponent(key(s))}"${v && key(v) === key(s) ? html` aria-current="page"` : ""}><span><code>${s.skill.id}</code><span class="hint">${s.skill.title ?? ""}</span></span><span class="kmeta">${s.overridden ? html`<span class="pill plain">overridden</span>` : ""}${s.overrides ? html`<span class="pill info">overrides built-in</span>` : ""}${s.usage ? html`<span class="meta">${String(s.usage.runs)} runs</span>` : ""}</span></a>`,
    )}`,
)}
</nav>
${
  v && k
    ? html`<article class="panel kdoc" aria-labelledby="skill-h">
<div class="kdochead"><div class="row"><h2 id="skill-h"><code>${k.id}</code></h2><span class="pill plain">${ORIGIN[v.origin][0]}</span><span class="hint">v${String(k.version)}</span></div>
${k.title ? html`<p class="klead">${k.title}</p>` : ""}
${v.overridden ? html`<div class="banner info">Replaced by the project skill <code>${k.id}</code>: agents get that one, this one is not used.</div>` : ""}
${v.overrides ? html`<div class="banner info">Replaces the built-in skill with the same id.</div>` : ""}
${v.origin === "source" ? html`<div class="banner info">Read in place from the team's documentation — change it there; jarvis copies nothing.</div>` : ""}
<dl class="mfacts">
<dt>for agents</dt><dd>${k.appliesTo.agents.length > 0 ? k.appliesTo.agents.join(", ") : "implementation"}</dd>
<dt>task kinds</dt><dd>${k.appliesTo.kinds.length > 0 ? k.appliesTo.kinds.join(", ") : "any"}</dd>
<dt>paths</dt><dd>${k.appliesTo.paths.length > 0 ? html`<code>${k.appliesTo.paths.join(", ")}</code>` : "any"}</dd>
${k.appliesTo.stacks.length > 0 ? html`<dt>stacks</dt><dd>${k.appliesTo.stacks.join(", ")}</dd>` : ""}
${k.requiredStandards.length > 0 ? html`<dt>needs standards</dt><dd>${k.requiredStandards.map((s, i) => html`${i > 0 ? ", " : ""}<a href="/knowledge/standards?id=${encodeURIComponent(s)}"><code>${s}</code></a>`)}</dd>` : ""}
${k.verification.length > 0 ? html`<dt>verified by</dt><dd><code>${k.verification.join(", ")}</code></dd>` : ""}
</dl>
${v.path ? fileActions(v.path, `/knowledge/skills?id=${encodeURIComponent(key(v))}`, actions) : ""}</div>
<div class="doc">${md(k.instructions)}</div>
<section class="kfound"><h3>Did it reach the agent?</h3>${v.overridden ? html`<p class="hint">Not used: the project version is picked instead.</p>` : usageHtml(v.usage, "")}</section>
</article>`
    : html`<p class="empty">Pick a skill.</p>`
}
</div>`;
}

/* ---- glossary ---- */

export interface TermForm {
  readonly term: string;
  readonly synonyms: string;
  readonly symbols: string;
  readonly sources: string;
  readonly definition: string;
}

export interface GlossaryPage {
  readonly counts: KnowledgeCounts;
  readonly glossary: GlossaryView;
  readonly selected?: GlossaryRow;
  readonly problems: boolean;
  readonly filter?: string;
  /** The add form: open, its values, and what the symbol check found. */
  readonly form?: TermForm;
  readonly checks?: readonly SymbolCheck[];
  readonly error?: string;
  /** Where the selected term's symbols are in the code. */
  readonly where?: readonly SymbolCheck[];
}

function addFormHtml(page: GlossaryPage, actions: Actions): Html {
  const f = page.form ?? { term: "", synonyms: "", symbols: "", sources: "", definition: "" };
  const missing = (page.checks ?? []).filter((c) => !c.found);
  return html`<details class="panel kadd" id="add"${page.form ? " open" : ""}><summary><b>Add a term</b> <span class="hint">— goes to <code>.jarvis/knowledge/glossary.md</code> as a draft; agents use it from the next run</span></summary>
${form(
  actions,
  "/knowledge/glossary",
  html`<div class="row kfields">
<label class="field">Term<input type="text" name="term" value="${f.term}" required maxlength="80"></label>
<label class="field grow">Synonyms <span class="hint">comma-separated, how people say it</span><input type="text" name="synonyms" value="${f.synonyms}" maxlength="400"></label>
<label class="field">Source <span class="hint">optional</span><input type="text" name="sources" value="${f.sources}" maxlength="200"></label>
</div>
<div class="row kfields">
<label class="field grow">Symbols and modules <span class="hint">what it is called in the code</span><input type="text" name="symbols" value="${f.symbols}" maxlength="400" class="mono"></label>
<label class="field grow">Definition <span class="hint">one or two sentences, in the project's language</span><textarea name="definition" rows="2" maxlength="600">${f.definition}</textarea></label>
</div>
${
  page.checks && page.checks.length > 0
    ? html`<ul class="kchecks">${page.checks.map((c) => html`<li class="${c.found ? "ok" : "warn"}"><span aria-hidden="true">${c.found ? "✓" : "?"}</span> <code>${c.symbol}</code> — ${c.found ? c.where : "not in the code"}</li>`)}</ul>`
    : ""
}
${page.error ? html`<div class="banner bad">${page.error}</div>` : ""}
<div class="row"><button type="submit" name="do" value="check" class="btn">Check in the code</button>
<button type="submit" name="do" value="${missing.length > 0 ? "add-anyway" : "add"}" class="btn primary">${missing.length > 0 ? "Add anyway" : "Add to the glossary"}</button>
${missing.length > 0 ? html`<span class="hint">${String(missing.length)} symbol${missing.length === 1 ? "" : "s"} not found — fix the spelling, or add as it is</span>` : ""}</div>`,
)}
</details>`;
}

export function glossaryContent(page: GlossaryPage, actions?: Actions, notice?: Html): Html {
  const q = page.filter?.toLowerCase();
  const rows = page.glossary.rows.filter(
    (r) =>
      (!page.problems || r.problems.length > 0) &&
      (!q ||
        [r.term, ...r.synonyms, ...r.symbols, r.definition ?? ""].some((x) => x.toLowerCase().includes(q))),
  );
  const withProblems = page.glossary.rows.filter((r) => r.problems.length > 0).length;
  const s = page.selected;
  const href = (extra: Record<string, string>) => {
    const p = new URLSearchParams({
      ...(page.problems ? { problems: "1" } : {}),
      ...(page.filter ? { q: page.filter } : {}),
      ...extra,
    });
    return `/knowledge/glossary${p.size > 0 ? `?${p}` : ""}`;
  };
  return html`${knowledgeTabs("glossary", page.counts)}
${notice ?? ""}
<p class="hint">Business term → synonyms → code symbols. Every search an agent makes is widened by it; <code>jarvis ask &lt;term&gt;</code> answers from it. Existing terms are changed in the file; here you add new ones.</p>
${actions ? addFormHtml(page, actions) : ""}
<form method="get" action="/knowledge/glossary" class="row kfilter" role="search"><label class="field grow"><span class="sr">Filter</span><input type="search" name="q" value="${page.filter ?? ""}" placeholder="Filter terms, synonyms, symbols…"></label>${page.problems ? html`<input type="hidden" name="problems" value="1">` : ""}<button type="submit" class="btn">Filter</button>
<a class="btn${page.problems ? " strong" : ""}" href="${page.problems ? "/knowledge/glossary" : "/knowledge/glossary?problems=1"}">${page.problems ? "All terms" : `Problems only (${withProblems})`}</a>${actions ? fileActions(".jarvis/knowledge/glossary.md", "/knowledge/glossary", actions) : ""}</form>
<div class="cols">
<section class="panel mainc kgloss" aria-label="Terms">
${
  !page.glossary.exists
    ? html`<p class="empty">No glossary yet: the first term you add creates <code>.jarvis/knowledge/glossary.md</code>.</p>`
    : html`<div class="ktable" role="table" aria-label="Glossary">
<div class="kr kh kg" role="row"><span role="columnheader">Term</span><span role="columnheader">Synonyms</span><span role="columnheader">Symbols / modules</span><span role="columnheader">Definition</span></div>
${rows.map(
  (r) =>
    html`<a class="kr kg${r.problems.length > 0 ? " warn" : ""}${r.term === s?.term ? " current" : ""}" role="row" href="${href({ term: r.term })}"><span role="cell"><b>${r.term}</b>${r.updated ? html`<span class="meta">${r.updated}</span>` : ""}</span><span role="cell">${r.synonyms.join(", ")}</span><span role="cell" class="meta">${r.symbols.join(", ")}${r.problems.map((p) => html`<span class="kprob">${p}</span>`)}</span><span role="cell" class="hint">${r.definition ?? ""}</span></a>`,
)}
${rows.length === 0 ? html`<p class="empty">No term matches.</p>` : ""}
</div>`
}
</section>
<aside class="side kside" aria-label="Where it is used">
${
  s
    ? html`<section class="panel kbox"><span class="hint">selected term</span><h2>${s.term}</h2>
<p class="hint">a query with it also searches for</p><p class="mono">${[...s.synonyms, ...s.symbols].join(" · ") || "—"}</p>
${
  page.where && page.where.length > 0
    ? html`<p class="hint">in the code</p><ul class="kchecks">${page.where.map((c) => html`<li class="${c.found ? "ok" : "warn"}"><span aria-hidden="true">${c.found ? "✓" : "?"}</span> <code>${c.symbol}</code> — ${c.found ? c.where : "not in the code"}</li>`)}</ul>`
    : ""
}
${s.sources.length > 0 ? html`<p class="hint">sources: ${s.sources.join(", ")}</p>` : ""}
${s.problems.map((p) => html`<div class="banner bad">${p}</div>`)}
</section>`
    : html`<section class="panel kbox"><p class="hint">Pick a term to see what a query with it becomes and where its symbols are.</p></section>`
}
</aside>
</div>`;
}

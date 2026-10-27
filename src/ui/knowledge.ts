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
import { plural, t, th } from "./i18n.ts";
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
  /** Open candidates other than module maps (those are decided on Modules). */
  readonly candidates?: number;
  /** Services of the knowledge repository's map; the tab shows only with one. */
  readonly services?: number;
}

export type KnowledgeTab =
  | "overview"
  | "services"
  | "ask"
  | "modules"
  | "docs"
  | "architecture"
  | "standards"
  | "skills"
  | "glossary"
  | "candidates";

/** The architecture document, by name: `.jarvis/knowledge/`, or a service's folder of the knowledge repository. */
export const ARCHITECTURE = "architecture.md";
// the tabs' labels: t("Overview") t("Services") t("Ask") t("Modules") t("Documents") t("Architecture") t("Standards") t("Skills") t("Glossary") t("Candidates")

export function knowledgeTabs(current: KnowledgeTab, counts?: KnowledgeCounts): Html {
  const tab = (id: KnowledgeTab, href: string, label: string, count?: number) =>
    html`<a href="${href}"${id === current ? html` aria-current="page"` : ""}>${t(label)}${count !== undefined ? html` <span class="muted">${String(count)}</span>` : ""}</a>`;
  return html`<div class="lede"><h1>${t("Knowledge")}</h1><span class="muted">${t("what the agents know about this project")}</span></div>
<nav class="tabs" aria-label="${t("Knowledge")}">
${tab("overview", "/knowledge", "Overview")}
${counts?.services !== undefined ? tab("services", "/knowledge/services", "Services", counts.services) : ""}
${tab("ask", "/knowledge/ask", "Ask")}
${tab("modules", "/knowledge/modules", "Modules")}
${tab("docs", "/knowledge/docs", "Documents", counts?.docs)}
${tab("architecture", `/knowledge/docs?doc=${encodeURIComponent(ARCHITECTURE)}`, "Architecture")}
${tab("standards", "/knowledge/standards", "Standards", counts?.standards)}
${tab("skills", "/knowledge/skills", "Skills", counts?.skills)}
${tab("glossary", "/knowledge/glossary", "Glossary", counts?.terms)}
${tab("candidates", "/knowledge/candidates", "Candidates", counts?.candidates)}
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
          html`<input type="hidden" name="file" value="${path}"><input type="hidden" name="back" value="${back}"><button type="submit" class="btn small strong">${t("Open in editor")}</button>`,
        )
      : ""
  }<button type="button" class="btn small" data-copy="${path}">${t("Copy path")}</button></div>`;
}

function usageHtml(u: Usage | undefined, what: string): Html {
  if (!u) return html`<p class="hint">${t("Not in the context of any recent agent call.")}</p>`;
  return html`<p class="hint">${t("In the context of {calls} over {runs}", { calls: plural(u.calls, "agent call"), runs: plural(u.runs, "run") })}${u.asked > 0 ? html`; ${t("asked for by name {n}×", { n: u.asked })}` : ""}${u.lastRun ? html` · ${t("last")} <a href="/runs/${encodeURIComponent(u.lastRun)}">run ${u.lastRun}</a>` : ""}. <span class="muted">${what}</span></p>`;
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
  /** Open candidates that are not module maps (by hand, from review): decided in a terminal. */
  readonly proposed?: number;
  /** The skills a skill improvement may name. */
  readonly skills?: readonly string[];
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
<h2 id="find-h">${t("Would an agent find it?")}</h2>
<p class="hint">${t("The same search the agents use: the query widened by the glossary, every step shown.")}</p>
<form method="get" action="/knowledge" role="search" class="row"><label class="field grow"><span class="sr">${t("Query")}</span><input type="search" name="q" value="${page.query ?? ""}" placeholder="маска телефона в форме заказа" maxlength="300"></label><button type="submit" class="btn strong">${t("Search")}</button></form>
${page.searchError ? html`<div class="banner bad">${page.searchError}</div>` : ""}
${
  r
    ? html`<div class="row kexp"><span class="hint">${t("widened by the glossary:")}</span>${
        r.expansions.length > 0
          ? r.expansions.map(
              (e) => html`<span class="pill info">${e.term} → ${e.added.slice(0, 6).join(", ")}</span>`,
            )
          : html`<span class="hint">${t("no term matched")}</span>`
      }<a class="pill wait" href="/knowledge/glossary?add=${encodeURIComponent(page.query ?? "")}#add">${t("add a term")}</a><span class="hint">· ${r.indexes.join(" + ")}</span></div>
${
  r.evidence.length > 0
    ? html`<ol class="khits">${r.evidence.slice(0, 10).map((e) => {
        const href = refHref(e.ref, page.docs);
        return html`<li><span class="meta">${e.score.toFixed(2)}</span>${href ? html`<a href="${href}"><code>${e.ref}</code></a>` : html`<code>${e.ref}</code>`}<span>${e.title}</span>${e.snippet ? html`<span class="hint">${e.snippet.slice(0, 200)}</span>` : ""}</li>`;
      })}</ol>`
    : html`<p class="hint">${t("Nothing found — an agent asking this would get no project knowledge.")}</p>`
}`
    : ""
}
</section>`;
}

/**
 * «Propose a candidate» (ADR-0020 §6): what `jarvis candidates add` does, from the page. The candidate
 * waits like one review proposed; promote and reject stay in the terminal.
 */
function proposeHtml(page: OverviewPage, actions: Actions): Html {
  const kinds: Array<[string, string]> = [
    ["standard", t("standard — a rule to follow")],
    ["knowledge", t("knowledge — what is true about the project")],
    ["skill-improvement", t("skill improvement — a step to add to a skill")],
  ];
  return html`<details class="panel kadd" id="propose"><summary><b>${t("Propose a candidate")}</b> <span class="hint">— ${th("waits with the ones review proposed: {cmd}", { cmd: html`<code>jarvis candidates list</code>` })}</span></summary>
${form(
  actions,
  "/knowledge/candidates/add",
  html`<div class="row kfields">
<label class="field">${t("Kind")}<select name="kind">${kinds.map(([v, label]) => html`<option value="${v}">${label}</option>`)}</select></label>
<label class="field">${t("Skill")} <span class="hint">${t("for a skill improvement")}</span><select name="skill"><option value="">—</option>${(page.skills ?? []).map((id) => html`<option value="${id}">${id}</option>`)}</select></label>
<label class="field grow">${t("Title")}<input type="text" name="title" required maxlength="120"></label>
</div>
<label class="field">${t("Text")} <span class="hint">${t("the rule, the knowledge, or the step — as it should be written")}</span><textarea name="text" rows="4" required maxlength="8000"></textarea></label>
<div class="row kfields">
<label class="field grow">${t("Paths")} <span class="hint">${t("optional, comma-separated globs it applies to")}</span><input type="text" name="paths" maxlength="400" class="mono"></label>
<label class="field grow">${t("Evidence")} <span class="hint">${t("optional, comma-separated: path:line, a run, a link")}</span><input type="text" name="evidence" maxlength="800" class="mono"></label>
</div>
<div class="row"><button type="submit" class="btn strong">${t("Propose")}</button>${page.proposed ? html`<span class="hint">${t("{n} open besides module maps", { n: page.proposed })}</span>` : ""}</div>`,
)}
</details>`;
}

export function overviewContent(page: OverviewPage, notice?: Html, actions?: Actions): Html {
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
<div class="row khead"><h2 id="docs-h">${t("Documents")}</h2><span class="hint">${t("click to read · edit them in your editor")}</span></div>
<div class="ktable" role="table" aria-label="${t("Knowledge documents")}">
<div class="kr kh" role="row"><span role="columnheader">${t("Document")}</span><span role="columnheader">${t("About (paths)")}</span><span role="columnheader">${t("Used")}</span><span role="columnheader">${t("Edited")}</span></div>
${shown.length === 0 ? html`<p class="hint kempty">${t("No documents here yet. In a knowledge repository a service's documents are under Modules, by its folders.")}</p>` : ""}
${shown.map(
  (d) =>
    html`<a class="kr${d.staleCommits ? " warn" : ""}" role="row" href="${docHref(d.path)}"><span role="cell"><code>${d.path.replace(/^\.jarvis\/knowledge\//, "")}</code>${d.generated ? html` <span class="pill plain">${t("generated")}</span>` : ""}${d.source ? html` <span class="pill plain">documentation/</span>` : ""}${d.staleCommits ? html` <span class="pill wait">${t("may be stale")}</span>` : ""}</span><span role="cell" class="meta">${d.paths.length > 0 ? d.paths.slice(0, 2).join(", ") + (d.paths.length > 2 ? ` +${d.paths.length - 2}` : "") : t("everywhere")}</span><span role="cell" class="meta">${d.usage ? plural(d.usage.runs, "run") : "—"}</span><span role="cell" class="meta">${d.edited ?? t("not committed")}</span></a>`,
)}
</div>
</section>
<div class="side kside">
<section class="panel kbox" aria-labelledby="stale-h"><h2 id="stale-h">${t("May be stale")}</h2>
${stale.length === 0 && generated.length === 0 && page.glossaryProblems === 0 ? html`<p class="hint">${t("Nothing points that way.")}</p>` : ""}
${stale.map((d) => html`<p><a href="${docHref(d.path)}"><code>${d.path.replace(/^\.jarvis\/knowledge\//, "")}</code></a> — ${t("{n} under its paths since its last edit", { n: plural(d.staleCommits ?? 0, "commit") })}</p>`)}
${generated.length > 0 ? html`<p>${t("{n} generated by jarvis and never taken over by a person", { n: plural(generated.length, "document") })}</p>` : ""}
${page.glossaryProblems > 0 ? html`<p><a href="/knowledge/glossary?problems=1">${t("glossary")}</a> — ${t("{n} with a problem", { n: plural(page.glossaryProblems, "term") })}</p>` : ""}
</section>
<section class="panel kbox" aria-labelledby="res-h"><div class="row"><h2 id="res-h">${t("Modules to research")}</h2><a class="hint" href="/knowledge/modules?need=1">${t("all")}</a></div>
${page.candidates > 0 ? html`<p><a href="/knowledge/modules?need=1">${plural(page.candidates, "candidate waits for review", "candidates wait for review")}</a></p>` : ""}
${
  page.toResearch.length > 0
    ? page.toResearch.map(
        (n) =>
          html`<p class="row kres"><a href="/knowledge/modules?path=${encodeURIComponent(n.path)}"><code>${n.path}</code></a><span class="hint">${plural(n.files, "file")}${n.tooBig ? ` · ${t("in parts")}` : ""}</span></p>`,
      )
    : html`<p class="hint">${t("Every module has a document.")}</p>`
}
</section>
</div>
</div>
${actions ? proposeHtml(page, actions) : ""}`;
}

/* ---- documents ---- */

export interface DocsPage {
  readonly counts: KnowledgeCounts;
  readonly docs: readonly DocView[];
  readonly selected?: DocView;
  readonly path?: string;
  readonly architecture: boolean;
}

/**
 * A folder of a side list (Documents, Standards, Skills, Candidates): a header that does not look like
 * its items — a caret, the name, a count — folded or unfolded. Open: the one with the selected item,
 * and all of them when there are few (pilot: 38 services' documents in one long list, the folder names
 * set like the files).
 */
function navGroup(title: Html | string, count: number, open: boolean, body: Html, hint?: string): Html {
  return html`<details class="kgrp"${open ? " open" : ""}><summary><span class="kgname">${title}</span>${hint ? html`<span class="hint kghint">${hint}</span>` : ""}<span class="kcount">${String(count)}</span></summary><div class="kgbody">${body}</div></details>`;
}

/** Few folders are all open; many — only the one with the selected item. */
const openGroup = (groups: number, hasSelected: boolean) => groups <= 4 || hasSelected;

function docGroups(docs: readonly DocView[]): Array<{ title: string; docs: DocView[] }> {
  const services = [...new Set(docs.flatMap((d) => (d.service ? [d.service] : [])))].sort();
  const own = docs.filter((d) => !d.source && !d.service);
  const arch = own.filter((d) =>
    d.tags.some((t) => t === "architecture" || t === "module" || t === "conventions"),
  );
  const rest = own.filter((d) => !arch.includes(d));
  return [
    { title: t("Architecture and modules"), docs: arch },
    { title: t("Project"), docs: rest },
    { title: "documentation/ · read-only", docs: docs.filter((d) => d.source) },
    // the knowledge repository itself: each service's documents under its name
    ...services.map((name) => ({ title: name, docs: docs.filter((d) => d.service === name) })),
  ].filter((g) => g.docs.length > 0);
}

/** A document's name in a list: its path without the folder the group already says. */
const docLabel = (x: DocView) =>
  x.service
    ? x.path.replace(new RegExp(`^.*?services/${x.service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`), "")
    : x.path.replace(/^\.jarvis\/knowledge\//, "").replace(/^documentation\//, "");

export function docsContent(page: DocsPage, actions?: Actions, notice?: Html): Html {
  const d = page.selected;
  const back = d ? docHref(d.path) : "/knowledge/docs";
  return html`${knowledgeTabs(page.architecture ? "architecture" : "docs", page.counts)}
${notice ?? ""}
<div class="kdoccols">
<nav class="panel ktree" aria-label="${t("Documents")}">
${(() => {
  const groups = docGroups(page.docs);
  const item = (x: DocView) =>
    html`<li><a href="${docHref(x.path)}"${x.path === d?.path ? html` aria-current="page"` : ""}><span>${docLabel(x).replace(/^module-/, "")}</span>${x.staleCommits ? html`<span class="pill wait">${t("stale")}</span>` : x.generated ? html`<span class="pill plain">${t("gen")}</span>` : ""}</a></li>`;
  return groups.map((g) => {
    // a service's module maps fold into their own folder
    const modules = g.docs.filter((x) => /(^|\/)module-[^/]*$/.test(docLabel(x)));
    const rest = g.docs.filter((x) => !modules.includes(x));
    const body = html`<ul>${rest.map(item)}</ul>${
      modules.length > 0 && rest.length > 0
        ? navGroup(
            t("modules"),
            modules.length,
            modules.some((x) => x.path === d?.path) || modules.length <= 6,
            html`<ul>${modules.map(item)}</ul>`,
          )
        : modules.length > 0
          ? html`<ul>${modules.map(item)}</ul>`
          : ""
    }`;
    return navGroup(
      g.title,
      g.docs.length,
      openGroup(
        groups.length,
        g.docs.some((x) => x.path === d?.path),
      ),
      body,
    );
  });
})()}
</nav>
${
  d
    ? html`<article class="panel kdoc" aria-labelledby="doc-h">
<div class="kdochead"><div class="row"><code id="doc-h" class="kpath">${d.path}</code>${d.source ? html`<span class="pill plain">${t("source · read-only")}</span>` : ""}${d.generated ? html`<span class="pill plain">${t("generated by jarvis")}</span>` : ""}</div>
<div class="row kchips">${d.tags.length > 0 ? html`<span class="chip">${t("tags:")} ${d.tags.join(", ")}</span>` : ""}<span class="chip">${t("paths:")} ${d.paths.length > 0 ? d.paths.join(", ") : t("everywhere")}</span>${d.agents.length > 0 ? html`<span class="chip">${t("agents:")} ${d.agents.join(", ")}</span>` : ""}<span class="chip">${t("edited:")} ${d.edited ?? t("not committed")}</span></div>
${fileActions(d.path, back, actions)}</div>
<div class="doc">${md(d.body)}</div>
</article>
<aside class="kaside" aria-label="${t("How the agents see it")}">
<section class="panel kbox"><h2>${t("How the index cuts it")}</h2><p class="hint">${t("{n}, one per section; a search finds a unit, not the whole file.", { n: plural(d.sections.length, "unit") })}</p>
<ul class="kunits">${d.sections.slice(0, 30).map((s) => html`<li><span>${s.heading}</span><span class="meta">${t("{n} chars", { n: s.chars })}</span></li>`)}</ul></section>
<section class="panel kbox"><h2>${t("Who reads it")}</h2><p>${d.agents.length > 0 ? d.agents.join(", ") : t("every agent")}${d.paths.length > 0 ? html` — ${t("when the task touches")} <code>${d.paths.join(", ")}</code>` : ` — ${t("in every task")}`}</p>${usageHtml(d.usage, "")}</section>
${d.staleCommits ? html`<section class="panel kbox warn"><h2>${t("May be stale")}</h2><p>${t("{n} under its paths since its last edit", { n: plural(d.staleCommits ?? 0, "commit") })} (${d.edited ?? "?"}).</p>${d.paths.length > 0 ? html`<p class="hint">${th("Research the module again on {modules}, or update the document in your editor.", { modules: html`<a href="/knowledge/modules">${t("Modules")}</a>` })}</p>` : ""}</section>` : ""}
</aside>`
    : html`<p class="empty">${page.path ? th("No document {path}.", { path: html`<code>${page.path}</code>` }) : t("Pick a document.")}</p>`
}
</div>`;
}

/* ---- standards ---- */

/**
 * Standards and skills by stack (pilot: a knowledge repository's backend and frontend rules in one
 * list): by the folder they lie in (`java/`, `frontend/`), else by the stacks they name, else for every
 * stack; the stacks a group is for beside its name.
 */
export function byStack<T>(
  items: readonly T[],
  of: (x: T) => { group?: string | undefined; stacks: readonly string[] },
): Array<{ title: string; stacks?: string; items: T[] }> {
  const groups = new Map<string, { title: string; stacks?: string; items: T[] }>();
  for (const x of items) {
    const { group, stacks } = of(x);
    const folder = group?.split("/")[0];
    const named = stacks.length > 0 ? stacks.join(", ") : undefined;
    const key = folder ? `1${folder}` : named ? `2${named}` : "3";
    const title = folder ? `${folder}/` : (named ?? t("Every stack"));
    const g = groups.get(key) ?? { title, ...(folder && named ? { stacks: named } : {}), items: [] };
    g.items.push(x);
    groups.set(key, g);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g);
}

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
<div class="row"><p class="hint grow">${th("Rules the agents follow and the checks enforce. Written in {files} — this page shows them.", { files: html`<code>.jarvis/standards/*.md</code>` })}</p>
${filter(undefined, `All ${page.standards.length}`)}${filter("required", `Required ${page.standards.filter((x) => x.severity === "required").length}`)}${filter("recommended", `Recommended ${page.standards.filter((x) => x.severity === "recommended").length}`)}</div>
<div class="kdoccols kstd">
<nav class="panel klist" aria-label="${t("Standards")}">
${byStack(list, (x) => ({ group: x.group, stacks: x.scope.stacks })).map((g, _i, all) =>
  navGroup(
    g.title,
    g.items.length,
    openGroup(
      all.length,
      g.items.some((x) => x.id === s?.id),
    ),
    html`${g.items.map(
      (x) =>
        html`<a class="kli" href="/knowledge/standards?id=${encodeURIComponent(x.id)}${page.severity ? `&severity=${page.severity}` : ""}"${x.id === s?.id ? html` aria-current="page"` : ""}><span><code>${x.id}</code><span class="hint">${x.title}</span></span><span class="kmeta">${sevPill(x.severity)}<span class="meta">${x.verification.kind}</span>${x.findings.length > 0 ? html`<span class="meta">${t("{n} found", { n: x.findings.length })}</span>` : ""}</span></a>`,
    )}`,
    g.stacks,
  ),
)}
${list.length === 0 ? html`<p class="empty">${th("No standards here: {dir} is empty.", { dir: html`<code>.jarvis/standards/</code>` })}</p>` : ""}
</nav>
${
  s
    ? html`<article class="panel kdoc" aria-labelledby="std-h">
<div class="kdochead"><div class="row"><h2 id="std-h"><code>${s.id}</code></h2>${sevPill(s.severity)}<span class="hint">v${String(s.version)} · ${s.level}</span></div>
<p class="klead">${s.title}</p>
<dl class="mfacts"><dt>${t("checked by")}</dt><dd>${s.verification.kind === "semantic" ? t("review (semantic)") : html`${s.verification.kind}${check?.tool ? html` — <code>${check.tool}</code>` : ""}`}</dd>
${check?.pattern ? html`<dt>${t("pattern")}</dt><dd><code>${check.pattern.glob}</code>${check.pattern.mustNot ? html` ${t("must not:")} <code>${check.pattern.mustNot}</code>` : ""}${check.pattern.must ? html` ${t("must:")} <code>${check.pattern.must}</code>` : ""} <span class="hint">(${t("{n} lines", { n: check.pattern.lines })})</span></dd>` : ""}
<dt>${t("applies to")}</dt><dd>${s.scope.paths.length > 0 ? html`<code>${s.scope.paths.join(", ")}</code>` : t("everywhere")}${s.scope.stacks.length > 0 ? ` · ${s.scope.stacks.join(", ")}` : ""}</dd>
${s.source ? html`<dt>${t("source")}</dt><dd>${s.source.kind}: ${s.source.ref}</dd>` : ""}
</dl>
${fileActions(s.path, `/knowledge/standards?id=${encodeURIComponent(s.id)}`, actions)}</div>
<div class="doc">${md(s.rule)}</div>
<section class="kfound"><h3>${t("In recent runs")}</h3>
${
  s.findings.length > 0
    ? html`<ul>${s.findings.map((f) => html`<li><a href="/runs/${encodeURIComponent(f.run)}"><code>${f.run}</code></a> ${f.file ? html`<code>${f.file}${f.line ? `:${f.line}` : ""}</code>` : ""} — ${f.detail}</li>`)}</ul>`
    : html`<p class="hint">${s.verification.kind === "semantic" ? t("Checked by review: its findings are in the reviews, not counted here.") : t("No violations in the last runs.")}</p>`
}
${usageHtml(s.usage, "")}
</section>
</article>`
    : html`<p class="empty">${t("Pick a standard.")}</p>`
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
  // t("Project") t("From documentation/") t("read in place; the id is the file name") t("Yours") t("Built-in") t("ship with jarvis; a project skill with the same id wins")
  project: [
    "Project",
    ".jarvis/skills/<id>/ — skill.yaml + instructions.md; .agents/skills, .claude/skills — SKILL.md",
  ],
  source: ["From documentation/", "read in place; the id is the file name"],
  user: ["Yours", "~/.jarvis/skills, ~/.agents/skills, ~/.claude/skills"],
  builtin: ["Built-in", "ship with jarvis; a project skill with the same id wins"],
};

export function skillsContent(page: SkillsPage, actions?: Actions, notice?: Html): Html {
  const v = page.selected;
  // by stack, as the folders say; the built-ins apart
  const groups = [
    ...byStack(
      page.skills.filter((x) => x.origin !== "builtin"),
      (x) => ({ group: x.skill.group, stacks: x.skill.appliesTo.stacks }),
    ),
    {
      title: t("Built-in"),
      stacks: t("ship with jarvis; a project skill with the same id wins"),
      items: page.skills.filter((x) => x.origin === "builtin"),
    },
  ].filter((g) => g.items.length > 0);
  const key = (s: SkillView) => `${s.skill.id}${s.overridden ? "@builtin" : ""}`;
  const k = v?.skill;
  return html`${knowledgeTabs("skills", page.counts)}
${notice ?? ""}
<p class="hint">${th("How to do one kind of work. An agent call gets the best matching ones in full ({setting}); the rest are listed as available on request.", { setting: html`<code>context.maxSkills</code>` })}</p>
<div class="kdoccols kstd">
<nav class="panel klist" aria-label="${t("Skills")}">
${groups.map((g) =>
  navGroup(
    g.title,
    g.items.length,
    openGroup(
      groups.length,
      g.items.some((x) => v !== undefined && key(x) === key(v)),
    ),
    html`${g.items.map(
      (s) =>
        html`<a class="kli${s.overridden ? " off" : ""}" href="/knowledge/skills?id=${encodeURIComponent(key(s))}"${v && key(v) === key(s) ? html` aria-current="page"` : ""}><span><code>${s.skill.id}</code><span class="hint">${s.skill.title ?? ""}</span></span><span class="kmeta">${s.origin === "source" || s.origin === "user" ? html`<span class="pill plain" title="${t(ORIGIN[s.origin][1])}">${t(ORIGIN[s.origin][0])}</span>` : ""}${s.overridden ? html`<span class="pill plain">${t("overridden")}</span>` : ""}${s.overrides ? html`<span class="pill info">${t("overrides built-in")}</span>` : ""}${s.usage ? html`<span class="meta">${plural(s.usage.runs, "run")}</span>` : ""}</span></a>`,
    )}`,
    g.stacks,
  ),
)}
</nav>
${
  v && k
    ? html`<article class="panel kdoc" aria-labelledby="skill-h">
<div class="kdochead"><div class="row"><h2 id="skill-h"><code>${k.id}</code></h2><span class="pill plain">${t(ORIGIN[v.origin][0])}</span><span class="hint">v${String(k.version)}</span>${k.format === "agent-skills" ? html`<span class="pill plain" title="${t("Agent Skills format, shared with other agents")}">SKILL.md</span>` : ""}</div>
${k.title ? html`<p class="klead">${k.title}</p>` : ""}
${k.description && k.description !== k.title ? html`<p class="hint">${k.description}</p>` : ""}
${k.catalogOnly ? html`<div class="banner info">${t("Says nothing about where it applies, so it is never picked by itself: every agent sees it in the list of other skills and reads it when it fits; a workflow step can name it.")}</div>` : ""}
${v.overridden ? html`<div class="banner info">${th("Replaced by the project skill {id}: agents get that one, this one is not used.", { id: html`<code>${k.id}</code>` })}</div>` : ""}
${v.overrides ? html`<div class="banner info">${t("Replaces the built-in skill with the same id.")}</div>` : ""}
${v.origin === "source" ? html`<div class="banner info">${t("Read in place from the team's documentation — change it there; jarvis copies nothing.")}</div>` : ""}
<dl class="mfacts">
<dt>${t("for agents")}</dt><dd>${k.appliesTo.agents.length > 0 ? k.appliesTo.agents.join(", ") : "implementation"}</dd>
<dt>${t("task kinds")}</dt><dd>${k.appliesTo.kinds.length > 0 ? k.appliesTo.kinds.join(", ") : t("any")}</dd>
<dt>${t("paths")}</dt><dd>${k.appliesTo.paths.length > 0 ? html`<code>${k.appliesTo.paths.join(", ")}</code>` : t("any")}</dd>
${k.appliesTo.stacks.length > 0 ? html`<dt>${t("stacks")}</dt><dd>${k.appliesTo.stacks.join(", ")}</dd>` : ""}
${k.requiredStandards.length > 0 ? html`<dt>${t("needs standards")}</dt><dd>${k.requiredStandards.map((s, i) => html`${i > 0 ? ", " : ""}<a href="/knowledge/standards?id=${encodeURIComponent(s)}"><code>${s}</code></a>`)}</dd>` : ""}
${k.verification.length > 0 ? html`<dt>${t("verified by")}</dt><dd><code>${k.verification.join(", ")}</code></dd>` : ""}
</dl>
${v.path ? fileActions(v.path, `/knowledge/skills?id=${encodeURIComponent(key(v))}`, actions) : ""}</div>
<div class="doc">${md(k.instructions)}</div>
<section class="kfound"><h3>${t("Did it reach the agent?")}</h3>${v.overridden ? html`<p class="hint">${t("Not used: the project version is picked instead.")}</p>` : usageHtml(v.usage, "")}</section>
</article>`
    : html`<p class="empty">${t("Pick a skill.")}</p>`
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
  return html`<details class="panel kadd" id="add"${page.form ? " open" : ""}><summary><b>${t("Add a term")}</b> <span class="hint">— ${th("goes to {file} as a draft; agents use it from the next run", { file: html`<code>.jarvis/knowledge/glossary.md</code>` })}</span></summary>
${form(
  actions,
  "/knowledge/glossary",
  html`<div class="row kfields">
<label class="field">${t("Term")}<input type="text" name="term" value="${f.term}" required maxlength="80"></label>
<label class="field grow">${t("Synonyms")} <span class="hint">${t("comma-separated, how people say it")}</span><input type="text" name="synonyms" value="${f.synonyms}" maxlength="400"></label>
<label class="field">${t("Source")} <span class="hint">${t("optional")}</span><input type="text" name="sources" value="${f.sources}" maxlength="200"></label>
</div>
<div class="row kfields">
<label class="field grow">${t("Symbols and modules")} <span class="hint">${t("what it is called in the code")}</span><input type="text" name="symbols" value="${f.symbols}" maxlength="400" class="mono"></label>
<label class="field grow">${t("Definition")} <span class="hint">${t("one or two sentences, in the project's language")}</span><textarea name="definition" rows="2" maxlength="600">${f.definition}</textarea></label>
</div>
${
  page.checks && page.checks.length > 0
    ? html`<ul class="kchecks">${page.checks.map((c) => html`<li class="${c.found ? "ok" : "warn"}"><span aria-hidden="true">${c.found ? "✓" : "?"}</span> <code>${c.symbol}</code> — ${c.found ? c.where : t("not in the code")}</li>`)}</ul>`
    : ""
}
${page.error ? html`<div class="banner bad">${page.error}</div>` : ""}
<div class="row"><button type="submit" name="do" value="check" class="btn">${t("Check in the code")}</button>
<button type="submit" name="do" value="${missing.length > 0 ? "add-anyway" : "add"}" class="btn primary">${missing.length > 0 ? t("Add anyway") : t("Add to the glossary")}</button>
${missing.length > 0 ? html`<span class="hint">${t("{n} not found — fix the spelling, or add as it is", { n: plural(missing.length, "symbol") })}</span>` : ""}</div>`,
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
<p class="hint">${th("Business term → synonyms → code symbols. Every search an agent makes is widened by it; Ask (or {cmd}) answers from it. Existing terms are changed in the file; here you add new ones.", { cmd: html`<code>jarvis ask &lt;term&gt;</code>` })}</p>
${actions ? addFormHtml(page, actions) : ""}
<form method="get" action="/knowledge/glossary" class="row kfilter" role="search"><label class="field grow"><span class="sr">${t("Filter")}</span><input type="search" name="q" value="${page.filter ?? ""}" placeholder="${t("Filter terms, synonyms, symbols…")}"></label>${page.problems ? html`<input type="hidden" name="problems" value="1">` : ""}<button type="submit" class="btn">${t("Filter")}</button>
<a class="btn${page.problems ? " strong" : ""}" href="${page.problems ? "/knowledge/glossary" : "/knowledge/glossary?problems=1"}">${page.problems ? t("All terms") : t("Problems only ({n})", { n: withProblems })}</a>${actions ? fileActions(".jarvis/knowledge/glossary.md", "/knowledge/glossary", actions) : ""}</form>
<div class="cols">
<section class="panel mainc kgloss" aria-label="${t("Terms")}">
${
  !page.glossary.exists
    ? html`<p class="empty">${th("No glossary yet: the first term you add creates {file}.", { file: html`<code>.jarvis/knowledge/glossary.md</code>` })}</p>`
    : html`<div class="ktable" role="table" aria-label="${t("Glossary")}">
<div class="kr kh kg" role="row"><span role="columnheader">${t("Term")}</span><span role="columnheader">${t("Synonyms")}</span><span role="columnheader">${t("Symbols / modules")}</span><span role="columnheader">${t("Definition")}</span></div>
${rows.map(
  (r) =>
    html`<a class="kr kg${r.problems.length > 0 ? " warn" : ""}${r.term === s?.term ? " current" : ""}" role="row" href="${href({ term: r.term })}"><span role="cell"><b>${r.term}</b>${r.updated ? html`<span class="meta">${r.updated}</span>` : ""}</span><span role="cell">${r.synonyms.join(", ")}</span><span role="cell" class="meta">${r.symbols.join(", ")}${r.problems.map((p) => html`<span class="kprob">${p}</span>`)}</span><span role="cell" class="hint">${r.definition ?? ""}</span></a>`,
)}
${rows.length === 0 ? html`<p class="empty">${t("No term matches.")}</p>` : ""}
</div>`
}
</section>
<aside class="side kside" aria-label="${t("Where it is used")}">
${
  s
    ? html`<section class="panel kbox"><span class="hint">${t("selected term")}</span><h2>${s.term}</h2>
<p class="hint">${t("a query with it also searches for")}</p><p class="mono">${[...s.synonyms, ...s.symbols].join(" · ") || "—"}</p>
${
  page.where && page.where.length > 0
    ? html`<p class="hint">${t("in the code")}</p><ul class="kchecks">${page.where.map((c) => html`<li class="${c.found ? "ok" : "warn"}"><span aria-hidden="true">${c.found ? "✓" : "?"}</span> <code>${c.symbol}</code> — ${c.found ? c.where : t("not in the code")}</li>`)}</ul>`
    : ""
}
${s.sources.length > 0 ? html`<p class="hint">${t("sources:")} ${s.sources.join(", ")}</p>` : ""}
${s.problems.map((p) => html`<div class="banner bad">${p}</div>`)}
</section>`
    : html`<section class="panel kbox"><p class="hint">${t("Pick a term to see what a query with it becomes and where its symbols are.")}</p></section>`
}
</aside>
</div>`;
}

/* ---- candidates (ADR-0020 §6) ---- */

/** A candidate as its page shows it: what it proposes and what accepting it writes. */
export interface CandidateView {
  readonly id: string;
  readonly name: string;
  readonly kind: "knowledge" | "standard" | "skill-improvement" | "glossary";
  readonly title: string;
  readonly rationale: string;
  readonly proposal?: string;
  readonly evidence: readonly string[];
  readonly paths: readonly string[];
  readonly createdAt: string;
  /** A person who proposed it, or the run that did. */
  readonly by: {
    readonly person?: string;
    readonly run?: { readonly id: string; readonly workflow: string };
  };
  readonly decision?: string;
  /** standard, knowledge: the file accepting writes, and what is there now. */
  readonly target?: { readonly path: string; readonly taken?: "generated" | "person"; readonly id: string };
  /** skill-improvement: the skill and the version it goes to. */
  readonly skillEdit?: {
    readonly skill: string;
    readonly from: number;
    readonly to: number;
    readonly fromBuiltin: boolean;
  };
  /** glossary: the term and the symbols it gets. */
  readonly glossary?: { readonly term: string; readonly symbols: readonly string[]; readonly known: boolean };
  /** Accepting cannot work, and why (a skill that is not this project's to change). */
  readonly blocked?: string;
}

export interface CandidatesPage {
  readonly counts: KnowledgeCounts;
  readonly list: readonly CandidateView[];
  readonly selected?: CandidateView;
  /** Decided ones listed too. */
  readonly all: boolean;
  readonly decided: number;
  /** Module maps waiting on Modules. */
  readonly modules: number;
}

// t("standard") t("knowledge") t("skill-improvement") t("glossary")
const KIND_PILL: Record<CandidateView["kind"], string> = {
  standard: "bad",
  knowledge: "info",
  "skill-improvement": "wait",
  glossary: "plain",
};
const kindPill = (k: CandidateView["kind"]) => html`<span class="pill ${KIND_PILL[k]}">${t(k)}</span>`;
const candidateHref = (c: CandidateView, all: boolean) =>
  `/knowledge/candidates?id=${encodeURIComponent(c.id)}${all ? "&all=1" : ""}`;

function decisionPill(d: string | undefined): Html | string {
  if (!d) return "";
  return d === "approve"
    ? html`<span class="pill ok">${t("accepted")}</span>`
    : html`<span class="pill plain">${t("rejected")}</span>`;
}

/** What accepting writes, said before the button. */
// t("Accepting copies the built-in skill {skill} into {dir} and adds this at the end of its instructions: v{from} → v{to}.")
// t("Accepting adds this at the end of the instructions of {skill}: v{from} → v{to}.")
// t("Accepting adds {symbols} to the term {term} in the glossary.")
// t("Accepting adds the term {term} with {symbols} to the glossary.")
function writesHtml(c: CandidateView): Html {
  if (c.blocked) return html`<div class="banner bad">${c.blocked}</div>`;
  if (c.skillEdit)
    return html`<p class="hint">${th(
      c.skillEdit.fromBuiltin
        ? "Accepting copies the built-in skill {skill} into {dir} and adds this at the end of its instructions: v{from} → v{to}."
        : "Accepting adds this at the end of the instructions of {skill}: v{from} → v{to}.",
      {
        skill: html`<code>${c.skillEdit.skill}</code>`,
        dir: html`<code>.jarvis/skills/${c.skillEdit.skill}/</code>`,
        from: c.skillEdit.from,
        to: c.skillEdit.to,
      },
    )}</p>`;
  if (c.glossary)
    return html`<p class="hint">${th(
      c.glossary.known
        ? "Accepting adds {symbols} to the term {term} in the glossary."
        : "Accepting adds the term {term} with {symbols} to the glossary.",
      {
        term: html`<b>${c.glossary.term}</b>`,
        symbols: html`${c.glossary.symbols.map((x, i) => html`${i > 0 ? ", " : ""}<code>${x}</code>`)}`,
      },
    )}</p>`;
  if (c.target)
    return html`<p class="hint">${th("Accepting writes {file} — not committed: it goes through the usual review.", { file: html`<code>${c.target.path}</code>` })}${
      c.target.taken === "generated"
        ? html` ${t("Jarvis wrote the file there now: it is replaced.")}`
        : c.target.taken === "person"
          ? html` <b>${t("A person wrote the file there now: replace it, or give another name.")}</b>`
          : ""
    }</p>`;
  return html``;
}

function decideHtml(c: CandidateView, back: string, actions?: Actions): Html | string {
  if (!actions || c.decision) return "";
  const at = `/knowledge/candidates/${encodeURIComponent(c.id)}`;
  return html`<div class="kdecide">
${writesHtml(c)}
${
  c.blocked
    ? ""
    : form(
        actions,
        `${at}/accept`,
        html`<input type="hidden" name="back" value="${back}">${
          c.target
            ? html`<label class="field"><span>${t("File name")} <span class="hint">${t("optional; without .md")}</span></span><input type="text" name="id" value="${c.target.id}" maxlength="60" class="mono" pattern="[a-z0-9][a-z0-9._\-]{0,59}"></label>${
                c.target.taken === "person"
                  ? html`<label class="row"><input type="checkbox" name="replace" value="1"> ${t("replace the file a person wrote")}</label>`
                  : ""
              }`
            : ""
        }<div class="row"><button type="submit" class="btn primary">${t("Accept")}</button></div>`,
      )
}
${form(
  actions,
  `${at}/reject`,
  html`<input type="hidden" name="back" value="${back}"><label class="field"><span>${t("Why not")} <span class="hint">${t("optional; kept with the decision")}</span></span><input type="text" name="comment" maxlength="500"></label><div class="row"><button type="submit" class="btn">${t("Reject")}</button></div>`,
)}
</div>`;
}

export function candidatesContent(page: CandidatesPage, actions?: Actions, notice?: Html): Html {
  const c = page.selected;
  const back = c ? candidateHref(c, page.all) : "/knowledge/candidates";
  return html`${knowledgeTabs("candidates", page.counts)}
${notice ?? ""}
<div class="row"><p class="hint grow">${t("Proposed standards, knowledge, skill improvements and glossary terms: from review, from runs, from people. Accepted, one is written into the project, to commit as usual.")}${page.modules > 0 ? html` ${th("Module maps are decided on {modules}: {n} open.", { modules: html`<a href="/knowledge/modules">${t("Modules")}</a>`, n: page.modules })}` : ""}</p>
${page.decided > 0 ? html`<a class="btn small${page.all ? " strong" : ""}" href="/knowledge/candidates${page.all ? "" : "?all=1"}">${page.all ? t("Open only") : t("With decided ({n})", { n: page.decided })}</a>` : ""}</div>
<div class="kdoccols kstd">
<nav class="panel klist" aria-label="${t("Candidates")}">
${(() => {
  const kinds = [...new Set(page.list.map((x) => x.kind))];
  return kinds.map((k) => {
    const items = page.list.filter((x) => x.kind === k);
    return navGroup(
      kindPill(k),
      items.length,
      openGroup(
        kinds.length,
        items.some((x) => x.id === c?.id),
      ),
      html`${items.map(
        (x) =>
          html`<a class="kli${x.decision ? " off" : ""}" href="${candidateHref(x, page.all)}"${x.id === c?.id ? html` aria-current="page"` : ""}><span><code>${x.name}</code><span class="hint">${x.title}</span></span><span class="kmeta">${decisionPill(x.decision)}</span></a>`,
      )}`,
    );
  });
})()}
${page.list.length === 0 ? html`<p class="empty">${t("Nothing waits: review and runs propose candidates as they find things; you can propose one on the Overview.")}</p>` : ""}
</nav>
${
  c
    ? html`<article class="panel kdoc" aria-labelledby="cand-h">
<div class="kdochead"><div class="row"><h2 id="cand-h"><code>${c.name}</code></h2>${kindPill(c.kind)}${decisionPill(c.decision)}</div>
<p class="klead">${c.title}</p>
<dl class="mfacts">
<dt>${t("proposed by")}</dt><dd>${c.by.person ? c.by.person : c.by.run ? html`<a href="/runs/${encodeURIComponent(c.by.run.id)}">${c.by.run.workflow}</a>` : "—"} · ${c.createdAt.slice(0, 16).replace("T", " ")}</dd>
${c.paths.length > 0 ? html`<dt>${t("paths")}</dt><dd><code>${c.paths.join(", ")}</code></dd>` : ""}
${c.skillEdit ? html`<dt>${t("skill")}</dt><dd><a href="/knowledge/skills?id=${encodeURIComponent(c.skillEdit.skill)}"><code>${c.skillEdit.skill}</code></a></dd>` : ""}
</dl>
${c.rationale && c.rationale !== c.proposal && !(c.by.person && c.rationale.startsWith("Proposed by ")) ? html`<p>${c.rationale}</p>` : ""}
</div>
${c.proposal ? html`<div class="doc">${md(c.proposal)}</div>` : ""}
${
  c.evidence.length > 0
    ? html`<section class="kfound"><h3>${t("Evidence")}</h3><ul>${c.evidence.slice(0, 40).map((e) => html`<li><code>${e}</code></li>`)}</ul>${c.evidence.length > 40 ? html`<p class="hint">${t("… {n} more", { n: c.evidence.length - 40 })}</p>` : ""}</section>`
    : ""
}
${decideHtml(c, back, actions)}
</article>`
    : html`<p class="empty">${t("Pick a candidate.")}</p>`
}
</div>`;
}

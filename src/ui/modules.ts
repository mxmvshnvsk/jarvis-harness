import { type BudgetWait, budgetWaitOf, whenText } from "../app/budgetWait.ts";
import { type Candidate, candidatesOf, existingAt, targetOf } from "../app/candidates.ts";
import type { Runtime } from "../app/runtime.ts";
import type { Run } from "../core/domain/run.ts";
import { moduleCheckOf, moduleOfRun } from "../onboarding/moduleRun.ts";
import { findNode, isAuxFolder, type ModuleTree, TOO_BIG, type TreeNode } from "../onboarding/tree.ts";
import { shortRunId } from "../storage/runStore.ts";
import { type DiffFile, type Html, html, markdownToHtml } from "./html.ts";
import { type KnowledgeCounts, knowledgeTabs } from "./knowledge.ts";
import type { Launch } from "./launcher.ts";
import { type Actions, diffFileHtml } from "./pages.ts";

/**
 * Knowledge → Modules in `jarvis ui`: pick a module or a folder inside one, research it with the
 * onboarding mapper (`jarvis onboard --module`, started in the background), review what the code
 * check kept and accept it as a draft under `.jarvis/knowledge/`. Truth stays in the files;
 * decisions go through src/app/candidates.ts, as `jarvis candidates` does.
 */
export type Research =
  | { readonly kind: "queued"; readonly launch: string; readonly position: number }
  | { readonly kind: "starting"; readonly launch: string }
  | { readonly kind: "running"; readonly run: Run }
  | { readonly kind: "paused"; readonly run: Run; readonly wait: BudgetWait }
  | { readonly kind: "waiting"; readonly run: Run }
  | { readonly kind: "failed"; readonly run: Run; readonly reason: string }
  | { readonly kind: "candidate"; readonly run: Run; readonly candidate: Candidate }
  | { readonly kind: "accepted"; readonly run: Run; readonly candidate: Candidate; readonly file: string }
  | { readonly kind: "rejected"; readonly run: Run; readonly candidate: Candidate };

export interface Draft {
  readonly path: string;
  /** `??` new, `M` changed, … from `git status --porcelain`. */
  readonly status: string;
}

export interface ModulesPage {
  readonly tree: ModuleTree;
  readonly path?: string;
  readonly selected?: TreeNode;
  /** Only folders that need research (no document of their own, a stale or generated one). */
  readonly need: boolean;
  readonly research: ReadonlyMap<string, Research>;
  readonly drafts: readonly Draft[];
  readonly canStart: boolean;
  /** The candidate's target holds a document a person wrote: what replacing it changes. */
  readonly conflict?: { readonly file: string; readonly diff: readonly DiffFile[] };
  readonly root: string;
  readonly counts?: KnowledgeCounts;
}

/** The latest research of every module: queued launches, then the newest run about it. */
export function researchOf(
  runtime: Runtime,
  launches: readonly Launch[],
  root: string,
): Map<string, Research> {
  const out = new Map<string, Research>();
  const queue = launches.filter((l) => l.queued && l.module).reverse();
  queue.forEach((l, i) => {
    out.set(l.module as string, { kind: "queued", launch: l.id, position: i + 1 });
  });
  for (const l of launches)
    if (l.module && !l.queued && !l.runId && l.exitCode === null && !out.has(l.module))
      out.set(l.module, { kind: "starting", launch: l.id });
  const runs = runtime.runs
    .list({ includeTerminal: true, limit: 500 })
    .filter((r) => r.workflow === "onboard-module" && r.workspace.repoRoot === root);
  if (runs.length === 0) return out;
  const ids = new Set(runs.map((r) => r.id));
  const candidates = candidatesOf(runtime, (r) => ids.has(r.id));
  // newest first: the first run seen for a module is its latest
  for (const run of [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const module = moduleOfRun(runtime, run.id)?.module;
    if (!module || out.has(module)) continue;
    const candidate = candidates.find((c) => c.artifact.runId === run.id);
    const wait = budgetWaitOf(runtime, run);
    if (wait) out.set(module, { kind: "paused", run, wait });
    else if (run.state === "RUNNING" || run.state === "CREATED") out.set(module, { kind: "running", run });
    else if (run.state === "WAITING_HUMAN" || run.state === "SUSPENDED")
      out.set(module, { kind: "waiting", run });
    else if (candidate?.decision === "approve")
      out.set(module, {
        kind: "accepted",
        run,
        candidate,
        file:
          str(runtime.events.list({ runId: run.id, kind: "knowledge.promoted" }).at(-1)?.payload?.file) ??
          targetOf(root, candidate, undefined).slice(root.length + 1),
      });
    else if (candidate?.decision === "reject") out.set(module, { kind: "rejected", run, candidate });
    else if (candidate) out.set(module, { kind: "candidate", run, candidate });
    else {
      const check = moduleCheckOf(runtime, run.id);
      const reason = check
        ? "no claim survived the check against the code"
        : `the run ended ${run.state.toLowerCase()}${run.stateReason ? `: ${run.stateReason}` : ""}`;
      out.set(module, { kind: "failed", run, reason });
    }
  }
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/* ---- view ---- */

const runHref = (run: Run) => `/runs/${encodeURIComponent(shortRunId(run.id))}`;
const here = (path: string, extra = "") => `/knowledge/modules?path=${encodeURIComponent(path)}${extra}`;

function form(actions: Actions, action: string, body: Html, attrs: Html | string = ""): Html {
  return html`<form method="post" action="${action}"${attrs}><input type="hidden" name="t" value="${actions.token}">${body}</form>`;
}

/** What a folder's row says: the research going on, else the knowledge it has. */
function badge(node: TreeNode, r: Research | undefined): Html {
  if (r) {
    const label: Record<Research["kind"], [string, string]> = {
      queued: ["queued", "info"],
      starting: ["starting…", "info"],
      running: ["researching…", "info"],
      paused: ["waits for quota", "wait"],
      waiting: ["waits for you", "wait"],
      failed: ["research failed", "bad"],
      candidate: ["candidate waits", "info"],
      accepted: ["draft", "ok"],
      rejected: ["discarded", "plain"],
    };
    const [text, tone] = label[r.kind];
    if (r.kind !== "rejected") return html`<span class="pill ${tone}">${text}</span>`;
  }
  const c = node.coverage;
  if (!c)
    return node.tooBig && node.children.length > 0
      ? html`<span class="pill plain">by parts</span>`
      : html`<span class="pill wait">no document</span>`;
  if (c.staleCommits) return html`<span class="pill wait">may be stale</span>`;
  if (c.kind === "generated") return html`<span class="pill plain">generated</span>`;
  if (c.kind === "via") return html`<span class="pill ok">via a doc</span>`;
  return html`<span class="pill ok">documented</span>`;
}

/**
 * The folders to research first: the highest ones that fit one pass and need it, biggest first —
 * a big module is looked into, its tests and mocks are not.
 */
export function researchFirst(modules: readonly TreeNode[], limit = 6): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (n: TreeNode) => {
    if (isAuxFolder(n.name)) return;
    if (!n.tooBig) {
      if (needsResearch(n)) out.push(n);
      else n.children.forEach(walk);
      return;
    }
    n.children.forEach(walk);
  };
  modules.forEach(walk);
  return out.sort((a, b) => b.files - a.files).slice(0, limit);
}

/** Folders that need research: no document of their own, or a stale or generated one. */
export function needsResearch(node: TreeNode): boolean {
  if (isAuxFolder(node.name)) return false;
  const c = node.coverage;
  return !c || c.kind === "generated" || !!c.staleCommits || (c.kind === "via" && node.module);
}

function treeHtml(page: ModulesPage): Html {
  const sel = page.path ?? "";
  const keep = (n: TreeNode): boolean =>
    !page.need || needsResearch(n) || page.research.has(n.path) || n.children.some(keep);
  const row = (n: TreeNode) => {
    const current = n.path === sel;
    return html`<a class="mrow${current ? " current" : ""}" href="${here(n.path, page.need ? "&need=1" : "")}"${current ? html` aria-current="true"` : ""}><span class="mname">${n.module ? n.path : `${n.name}/`}</span>${badge(n, page.research.get(n.path))}<span class="mfiles${n.tooBig ? " big" : ""}" title="${n.files} files, about ${n.lines} lines">${n.files}</span></a>`;
  };
  const node = (n: TreeNode): Html => {
    const kids = n.children.filter(keep);
    if (kids.length === 0) return html`<li>${row(n)}</li>`;
    const open = sel === n.path || sel.startsWith(`${n.path}/`);
    return html`<li><details${open ? " open" : ""}><summary>${row(n)}</summary><ul>${kids.map(node)}</ul></details></li>`;
  };
  const tops = page.tree.modules.filter(keep);
  return html`<nav class="panel mtree" aria-label="Modules and folders">
<div class="mhead"><span>Module / folder</span><span>Knowledge</span><span>Files</span></div>
${tops.length > 0 ? html`<ul>${tops.map(node)}</ul>` : html`<p class="empty">${page.need ? "Every module has a document." : "No source modules in this repository."}</p>`}
</nav>`;
}

function pathField(page: ModulesPage): Html {
  return html`<form class="mpath" method="get" action="/knowledge/modules" role="search">
<label class="field grow">Path<input type="text" name="path" list="module-dirs" value="${page.path ?? ""}" placeholder="src/shared/metrics" autocomplete="off" spellcheck="false"></label>
${page.need ? html`<input type="hidden" name="need" value="1">` : ""}
<button type="submit" class="btn">Open</button>
<datalist id="module-dirs">${page.tree.dirs.map((d) => html`<option value="${d}"></option>`)}</datalist>
</form>`;
}

function factsHtml(n: TreeNode): Html {
  const c = n.coverage;
  const knowledge = c
    ? html`<code>${c.doc}</code>${c.source ? html` <span class="hint">(the team's documentation, read-only)</span>` : ""}${c.kind === "via" ? html` <span class="hint">— about a wider folder</span>` : ""}${c.kind === "generated" ? html` <span class="hint">— generated, nobody took it over</span>` : ""}${c.staleCommits ? html` <span class="pill wait">${c.staleCommits} commits here since its last edit</span>` : ""}`
    : html`<span class="hint">none</span>`;
  return html`<dl class="mfacts">
<dt>from the scan</dt><dd>${n.files} files, about ${n.lines} lines${n.languages.length > 0 ? ` (${n.languages.join(", ")})` : ""}</dd>
<dt>knowledge now</dt><dd>${knowledge}</dd>
${n.also.length > 0 ? html`<dt>also applies</dt><dd>${n.also.map((d, i) => html`${i > 0 ? ", " : ""}<a href="/knowledge/docs?doc=${encodeURIComponent(d)}"><code>${d}</code></a>`)} <span class="hint">— wider documents, not about this folder</span></dd>` : ""}
</dl>`;
}

const cost = (n: TreeNode) =>
  n.files > TOO_BIG.files || n.lines > TOO_BIG.lines
    ? "a folder this big may stop at the agent's limit and ask you for more"
    : n.files > 60
      ? "usually 30–45 tool calls, 0.5–0.9M input tokens"
      : "usually 20–35 tool calls, 0.3–0.6M input tokens";

function startHtml(n: TreeNode, actions: Actions, again?: string): Html {
  return form(
    actions,
    "/knowledge/modules/research",
    html`<input type="hidden" name="path" value="${n.path}">
<label class="field">What matters <span class="hint">optional — goes into the agent's task</span><textarea name="note" rows="3" maxlength="2000" placeholder="e.g. how events are named and where the catalogue lives; skip the legacy adapter">${again ?? ""}</textarea></label>
<p class="hint">Agent <code>onboard-mapper</code>, read-only, stays inside <code>${n.path}/</code>: ${cost(n)}. One research at a time; the next one waits in the queue.</p>
<div class="row"><button type="submit" class="btn primary">${again === undefined ? "Start research" : "Research again"}</button><span class="hint">Same as <code>jarvis onboard --module ${n.path}</code></span></div>`,
    ' class="mstart"',
  );
}

function partsHtml(n: TreeNode, page: ModulesPage, actions: Actions): Html {
  const parts = n.children;
  return html`<div class="banner info">Too big for one pass — ${n.files} files, about ${n.lines} lines (one research covers up to ${TOO_BIG.files} files or ${TOO_BIG.lines / 1000}k lines well). Pick the parts: they run one after another, each gives its own candidate.</div>
${form(
  actions,
  "/knowledge/modules/research",
  html`<fieldset class="mparts"><legend class="sr">Parts of ${n.path}</legend>
${parts.map((p) => {
  const busy = page.research.get(p.path);
  const disabled = busy && ["queued", "starting", "running", "paused", "waiting"].includes(busy.kind);
  const pick = !disabled && needsResearch(p) && !p.tooBig;
  return html`<label class="mpart"><input type="checkbox" name="path" value="${p.path}"${pick ? " checked" : ""}${disabled ? " disabled" : ""}><code>${p.path}</code><span class="hint">${p.files} files${p.tooBig ? " · big itself" : ""}</span>${badge(p, busy)}</label>`;
})}
</fieldset>
<label class="field">What matters <span class="hint">optional — the same note for every part</span><textarea name="note" rows="2" maxlength="2000"></textarea></label>
<div class="row"><button type="submit" class="btn primary">Research the picked parts</button></div>`,
)}`;
}

function candidateHtml(
  r: Extract<Research, { kind: "candidate" }>,
  page: ModulesPage,
  actions: Actions,
): Html {
  const c = r.candidate;
  const claims = c.claims;
  const dropped = c.doc.dropped ?? [];
  const target = targetOf(page.root, c, undefined);
  const existing = existingAt(target);
  const rel = target.slice(page.root.length + 1);
  const taken = existing && !existing.generated;
  const accept = form(
    actions,
    `/knowledge/candidates/${encodeURIComponent(c.artifact.artifactId)}/accept`,
    html`${
      c.review.length > 0
        ? html`<fieldset class="mchecks"><legend><b>Check these first</b> <span class="hint">— the excerpts show one place, the statement speaks for the whole folder. Tick when you agree.</span></legend>
${c.review.map((s, i) => html`<label class="mcheck"><input type="checkbox" name="checked" value="${String(i)}" required><span>${s}</span></label>`)}
</fieldset>`
        : ""
    }
${taken ? html`<div class="banner bad"><code>${rel}</code> exists and was written by a person. Replace it with this document, or keep it and write the new one under another name.</div>` : ""}
${existing?.generated ? html`<p class="hint"><code>${rel}</code> exists but jarvis generated it and nobody took it over: Accept replaces it.</p>` : ""}
<div class="row">
<button type="submit" class="btn accept"${taken ? html` name="replace" value="1"` : ""}>${taken ? "Replace it" : "Accept as a draft"}</button>
${taken ? html`<label class="field inline">or as<input type="text" name="id" placeholder="${rel.replace(/^.*\//, "").replace(/\.md$/, "")}-2" pattern="[a-z0-9][a-z0-9._-]*" maxlength="60"></label><button type="submit" class="btn">Write under that name</button>` : ""}
<span class="hint">Writes <code>${rel}</code> into the working copy; commit it with the drafts below.</span>
</div>`,
  );
  const again = form(
    actions,
    `/knowledge/candidates/${encodeURIComponent(c.artifact.artifactId)}/reject`,
    html`<label class="field">Note for the next research <span class="hint">what was wrong or missing</span><textarea name="comment" rows="2" maxlength="2000"></textarea></label>
<div class="row"><button type="submit" class="btn" name="again" value="1">Research again with the note</button><button type="submit" class="btn">Discard</button></div>`,
  );
  return html`<div class="row">
${claims ? html`<span class="pill ok">${claims.kept} of ${claims.proposed} claims confirmed</span>` : ""}
${dropped.length > 0 ? html`<span class="pill plain">${dropped.length} dropped</span>` : ""}
${c.review.length > 0 ? html`<span class="pill wait">${c.review.length} to check</span>` : ""}
<a class="hint" href="${runHref(r.run)}">run ${shortRunId(r.run.id)}</a>
</div>
${c.doc.note ? html`<p class="hint">Asked: ${c.doc.note}</p>` : ""}
${
  dropped.length > 0
    ? html`<section class="mdropped" aria-label="Dropped by the check"><h3>Dropped by the check against the code</h3><ul>${dropped.map((d) => html`<li><span class="hint">${d.section}</span> <s>${d.what}</s> — ${d.why}</li>`)}</ul></section>`
    : ""
}
<details class="mdoc" open><summary>The document → <code>${rel}</code></summary><div class="doc">${markdownToHtml(
    (c.doc.proposal ?? "").replace(/^---\n[\s\S]*?\n---\n/, "").replace(/^<!--[\s\S]*?-->\n?/gm, ""),
  )}</div></details>
${taken && page.conflict?.diff.length ? html`<details class="mdiff"><summary>What replacing <code>${rel}</code> changes</summary>${page.conflict.diff.map((f, i) => diffFileHtml(f, i, false))}</details>` : ""}
${accept}
${again}`;
}

function researchHtml(page: ModulesPage, actions?: Actions): Html {
  const n = page.selected;
  if (!n)
    return html`<section class="panel mresearch" data-live="research"><p class="empty">${page.path ? html`<code>${page.path}</code> is not a folder of a module here.` : "Pick a module or a folder on the left, or type its path."}</p></section>`;
  const r = page.research.get(n.path);
  const can = actions && page.canStart ? actions : undefined;
  let body: Html;
  if (!r || r.kind === "rejected") {
    if (!can)
      body = html`<p class="hint">Starting research is off here (read-only, or <code>jarvis ui</code> without a launcher). In a terminal: <code>jarvis onboard --module ${n.path}</code></p>`;
    else if (n.tooBig && n.children.length > 0) body = partsHtml(n, page, can);
    else body = startHtml(n, can);
  } else if (r.kind === "queued")
    body = html`<p>Queued — ${r.position === 1 ? "next" : `${r.position} in line`}. Starts when the research in front of it ends.</p>${can ? form(can, "/knowledge/modules/unqueue", html`<input type="hidden" name="launch" value="${r.launch}"><input type="hidden" name="path" value="${n.path}"><button type="submit" class="btn">Remove from the queue</button>`) : ""}`;
  else if (r.kind === "starting")
    body = html`<p class="row"><span class="spin" aria-hidden="true"></span> Starting — the scan reads the folder, then the agent begins.</p>`;
  else if (r.kind === "running")
    body = html`<p class="row"><span class="spin" aria-hidden="true"></span> ${r.run.currentStep === "verify" ? "Checking every claim against the code (no model)…" : "The agent maps the folder — read-only."}</p><p><a class="btn" href="${runHref(r.run)}">Open the run</a></p>`;
  else if (r.kind === "paused")
    body = html`<div class="banner info">⏸ Paused, not failed: ${r.wait.kind === "model" ? html`the model <code>${r.wait.model ?? "?"}</code> does not answer` : html`the quota window${r.wait.pool ? html` of pool <code>${r.wait.pool}</code>` : ""} is full`}. Goes on by itself at <b>${whenText(r.wait.resumeAfter)}</b>.${r.wait.detail ? html` <span class="hint">Window: ${r.wait.detail}.</span>` : ""}</div>
<div class="row">${actions ? html`<form method="post" action="/runs/${encodeURIComponent(shortRunId(r.run.id))}/resume"><input type="hidden" name="t" value="${actions.token}"><input type="hidden" name="back" value="${here(n.path)}"><button type="submit" class="btn">Resume now</button></form>` : ""}<a class="btn" href="${runHref(r.run)}">Open the run</a></div>`;
  else if (r.kind === "waiting")
    body = html`<div class="banner info">The research waits for you (a budget, or the agent asks).</div><p><a class="btn primary" href="${runHref(r.run)}">Open the run</a></p>`;
  else if (r.kind === "failed")
    body = html`<div class="banner bad">The last research found nothing to keep: ${r.reason}. <a href="${runHref(r.run)}">run ${shortRunId(r.run.id)}</a></div>${can ? startHtml(n, can, "") : ""}`;
  else if (r.kind === "accepted")
    body = html`<div class="banner ok">Accepted: <code>${r.file}</code> is in the working copy — the next run already finds it. Commit it with the drafts below.</div>
${actions ? form(actions, "/knowledge/open", html`<input type="hidden" name="file" value="${r.file}"><input type="hidden" name="path" value="${n.path}"><button type="submit" class="btn">Open in editor</button>`) : ""}
${can ? html`<details class="magain"><summary>Research again</summary>${startHtml(n, can, "")}</details>` : ""}`;
  else
    body = actions
      ? candidateHtml(r, page, actions)
      : html`<p class="hint">A candidate waits: <code>jarvis candidates show ${r.candidate.name}</code></p>`;
  return html`<section class="panel mresearch" aria-labelledby="research-title" data-live="research">
<div class="row"><h2 id="research-title">Research <code>${n.path}</code></h2>${badge(n, r)}</div>
${factsHtml(n)}
${body}
</section>`;
}

/** Knowledge files not committed yet, on every Knowledge page, with one button to commit them. */
export function draftsHtml(drafts: readonly Draft[], back: string, actions?: Actions): Html {
  if (drafts.length === 0) return html`<div data-live="drafts" hidden></div>`;
  return html`<section class="panel mdrafts" aria-label="Knowledge not committed" data-live="drafts">
<div><b>${drafts.length} knowledge file${drafts.length === 1 ? "" : "s"} not committed</b>
<span class="hint">${drafts.map((d) => d.path.replace(/^\.jarvis\//, "")).join(", ")} · agents already see them</span></div>
${actions ? form(actions, "/knowledge/commit", html`<input type="hidden" name="back" value="${back}"><button type="submit" class="btn primary">Commit knowledge</button>`) : html`<code>git add .jarvis && git commit</code>`}
</section>`;
}

export function modulesContent(page: ModulesPage, actions?: Actions, notice?: Html): Html {
  return html`${knowledgeTabs("modules", page.counts)}
${notice ?? ""}
<p class="hint">An agent maps a module or a folder; every claim is checked against the code; what survives waits here. Nothing reaches <code>.jarvis/knowledge/</code> until you accept it.</p>
<div class="cols mcols">
<div class="mleft">
${pathField(page)}
<div class="row"><a class="btn small${page.need ? "" : " strong"}" href="/knowledge/modules${page.path ? `?path=${encodeURIComponent(page.path)}` : ""}"${page.need ? "" : ' aria-current="true"'}>All</a><a class="btn small${page.need ? " strong" : ""}" href="${page.path ? here(page.path, "&need=1") : "/knowledge/modules?need=1"}"${page.need ? ' aria-current="true"' : ""}>Need research</a></div>
${treeHtml(page)}
</div>
<div class="mright">
${researchHtml(page, actions)}
</div>
</div>
${draftsHtml(page.drafts, page.path ? here(page.path) : "/knowledge/modules", actions)}`;
}

/** The page model for a path: the node it names, if any. */
export function selectedOf(tree: ModuleTree, path: string | undefined): TreeNode | undefined {
  return path ? findNode(tree, path) : undefined;
}

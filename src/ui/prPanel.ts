import type { Delivered } from "../app/deliver.ts";
import type { PrComment, PrReviewDoc, PrThread } from "../app/prReview.ts";
import { commentText, type TriageDoc, type TriageItem } from "../app/prTriage.ts";
import type { Run } from "../core/domain/run.ts";
import { shortRunId } from "../storage/runStore.ts";
import { type Html, html } from "./html.ts";
import { plural, t, th } from "./i18n.ts";

/**
 * The PR flow on the run's page (above its card): where the PR stands — its phase, approvals, the
 * build, the open threads, what stands before the merge — and «Check comments»; and the code review
 * page, the PR's open threads as read from the server. Run phases are not translated.
 */

/** The PR's phase, as a word of the run's states: not translated. */
export function prPhaseOf(doc: PrReviewDoc | undefined): string {
  if (!doc) return "PR_REVIEW";
  if (doc.state === "MERGED") return "MERGED";
  if (doc.state === "DECLINED") return "DECLINED";
  return doc.ready ? "READY_TO_MERGE" : "PR_REVIEW";
}

const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);

function buildText(doc: PrReviewDoc): string {
  if (!doc.build) return t("unknown");
  if (doc.build.failed > 0) return t("build failed");
  if (doc.build.inProgress > 0) return t("build running");
  return t("build passed");
}

export function prPanelHtml(
  run: Run,
  pr: Delivered,
  doc: PrReviewDoc | undefined,
  options: {
    token?: string;
    approvals: number;
    pollMinutes: number;
    lastCheck?: string;
    following: boolean;
    /** Where «Check comments» comes back to: the code review page. */
    back?: "review";
    /** Threads the agent weighed that wait for the person. */
    waiting?: number;
    /** The task was finalized: by whom, when. */
    finalized?: { by?: string; at: string };
  },
): Html {
  const short = encodeURIComponent(shortRunId(run.id));
  const phase = options.finalized ? "FINALIZED" : prPhaseOf(doc);
  const tone =
    phase === "READY_TO_MERGE" || phase === "MERGED" || phase === "FINALIZED"
      ? "ok"
      : phase === "DECLINED"
        ? "bad"
        : "info";
  const open = doc ? doc.threads.filter((t) => !t.mine).length : undefined;
  const link = pr.url
    ? html`<a href="${pr.url}" rel="noreferrer noopener" target="_blank">PR #${pr.id ?? ""}</a>`
    : html`PR`;
  return html`<section class="panel pr-panel" aria-labelledby="pr-h" data-pr-panel>
<div class="pr-head"><h2 id="pr-h">${link} <span class="pill ${tone} mono">${phase}</span></h2><span class="hint mono">${pr.source} → <b>${pr.target}</b></span></div>
${
  options.waiting && options.waiting > 0
    ? html`<p class="banner wait" role="status">${plural(options.waiting, "comment waits", "comments wait")} ${t("for you: the agent disagrees or drafted an answer")} — <a href="/runs/${short}/pr">${t("Code review")}</a></p>`
    : ""
}
${
  doc
    ? html`<dl class="pr-facts">
<div><dt>${t("Build")}</dt><dd>${buildText(doc)}</dd></div>
<div><dt>${t("Approvals")}</dt><dd>${t("{n} of {of}", { n: doc.approvals, of: options.approvals })}</dd></div>
<div><dt>${t("Open threads")}</dt><dd>${open ?? 0}</dd></div>
<div><dt>${t("Open tasks")}</dt><dd>${doc.openTasks}</dd></div>
</dl>
${
  phase === "READY_TO_MERGE"
    ? html`<p class="banner ok">${t("Ready for merge: merge it in Bitbucket — Jarvis does not merge.")}</p>`
    : doc.blockers.length > 0 && phase === "PR_REVIEW"
      ? html`<p class="hint">${t("Before the merge:")} ${doc.blockers.join(" · ")}</p>`
      : ""
}`
    : html`<p class="hint">${t("Not read yet: the comments are read once the PR is up.")}</p>`
}
${finalizeHtml(run, doc, options)}
<div class="row">${
    options.token && options.following
      ? html`<form method="post" action="/runs/${short}/pr-check"><input type="hidden" name="t" value="${options.token}">${options.back ? html`<input type="hidden" name="back" value="${options.back}">` : ""}<button type="submit" class="btn">${t("Check comments")}</button></form>`
      : ""
  }<a class="btn" href="/runs/${short}/pr">${t("Code review")}</a><span class="hint">${
    options.following
      ? th("read every {n} min while jarvis ui is open{last}", {
          n: options.pollMinutes,
          last: options.lastCheck ? html`; ${t("last at {time}", { time: hhmm(options.lastCheck) })}` : "",
        })
      : options.lastCheck
        ? t("last read at {time}", { time: hhmm(options.lastCheck) })
        : ""
  }</span></div>
</section>`;
}

/**
 * «Finalize the task»: with an eval case of the run and the PR's comments kept as review findings, both
 * ticked; a PR not ready for merge asks the person to say they finalize anyway.
 */
function finalizeHtml(
  run: Run,
  doc: PrReviewDoc | undefined,
  options: { token?: string; finalized?: { by?: string; at: string }; back?: "review" },
): Html | string {
  if (options.finalized)
    return html`<p class="hint">${t("The task is finalized")}${options.finalized.by ? ` · ${options.finalized.by.replace(/^\w+:/, "")}` : ""} · ${hhmm(options.finalized.at)}</p>`;
  if (!options.token) return "";
  const ready = doc?.state === "MERGED" || doc?.ready === true;
  return html`<details class="pr-finalize"${ready ? " open" : ""}><summary>${t("Finalize the task")}</summary>
<form method="post" action="/runs/${encodeURIComponent(shortRunId(run.id))}/finalize"><input type="hidden" name="t" value="${options.token}">${options.back ? html`<input type="hidden" name="back" value="${options.back}">` : ""}
<label class="check"><input type="checkbox" name="eval" value="1" checked> ${t("Make an eval case of the run")} <span class="meta">— ${t("the task, the spec and the accepted change, to check models and prompts on")}</span></label>
<label class="check"><input type="checkbox" name="lessons" value="1" checked> ${t("Keep the PR's comments in the knowledge")} <span class="meta">— ${t("a comment reviewers keep making becomes a standard to approve")}</span></label>
${ready ? "" : html`<label class="check"><input type="checkbox" name="anyway" value="1" required> ${t("The PR is not ready for merge — finalize anyway")}</label>`}
<div class="row"><button type="submit" class="btn primary">${t("Finalize")}</button><span class="hint">${t("the checkout is removed; the branch stays, the PR has it; the merge stays yours")}</span></div></form></details>`;
}

function commentHtml(c: PrComment, depth: number): Html {
  return html`<div class="pr-comment${c.mine ? " mine" : ""}" style="margin-left:${depth * 16}px">
<div class="hint"><b>${c.mine ? "Jarvis" : c.author}</b>${c.at ? html` · ${hhmm(c.at)}` : ""}</div>
<p class="pr-text">${commentText(c.text)}</p>
${c.replies.map((r) => commentHtml(r, depth + 1))}
</div>`;
}

const VERDICT: Record<TriageItem["verdict"], { label: string; tone: string }> = {
  agree: { label: "the agent agrees", tone: "ok" },
  disagree: { label: "the agent disagrees — your call", tone: "wait" },
  question: { label: "a question — the agent drafted an answer", tone: "info" },
  nothing: { label: "nothing to do", tone: "" },
};
// t("the agent agrees") t("the agent disagrees — your call") t("a question — the agent drafted an answer") t("nothing to do")

/** The agent's verdict on a thread and what the person can do with it. */
function verdictHtml(run: Run, item: TriageItem, token: string | undefined): Html {
  const v = VERDICT[item.verdict];
  const action = `/runs/${encodeURIComponent(shortRunId(run.id))}/pr-reply`;
  const state =
    item.state === "replied"
      ? html`<p class="hint">${t("Replied")}${item.done?.edited ? ` · ${t("edited by {who}", { who: item.done.by.replace(/^\w+:/, "") })}` : ""}</p>`
      : item.state === "to-fix"
        ? html`<p class="hint">${t("To be fixed: Jarvis changes the code, pushes a commit and answers in the thread")}</p>`
        : item.state === "fixing"
          ? html`<p class="hint">${t("Being fixed")}${item.fix ? html` — <a href="/runs/${encodeURIComponent(shortRunId(item.fix.run))}">${t("run {id}", { id: shortRunId(item.fix.run) })}</a>` : ""}</p>`
          : item.state === "fixed"
            ? html`<p class="hint">${t("Fixed")}${item.fix?.commit ? html` <code>${item.fix.commit.slice(0, 10)}</code>` : ""}${item.fix ? html` — <a href="/runs/${encodeURIComponent(shortRunId(item.fix.run))}">${t("run {id}", { id: shortRunId(item.fix.run) })}</a>` : ""}</p>`
            : item.state === "handled"
              ? html`<p class="hint">${t("Left to you")}</p>`
              : "";
  const form =
    token && item.state === "proposed"
      ? html`<form method="post" action="${action}" class="pr-reply"><input type="hidden" name="t" value="${token}"><input type="hidden" name="thread" value="${item.thread}">
<label>${t("Reply in the PR (you can change it)")}<textarea name="text" rows="3">${item.reply}</textarea></label>
<div class="row"><button type="submit" class="btn primary" name="action" value="send">${t("Send reply")}</button>${
          item.verdict === "agree"
            ? html`<button type="submit" class="btn" name="action" value="fix">${t("Fix it")}</button>`
            : item.verdict !== "nothing"
              ? html`<button type="submit" class="btn" name="action" value="fix">${t("Fix anyway")}</button>`
              : ""
        }<button type="submit" class="btn" name="action" value="self">${t("I will answer myself")}</button></div></form>`
      : "";
  return html`<div class="pr-verdict"><span class="pill ${v.tone}">${t(v.label)}</span>
<p>${item.reason}</p>${item.change ? html`<p class="hint">${t("Change:")} ${item.change}</p>` : ""}${item.sources.length > 0 ? html`<p class="hint">${t("Sources:")} ${item.sources.join(" · ")}</p>` : ""}
${state}${form}</div>`;
}

function threadHtml(run: Run, th0: PrThread, item: TriageItem | undefined, token: string | undefined): Html {
  const where = th0.file ? `${th0.file}${th0.line ? `:${th0.line}` : ""}` : t("the PR as a whole");
  return html`<article class="panel pr-thread" id="t${th0.id}" data-thread="${th0.id}">
<div class="pr-thread-head"><span class="pill ${th0.task ? "wait" : ""}">${th0.task ? t("task") : t("comment")}</span><span class="mono hint">${where}</span></div>
${commentHtml(th0, 0)}
${item ? verdictHtml(run, item, token) : ""}
</article>`;
}

/** The code review page: the PR's open threads as the server has them, the newest read. */
export function prReviewPageHtml(
  run: Run,
  pr: Delivered,
  doc: PrReviewDoc | undefined,
  panel: Html,
  triage: TriageDoc = { items: [] },
  token?: string,
): Html {
  const itemOf = (id: number) => triage.items.find((i) => i.thread === id);
  // the threads waiting for the person first: the agent disagrees or drafted an answer
  const waits = (x: PrThread) => (itemOf(x.id)?.state === "proposed" ? 0 : 1);
  const theirs = (doc?.threads.filter((x) => !x.mine) ?? [])
    .map((x, i) => ({ x, i }))
    .sort((a, b) => waits(a.x) - waits(b.x) || a.i - b.i)
    .map((p) => p.x);
  const mine = doc?.threads.filter((x) => x.mine) ?? [];
  const thread = (x: PrThread) => threadHtml(run, x, itemOf(x.id), token);
  return html`<div class="pr-review" style="display:flex;flex-direction:column;gap:16px">
<h1>${t("Code review")} <span class="hint mono">${run.task.split("\n")[0]}</span></h1>
${panel}
${
  !doc
    ? html`<p class="hint">${t("The PR has not been read yet: «Check comments» reads it now.")}</p>`
    : theirs.length === 0
      ? html`<p class="hint">${t("No open threads.")}</p>`
      : html`<h2>${t("Open threads")} <span class="hint">${theirs.length}</span></h2>${theirs.map(thread)}`
}
${mine.length > 0 ? html`<details><summary>${t("Jarvis's own comments")} (${mine.length})</summary>${mine.map(thread)}</details>` : ""}
<p class="hint">${pr.url ? html`<a href="${pr.url}" rel="noreferrer noopener" target="_blank">${t("Open in Bitbucket")}</a>` : ""}</p>
</div>`;
}

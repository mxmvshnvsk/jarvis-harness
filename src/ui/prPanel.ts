import type { Delivered } from "../app/deliver.ts";
import type { PrComment, PrReviewDoc, PrThread } from "../app/prReview.ts";
import type { Run } from "../core/domain/run.ts";
import { shortRunId } from "../storage/runStore.ts";
import { type Html, html } from "./html.ts";
import { t, th } from "./i18n.ts";

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
  },
): Html {
  const short = encodeURIComponent(shortRunId(run.id));
  const phase = prPhaseOf(doc);
  const tone =
    phase === "READY_TO_MERGE" || phase === "MERGED" ? "ok" : phase === "DECLINED" ? "bad" : "info";
  const open = doc ? doc.threads.filter((t) => !t.mine).length : undefined;
  const link = pr.url
    ? html`<a href="${pr.url}" rel="noreferrer noopener" target="_blank">PR #${pr.id ?? ""}</a>`
    : html`PR`;
  return html`<section class="panel pr-panel" aria-labelledby="pr-h" data-pr-panel>
<div class="pr-head"><h2 id="pr-h">${link} <span class="pill ${tone} mono">${phase}</span></h2><span class="hint mono">${pr.source} → <b>${pr.target}</b></span></div>
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

function commentHtml(c: PrComment, depth: number): Html {
  return html`<div class="pr-comment${c.mine ? " mine" : ""}" style="margin-left:${depth * 16}px">
<div class="hint"><b>${c.mine ? "Jarvis" : c.author}</b>${c.at ? html` · ${hhmm(c.at)}` : ""}</div>
<p class="pr-text">${c.text.replace(/<!--[\s\S]*?-->/g, "").trim()}</p>
${c.replies.map((r) => commentHtml(r, depth + 1))}
</div>`;
}

function threadHtml(th0: PrThread): Html {
  const where = th0.file ? `${th0.file}${th0.line ? `:${th0.line}` : ""}` : t("the PR as a whole");
  return html`<article class="panel pr-thread" data-thread="${th0.id}">
<div class="pr-thread-head"><span class="pill ${th0.task ? "wait" : ""}">${th0.task ? t("task") : t("comment")}</span><span class="mono hint">${where}</span></div>
${commentHtml(th0, 0)}
</article>`;
}

/** The code review page: the PR's open threads as the server has them, the newest read. */
export function prReviewPageHtml(run: Run, pr: Delivered, doc: PrReviewDoc | undefined, panel: Html): Html {
  const theirs = doc?.threads.filter((x) => !x.mine) ?? [];
  const mine = doc?.threads.filter((x) => x.mine) ?? [];
  return html`<div class="pr-review" style="display:flex;flex-direction:column;gap:16px">
<h1>${t("Code review")} <span class="hint mono">${run.task.split("\n")[0]}</span></h1>
${panel}
${
  !doc
    ? html`<p class="hint">${t("The PR has not been read yet: «Check comments» reads it now.")}</p>`
    : theirs.length === 0
      ? html`<p class="hint">${t("No open threads.")}</p>`
      : html`<h2>${t("Open threads")} <span class="hint">${theirs.length}</span></h2>${theirs.map(threadHtml)}`
}
${mine.length > 0 ? html`<details><summary>${t("Jarvis's own comments")} (${mine.length})</summary>${mine.map(threadHtml)}</details>` : ""}
<p class="hint">${pr.url ? html`<a href="${pr.url}" rel="noreferrer noopener" target="_blank">${t("Open in Bitbucket")}</a>` : ""}</p>
</div>`;
}

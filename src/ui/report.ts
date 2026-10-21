import type { BugReport, BugReportInput } from "../app/bugReport.ts";
import type { Run } from "../core/domain/run.ts";
import { shortRunId } from "../storage/runStore.ts";
import { type Html, html } from "./html.ts";
import { t, th } from "./i18n.ts";

/**
 * «Report a problem» (src/app/bugReport.ts): a form that becomes a GitHub issue. «Open the issue on
 * GitHub» goes to the repository's new-issue form filled in, in a new tab; «Show the text» shows it
 * here, to copy where GitHub cannot be reached. Plain GET forms: nothing changes in Jarvis.
 */
export interface ReportPage {
  readonly repo: string;
  readonly host: string;
  readonly run?: Run;
  readonly input?: BugReportInput;
  /** Shown after «Show the text». */
  readonly report?: BugReport;
  /** What the attachments would say, next to their boxes. */
  readonly env: string;
}

const checkbox = (name: string, on: boolean, label: Html | string, hint?: Html | string): Html =>
  html`<label class="check"><input type="checkbox" name="${name}" value="1"${on ? " checked" : ""}> ${label}${hint ? html` <span class="meta">— ${hint}</span>` : ""}</label>`;

export function reportContent(page: ReportPage): Html {
  const i = page.input;
  const run = page.run;
  const on = (k: keyof BugReportInput["include"], byDefault: boolean) => (i ? i.include[k] : byDefault);
  return html`<div class="lede"><h1>${t("Report a problem in Jarvis")}</h1></div>
<form class="panel report" method="get" action="/report/github" target="_blank">
${run ? html`<input type="hidden" name="run" value="${shortRunId(run.id)}">` : ""}
<p class="hint">${th("A new issue opens in {repo} on GitHub with this text filled in: read it there and submit it.", { repo: html`<code>${page.repo}</code>` })}</p>
<label class="field"><span>${t("In short, what is wrong")}</span><input type="text" name="title" required maxlength="200" value="${i?.title ?? ""}"></label>
<div class="rgrid">
<label class="field"><span>${t("What happened")}</span><textarea name="happened" rows="4" maxlength="4000">${i?.happened ?? ""}</textarea></label>
<label class="field"><span>${t("What you expected")}</span><textarea name="expected" rows="4" maxlength="4000">${i?.expected ?? ""}</textarea></label>
</div>
<label class="field"><span>${t("How to repeat")} <span class="hint">${t("optional")}</span></span><textarea name="steps" rows="3" maxlength="4000">${i?.steps ?? ""}</textarea></label>
<fieldset class="rattach"><legend>${t("Attach to the issue")}</legend>
${checkbox("env", on("env", true), t("Jarvis version, OS, Node"), html`<code>${page.env}</code>`)}
${
  run
    ? html`${checkbox("withRun", on("run", true), t("The run: workflow, step, state, reason"), html`<code>${run.workflow} · ${run.currentStep ?? "—"} · ${run.state}</code>`)}
${checkbox("errors", on("errors", true), t("The run's last errors, secrets masked"))}
${checkbox("task", on("task", false), t("The task's text"), html`<span class="warn">${t("may hold the company's data")}</span>`)}`
    : html`<p class="hint">${t("Opened from a run's page, the report can carry that run's step, state and errors.")}</p>`
}
</fieldset>
<div class="banner warn">${t("The issue is public. The company's code, paths and service names do not get into it unless you write them yourself.")}</div>
<div class="row ractions"><button type="submit" class="btn" formaction="/report" formtarget="_self" name="show" value="1">${t("Show the text")}</button><span class="grow"></span><button type="submit" class="btn primary">${t("Open the issue on GitHub")} ↗</button></div>
</form>
${
  page.report
    ? html`<section class="panel report" aria-labelledby="report-text"><div class="row"><h2 id="report-text" class="grow">${t("The issue's text")}</h2><button type="button" class="btn small" data-copy="${page.report.title}\n\n${page.report.body}">${t("Copy")}</button><a class="btn small" href="${page.report.url}" target="_blank" rel="noopener">${t("Open on GitHub")} ↗</a></div>
<p class="meta"><b>${page.report.title}</b></p>
<pre class="rtext">${page.report.body}</pre>
${page.report.shortened ? html`<p class="hint">${t("Too long for one address: GitHub gets it shortened. Copy the whole text into the issue.")}</p>` : ""}
</section>`
    : ""
}`;
}

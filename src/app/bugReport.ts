import { arch, platform, release } from "node:os";
import type { Run } from "../core/domain/run.ts";
import { shortRunId } from "../storage/runStore.ts";
import { packageInfo } from "../version.ts";
import type { Runtime } from "./runtime.ts";

/**
 * «Report a problem» in `jarvis ui`: the text of a GitHub issue about Jarvis and the address that opens
 * the repository's new-issue form filled with it (`/issues/new?title=…&body=…`). Nothing is sent from
 * here: the person reads it on GitHub and submits it there, as themselves. What goes in is what they
 * typed and what they ticked; the task's text only when asked for — it may be the company's — and the
 * whole text passes the Redactor first.
 */
export interface BugReportInput {
  readonly title: string;
  readonly happened: string;
  readonly expected: string;
  readonly steps: string;
  /** What to attach: the machine, the run, its recent errors, the task's text. */
  readonly include: {
    readonly env: boolean;
    readonly run: boolean;
    readonly errors: boolean;
    readonly task: boolean;
  };
  readonly run?: Run;
  readonly lang?: string;
}

export interface BugReport {
  readonly title: string;
  readonly body: string;
  /** The new-issue address, its body shortened to fit (`shortened`). */
  readonly url: string;
  readonly shortened: boolean;
}

/** Where the issue goes (`feedback` in the configuration). */
export interface FeedbackTarget {
  readonly host: string;
  readonly repo: string;
}

/** GitHub refuses longer addresses; the text in Cyrillic is about six characters a letter once encoded. */
const MAX_URL = 7500;
const ERRORS = 5;
const ERROR_KINDS = [
  "model.error",
  "step.error",
  "agent.error",
  "tool.error",
  "effect.failed",
  "delivery.failed",
];

/** The machine and the build the problem happened on. */
export function environmentLines(lang?: string): string[] {
  return [
    `- Jarvis ${packageInfo().version}`,
    `- ${platform()} ${release()}, ${arch()}, Node ${process.versions.node}`,
    ...(lang ? [`- UI language: ${lang}`] : []),
  ];
}

function runLines(run: Run): string[] {
  return [
    `- workflow: ${run.workflow}, step: ${run.currentStep ?? "—"}`,
    `- state: ${run.state}${run.stateReason ? ` — ${run.stateReason.slice(0, 300)}` : ""}`,
    `- run: ${shortRunId(run.id)}`,
  ];
}

/** The run's last errors, one line each: what failed and its message, newest last. */
export function recentErrors(runtime: Runtime, run: Run): string[] {
  const events = runtime.events.list({ runId: run.id }).filter((e) => ERROR_KINDS.includes(e.kind));
  return events.slice(-ERRORS).map((e) => {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const what = [p.modelId, p.stepId ?? e.stepId, p.capability]
      .filter((x) => typeof x === "string")
      .join(" ");
    const message = String(p.message ?? p.error ?? p.reason ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 240);
    return `${e.kind}${what ? ` ${what}` : ""}: ${message}`;
  });
}

function section(head: string, text: string): string[] {
  const t = text.trim();
  return t ? [`### ${head}`, t, ""] : [];
}

/** The issue's body as GitHub renders it (Markdown), before the Redactor. */
export function bugReportBody(runtime: Runtime, input: BugReportInput): string {
  const run = input.run;
  const errors = run && input.include.errors ? recentErrors(runtime, run) : [];
  return [
    ...section("What happened", input.happened),
    ...section("What was expected", input.expected),
    ...section("How to repeat", input.steps),
    ...(input.include.env ? ["### Environment", ...environmentLines(input.lang), ""] : []),
    ...(run && input.include.run ? ["### Run", ...runLines(run), ""] : []),
    ...(errors.length > 0 ? ["### Recent errors (secrets masked)", "```", ...errors, "```", ""] : []),
    ...(run && input.include.task ? ["### Task", run.task.slice(0, 1500), ""] : []),
    "---",
    "Sent from jarvis ui",
  ].join("\n");
}

/** The text and the address; the body masked and, when the address would be too long, shortened. */
export function bugReportOf(runtime: Runtime, target: FeedbackTarget, input: BugReportInput): BugReport {
  const title = runtime.redactor.redact(input.title.trim() || "A problem in Jarvis").text.slice(0, 200);
  const body = runtime.redactor.redact(bugReportBody(runtime, input)).text;
  const base = `${target.host.replace(/\/+$/, "")}/${target.repo}/issues/new`;
  const urlOf = (b: string) => `${base}?${new URLSearchParams({ title, body: b, labels: "bug" }).toString()}`;
  let url = urlOf(body);
  let cut = body.length;
  while (url.length > MAX_URL && cut > 200) {
    cut = Math.floor(cut * 0.85);
    url = urlOf(`${body.slice(0, cut)}\n\n… (shortened: the whole text is on the report page in jarvis ui)`);
  }
  return { title, body, url, shortened: cut < body.length };
}

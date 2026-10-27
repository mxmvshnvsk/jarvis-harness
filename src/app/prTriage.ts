import { z } from "zod";
import { type Actor, formatActor } from "../core/domain/actor.ts";
import type { Run } from "../core/domain/run.ts";
import { resolveModel } from "../models/router.ts";
import { generateStructured } from "../models/structured.ts";
import { runEffect } from "../orchestration/effects.ts";
import { HeldLease, leaseOwner } from "../orchestration/lease.ts";
import { effectMarker } from "../storage/effects.ts";
import { actingAs } from "../telemetry/events.ts";
import { git } from "../tools/local/exec.ts";
import type { ToolOutput } from "../tools/types.ts";
import { PR_REQUEST, prOf, requestOf } from "./deliver.ts";
import { type PrComment, type PrReviewDoc, type PrThread, prReviewOf } from "./prReview.ts";
import { originsOf, originsText } from "./requirementOrigins.ts";
import type { Runtime } from "./runtime.ts";

/**
 * The PR's comments weighed by the agent (the PR flow): for each new thread — agree, disagree, a
 * question, or nothing to do — with why, the reply drafted in the comment's language and, when it
 * agrees, what to change. One model call over the threads, the spec and the code at their lines.
 * What is said in the PR is the person's call when the agent disagrees: the reply goes out only from
 * the code review page («Send reply»); a reply always ends with the line that says Jarvis wrote it.
 */

export const PR_TRIAGE = "pr-triage";

export type Verdict = "agree" | "disagree" | "question" | "nothing";
/** Where a thread stands on Jarvis's side. */
export type ThreadState = "proposed" | "to-fix" | "fixing" | "fixed" | "replied" | "handled";

export interface TriageItem {
  readonly thread: number;
  /** The reviewer's comment the verdict is about: a newer one is weighed again. */
  readonly comment: number;
  readonly verdict: Verdict;
  readonly reason: string;
  readonly reply: string;
  readonly change?: string;
  readonly sources: readonly string[];
  readonly state: ThreadState;
  /** What was done and by whom: the reply sent, the fix asked, left to the person. */
  readonly done?: {
    readonly by: string;
    readonly at: string;
    readonly text?: string;
    readonly edited?: boolean;
  };
  /** The run that fixes it (`jarvis pr-fix`), and the commit it pushed. */
  readonly fix?: { readonly run: string; readonly commit?: string };
}

export interface TriageDoc {
  readonly items: readonly TriageItem[];
}

const Item = z.object({
  thread: z.number().int().describe("the thread's id as given"),
  verdict: z
    .enum(["agree", "disagree", "question", "nothing"])
    .describe(
      "agree: the comment is right and the code should change; disagree: the code is right as it is, with a reason from the spec, the task or the code; question: the reviewer asks something to be explained, not changed; nothing: thanks, an acknowledgement, already done",
    ),
  reason: z.string().describe("for the person: why, in one or two sentences, with where it stands"),
  reply: z
    .string()
    .describe(
      "the reply to post in the thread, in the comment's language, polite and short; for agree — what will change",
    ),
  change: z.string().optional().describe("for agree: what exactly to change in the code, file and place"),
  sources: z
    .array(z.string())
    .default([])
    .describe(
      "spec requirement ids, `path:line`, the issue key — for the record; the reply itself names pages, not ids",
    ),
});
const Items = z.object({ items: z.array(Item) });

/** The run's verdicts so far. */
export function triageOf(runtime: Runtime, run: Run): TriageDoc {
  const a = runtime.artifacts.listLatest(run.id, PR_TRIAGE)[0];
  if (!a) return { items: [] };
  try {
    return JSON.parse(runtime.artifacts.text(a)) as TriageDoc;
  } catch {
    return { items: [] };
  }
}

function save(runtime: Runtime, run: Run, doc: TriageDoc, by: "agent" | "person"): void {
  runtime.artifacts.put({
    runId: run.id,
    type: PR_TRIAGE,
    name: "pr-triage.json",
    content: JSON.stringify(doc, null, 2),
    mediaType: "application/json",
    provenance:
      by === "agent"
        ? { kind: "agent", agentId: "pr-comments" }
        : { kind: "tool", capability: "ui.pr-reply" },
    stepId: "pr",
  });
}

/** The thread's latest comment from a reviewer (not Jarvis's), and whether Jarvis answered after it. */
export function lastTheirs(thread: PrThread): { comment: PrComment; answered: boolean } | undefined {
  const flat: PrComment[] = [];
  const walk = (c: PrComment) => {
    flat.push(c);
    for (const r of c.replies) walk(r);
  };
  walk(thread);
  const sorted =
    flat.filter((c) => c.at).length === flat.length
      ? [...flat].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""))
      : flat;
  const theirs = sorted.filter((c) => !c.mine);
  const last = theirs.at(-1);
  if (!last) return undefined;
  return { comment: last, answered: sorted.indexOf(last) < sorted.length - 1 && !!sorted.at(-1)?.mine };
}

/** Threads to weigh: a reviewer's comment not weighed yet, and not answered by Jarvis after it. */
export function threadsToWeigh(review: PrReviewDoc, triage: TriageDoc): PrThread[] {
  return review.threads.filter((t) => {
    if (t.mine || t.bot) return false;
    const last = lastTheirs(t);
    if (!last || last.answered) return false;
    const known = triage.items.find((i) => i.thread === t.id);
    return !known || known.comment !== last.comment.id;
  });
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n…` : s);

/** The code at a thread's line on the run's branch: ±20 lines, numbered. */
async function codeAt(run: Run, file: string, line: number | undefined): Promise<string> {
  const ref = run.workspace.branch ?? "HEAD";
  const r = await git(["show", `${ref}:${file}`], run.workspace.repoRoot);
  if (r.code !== 0) return "(the file is not on the run's branch)";
  const lines = r.stdout.split("\n");
  const at = line ?? 1;
  const from = Math.max(1, at - 20);
  return lines
    .slice(from - 1, at + 20)
    .map((l, i) => `${String(from + i).padStart(5)}${from + i === at ? ">" : " "} ${l}`)
    .join("\n");
}

function roleFor(runtime: Runtime): string {
  for (const role of ["review", "research", "implementation"])
    if (runtime.loaded.config.roles[role]) return role;
  return "research";
}

/** The plain text of a comment: Jarvis's marks taken out. */
export function commentText(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\[jarvis:run=[^\]]*\]/g, "")
    .trim();
}

/**
 * Weighs the threads not weighed yet: the verdicts join the run's `pr-triage`, the feed says how many
 * of each. With `delivery.flow.fixWhenAgreed` an agreed thread is to be fixed at once; else it waits
 * for the person too.
 */
export async function triagePr(runtime: Runtime, run: Run, review: PrReviewDoc): Promise<TriageItem[]> {
  const before = triageOf(runtime, run);
  const threads = threadsToWeigh(review, before);
  if (threads.length === 0) return [];
  const spec = runtime.artifacts.listLatest(run.id, "spec")[0];
  const impl = runtime.artifacts.listLatest(run.id, "implementation")[0];
  const origins = originsOf(runtime, run);
  const shown = await Promise.all(
    threads.map(async (t) => {
      const talk: string[] = [];
      const walk = (c: PrComment, depth: number) => {
        talk.push(`${"  ".repeat(depth)}- ${c.mine ? "Jarvis" : c.author}: ${commentText(c.text)}`);
        for (const r of c.replies) walk(r, depth + 1);
      };
      walk(t, 0);
      const where = t.file ? `${t.file}${t.line ? `:${t.line}` : ""}` : "the PR as a whole";
      const code = t.file ? `\n\`\`\`\n${await codeAt(run, t.file, t.line)}\n\`\`\`` : "";
      return `## Thread ${t.id} — ${where}${t.task ? " (a task)" : ""}\n${talk.join("\n")}${code}`;
    }),
  );
  const route = resolveModel(
    runtime.loaded.config,
    roleFor(runtime),
    { structuredOutput: "json" },
    { probes: runtime.probes },
  );
  const result = await generateStructured(runtime.gateway, {
    modelId: route.modelId,
    mode: route.structuredMode,
    name: "pr-comments",
    schema: Items,
    messages: [
      {
        role: "system",
        content: [
          "# Jarvis: the comments of a pull request",
          "The PR below was made by Jarvis for the task and approved by a developer. Reviewers left comments. For each thread decide whether the code should change.",
          "Rules:",
          "- agree when the comment is right: a bug, a missed case, the team's convention, a clearer name. Say what to change, exactly.",
          "- disagree only with a reason that stands: the spec or the task says so, the code already handles it (`path:line`), the change is out of the task's scope. Never disagree because a change is work.",
          "- question when the reviewer asks to explain, not to change: the reply explains — from the code, with `path:line` of what you read; the task or the contract says what was meant, not what the code does (pilot: «the middle expects these fields» answered with the contract, when the middle's code showed it).",
          "- A tool's comment (a scanner's summary, a code-owners notice) is nothing, with no reply.",
          "- nothing for thanks, an acknowledgement, or what is already done.",
          "- The reply goes to the reviewer: their language, polite, short, no apologies, no praise of the comment. Never promise what agree does not change.",
          "- A reply that rests on a requirement never names the spec's ids (R1, R2…): the reviewers do not have them. Say where it was asked and who confirmed it, from «Where the spec's requirements came from»: the page or the issue as a link, the section, its words; then what was decided when the spec was accepted (the answer and who gave it), if anything; then what the code does because of it; and end a disagree with a question whether they object. For example: «В [Требования к форме](link), п. 3.2, просили «убрать поле ИНН». При согласовании спецификации Иван Петров подтвердил: «ИНН больше не нужен». Поэтому поле удалено. Есть возражения?». A requirement no page or issue says: say it was decided when the spec was accepted, by whom — or that it was the analysis' own conclusion; never invent a page.",
          '- Quote with «» and never with ".',
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `# Task ${run.task}`,
          spec ? `# Spec\n${clip(runtime.artifacts.text(spec), 12_000)}` : "",
          origins ? originsText(origins) : "",
          impl ? `# What was implemented\n${clip(runtime.artifacts.text(impl), 4_000)}` : "",
          `# Threads\n${shown.join("\n\n")}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      { role: "user", content: "Answer with the JSON document now: an item per thread." },
    ],
    request: {
      role: roleFor(runtime),
      agentId: "pr-comments",
      temperature: 0,
      runId: run.id,
      reasoningEffort: "low",
    },
  });
  const fixAtOnce = runtime.loaded.config.delivery.flow.fixWhenAgreed;
  const fresh: TriageItem[] = [];
  for (const t of threads) {
    const v = result.value.items.find((i) => i.thread === t.id);
    if (!v) continue;
    const last = lastTheirs(t);
    fresh.push({
      thread: t.id,
      comment: last?.comment.id ?? t.id,
      verdict: v.verdict,
      reason: v.reason,
      reply: v.reply,
      ...(v.change ? { change: v.change } : {}),
      sources: v.sources,
      state: v.verdict === "agree" && fixAtOnce ? "to-fix" : "proposed",
    });
  }
  const items = [...before.items.filter((i) => !fresh.some((f) => f.thread === i.thread)), ...fresh];
  save(runtime, run, { items }, "agent");
  const count = (v: Verdict) => fresh.filter((f) => f.verdict === v).length;
  runtime.events.emit({
    kind: "pr.triaged",
    runId: run.id,
    payload: {
      agree: count("agree"),
      disagree: count("disagree"),
      question: count("question"),
      nothing: count("nothing"),
    },
  });
  return fresh;
}

export class ReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyError";
  }
}

/** Threads moved on by the fix run: being fixed by it, or fixed in its commit. */
export function markThreads(
  runtime: Runtime,
  run: Run,
  threads: readonly number[],
  state: "fixing" | "fixed" | "to-fix",
  fix?: TriageItem["fix"],
): void {
  const doc = triageOf(runtime, run);
  const items = doc.items.map((i) =>
    threads.includes(i.thread) ? { ...i, state, ...(fix ? { fix } : {}) } : i,
  );
  save(runtime, run, { items }, "agent");
}

/** The threads to fix now: the agent agreed (with fixWhenAgreed) or the person asked. */
export function threadsToFix(runtime: Runtime, run: Run): TriageItem[] {
  return triageOf(runtime, run).items.filter((i) => i.state === "to-fix");
}

/** The line that ends a reply: Jarvis wrote it, and how the person took part. */
export function footerOf(text: string, who: string, edited: boolean): string {
  const ru = /[а-яё]/i.test(text);
  if (ru) return edited ? `— Jarvis, текст поправил ${who}` : `— Jarvis, ответ согласован с ${who}`;
  return edited ? `— Jarvis, edited by ${who}` : `— Jarvis, agreed with ${who}`;
}

/**
 * What the person decided on a thread on the code review page: `send` — the reply posted in the
 * thread (an effect under the journal: a second try does not post twice), `fix` — the code is to
 * change after all, `self` — the person answers in Bitbucket, `skip` — nothing to do.
 */
export async function decideThread(
  runtime: Runtime,
  run: Run,
  thread: number,
  action: "send" | "fix" | "self" | "skip",
  actor: Actor,
  text?: string,
): Promise<TriageItem> {
  const doc = triageOf(runtime, run);
  const item = doc.items.find((i) => i.thread === thread);
  if (!item) throw new ReplyError(`thread ${thread} has not been weighed`);
  const who = actor.display ?? actor.id;
  const at = new Date().toISOString();
  let next: TriageItem;
  if (action === "send") {
    const body = (text ?? item.reply).trim();
    if (!body) throw new ReplyError("the reply is empty");
    const edited = body !== item.reply.trim();
    await postReply(runtime, run, thread, `${body}\n\n${footerOf(body, who, edited)}`, actor);
    next = {
      ...item,
      state: "replied",
      done: { by: formatActor(actor), at, text: body, ...(edited ? { edited } : {}) },
    };
  } else {
    next = {
      ...item,
      state: action === "fix" ? "to-fix" : "handled",
      done: { by: formatActor(actor), at },
    };
  }
  save(runtime, run, { items: doc.items.map((i) => (i.thread === thread ? next : i)) }, "person");
  runtime.events.emit({
    kind: "pr.threadDecided",
    runId: run.id,
    actor: formatActor(actor),
    payload: { thread, action, verdict: item.verdict },
  });
  return next;
}

/** A reply in a thread of the run's PR, as the person (their token): an effect under the journal. */
async function postReply(
  runtime: Runtime,
  run: Run,
  thread: number,
  content: string,
  actor: Actor,
): Promise<void> {
  const pr = prOf(runtime, run);
  if (!pr?.id) throw new ReplyError("the run has no PR");
  const capability = runtime.registry.get("bitbucket.pr.comment");
  if (!capability || !runtime.tools.policy(capability, ["*"]).allowed)
    throw new ReplyError("bitbucket.pr.comment is not allowed: add it to the Bitbucket server's allow");
  const reqArtifact = runtime.artifacts.listLatest(run.id, PR_REQUEST)[0];
  const request = reqArtifact ? requestOf(runtime, reqArtifact) : undefined;
  const args = {
    ...(request?.workspace ? { workspace: request.workspace } : {}),
    ...(request?.repo ? { repo: request.repo } : {}),
    id: pr.id,
    parent: thread,
    content,
  };
  const lease = HeldLease.acquire(runtime.runs, run.id, leaseOwner("cli"), { heartbeatMs: 0 });
  if (!lease) throw new ReplyError("the run is being executed elsewhere: reply once it stops");
  // one effect per reply: the thread and how many replies Jarvis sent in it before
  const sent = runtime.effects.byRun(run.id).filter((e) => e.stepId === `pr-reply-${thread}`).length;
  try {
    await actingAs({ actor: formatActor(actor) }, () =>
      runEffect<ToolOutput>(runtime.effects, lease, runtime.events, {
        runId: run.id,
        stepId: `pr-reply-${thread}`,
        iteration: 1,
        capability: capability.name,
        args,
        seq: sent,
        execute: async (record) => {
          const out = await capability.handler(args, {
            run,
            stepId: `pr-reply-${thread}`,
            iteration: 1,
            lease,
            workspacePath: run.workspace.repoRoot,
            runtime,
            redactor: runtime.redactor,
            pathPolicy: runtime.pathPolicy,
            env: runtime.env,
            effect: { key: record.key, marker: effectMarker(run.id, record.key) },
          });
          if (!out.ok) throw new ReplyError(`the reply was not posted: ${out.error ?? out.text ?? "?"}`);
          return out;
        },
      }),
    );
  } finally {
    lease.release();
  }
}

export { prReviewOf };

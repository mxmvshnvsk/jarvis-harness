import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Runtime } from "../app/runtime.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import { resolveModel } from "../models/router.ts";
import { generateStructured } from "../models/structured.ts";

/**
 * Answers to a document's open questions, prepared before its approval gate (pilot: eight questions of
 * a spec sat in a side column, and answering them took a person reading Jira, two Confluence pages,
 * the design and the code). One model call over what the run already collected — the issue, its
 * pages and frames (`sources`, `design`), the research, the requirements — proposes per question an
 * answer with where it stands, or, when the sources do not say, the options to choose from. Checked
 * in code: a source must name something the run actually has, else the answer is a guess.
 */
export const SUGGESTIONS = "answer-suggestions";
export const ANSWERS = "answers";

const Suggestion = z.object({
  question: z.number().int().min(1).describe("the 1-based number of the open question"),
  about: z
    .array(z.string())
    .default([])
    .describe("requirement ids (R2) or two-word topics the question touches"),
  kind: z
    .enum(["answer", "decision", "unknown"])
    .describe(
      "answer: the sources settle it; decision: they do not, and it is the team's call between options; unknown: only someone else can say (an analyst, legal, another team)",
    ),
  answer: z.string().optional().describe("for answer: stated so the document can use it as is"),
  options: z
    .array(
      z.object({
        text: z.string().min(1),
        note: z.string().default("").describe("what follows from it, in a few words"),
        suggested: z.boolean().default(false),
      }),
    )
    .default([])
    .describe("for decision: 2–3 options, at most one suggested"),
  sources: z
    .array(z.string())
    .default([])
    .describe(
      "exactly where: the page id and its section, the issue key, `path:line`, the Figma node id — as they appear in the material",
    ),
});
const Suggestions = z.object({ suggestions: z.array(Suggestion) });
type SuggestionT = z.infer<typeof Suggestion>;

export interface QuestionSuggestion {
  readonly question: string;
  readonly about: readonly string[];
  readonly kind: "answer" | "decision" | "unknown";
  readonly answer?: string;
  readonly options: ReadonlyArray<{
    readonly text: string;
    readonly note: string;
    readonly suggested: boolean;
  }>;
  /** Sources that name something the run has. */
  readonly sources: readonly string[];
  /** An answer none of whose sources checked out: shown as a guess, not picked. */
  readonly unbacked?: boolean;
}

export interface SuggestionsDoc {
  /** `artifactId@version` of the document asked about. */
  readonly for: string;
  readonly items: readonly QuestionSuggestion[];
}

const MATERIAL: ReadonlyArray<readonly [string, number]> = [
  ["sources", 40_000],
  ["design", 15_000],
  ["research", 20_000],
  ["requirements", 12_000],
  ["clarification", 4_000],
];

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max)}\n…[cut]`);

/** The open questions of a JSON document, if any. */
export function openQuestionsOf(text: string): string[] {
  try {
    const doc = JSON.parse(text) as { openQuestions?: unknown };
    return Array.isArray(doc.openQuestions)
      ? doc.openQuestions.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

/** What in a source can be checked: page and node ids, issue keys, paths. */
function anchorsOf(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g)) out.add(m[0]);
  for (const m of source.matchAll(/\b\d{4,}(?:[-:]\d+)?\b/g)) out.add(m[0]);
  for (const m of source.matchAll(/[\w.@-]+(?:\/[\w.@-]+)+\.\w+/g)) out.add(m[0]);
  return [...out];
}

/** A source names something the material has (or a file of the checkout): not made up. */
function backed(source: string, material: string, root: string): boolean {
  const anchors = anchorsOf(source);
  if (anchors.length === 0) return false;
  return anchors.every((a) => {
    if (material.includes(a) || material.includes(a.replace("-", ":"))) return true;
    return a.includes("/") && existsSync(join(root, a));
  });
}

export function checkSuggestions(
  questions: readonly string[],
  raw: readonly SuggestionT[],
  material: string,
  root: string,
): QuestionSuggestion[] {
  return questions.map((question, i) => {
    const s = raw.find((x) => x.question === i + 1);
    if (!s) return { question, about: [], kind: "unknown", options: [], sources: [] };
    const sources = s.sources.filter((x) => backed(x, material, root));
    const options = s.options.slice(0, 4).map((o, k, all) => ({
      text: o.text,
      note: o.note,
      // one suggestion at most: the first marked
      suggested: o.suggested && all.findIndex((x) => x.suggested) === k,
    }));
    if (s.kind === "answer" && s.answer && sources.length === 0)
      return {
        question,
        about: s.about,
        kind: "unknown",
        answer: s.answer,
        options,
        sources,
        unbacked: true,
      };
    if (s.kind === "decision" && options.length < 2)
      return { question, about: s.about, kind: "unknown", options: [], sources };
    return {
      question,
      about: s.about.slice(0, 4),
      kind: s.kind,
      ...(s.answer && s.kind === "answer" ? { answer: s.answer } : {}),
      options: s.kind === "decision" ? options : [],
      sources,
    };
  });
}

/** The suggestions prepared for this version of a document, if any. */
export function suggestionsFor(runtime: Runtime, doc: ArtifactVersion): SuggestionsDoc | undefined {
  const ref = `${doc.artifactId}@${doc.version}`;
  const found = runtime.artifacts.listLatest(doc.runId, SUGGESTIONS).find((a) => a.sourceRefs.includes(ref));
  if (!found) return undefined;
  try {
    return JSON.parse(runtime.artifacts.text(found)) as SuggestionsDoc;
  } catch {
    return undefined;
  }
}

/**
 * Before the gate of `doc`: suggestions for its open questions, once per version. Never fails the
 * gate — without them the page asks the questions plainly.
 */
export async function prepareSuggestions(
  runtime: Runtime,
  run: Run,
  doc: ArtifactVersion,
  stepId: string,
): Promise<SuggestionsDoc | undefined> {
  const text = runtime.artifacts.text(doc);
  const questions = openQuestionsOf(text);
  if (questions.length === 0 || runtime.loaded.config.human.suggestAnswers === false) return undefined;
  const existing = suggestionsFor(runtime, doc);
  if (existing) return existing;
  const material = MATERIAL.flatMap(([type, max]) =>
    runtime.artifacts
      .listLatest(run.id, type)
      .slice(0, type === "clarification" ? 4 : 1)
      .map((a) => `## ${a.type}/${a.name}\n${clip(runtime.artifacts.text(a), max)}`),
  ).join("\n\n");
  const started = Date.now();
  try {
    const route = resolveModel(runtime.loaded.config, "research", { structuredOutput: "json" });
    const result = await generateStructured(runtime.gateway, {
      modelId: route.modelId,
      mode: route.structuredMode,
      name: "answer-suggestions",
      schema: Suggestions,
      messages: [
        {
          role: "system",
          content: [
            "# Jarvis: answers to a document's open questions",
            "A person is about to approve the document below. Prepare an answer for each of its open questions from the material, so they decide in seconds.",
            "Rules:",
            "- Answer only from the material. Every answer names exactly where it stands (page id and section, issue key, `path:line`, Figma node id). No source — not an answer.",
            "- When sources disagree, say which one you follow and why (a table over an example, a later page over an earlier one).",
            "- When the material does not settle it but the team can decide: kind decision, 2–3 options with what follows from each; mark as suggested the one that keeps today's behaviour or is clearly safer.",
            "- When only someone else can say (an analyst, legal, another team's contract): kind unknown.",
            '- Short and concrete; write in the language of the questions; quote with «» and never with ".',
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `# Task ${run.task}`,
            `# The document: ${doc.type}/${doc.name}@${doc.version}\n${clip(text, 20_000)}`,
            `# Open questions\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
            `# Material the run collected\n${material}`,
          ].join("\n\n"),
        },
        { role: "user", content: "Answer with the JSON document now." },
      ],
      request: { role: "research", agentId: "answers", temperature: 0, runId: run.id },
    });
    const items = checkSuggestions(
      questions,
      result.value.suggestions,
      `${material}\n${text}`,
      run.workspace.path,
    );
    const body: SuggestionsDoc = { for: `${doc.artifactId}@${doc.version}`, items };
    runtime.artifacts.put({
      runId: run.id,
      type: SUGGESTIONS,
      name: `${doc.type}.json`,
      content: JSON.stringify(body, null, 2),
      mediaType: "application/json",
      provenance: { kind: "agent", agentId: "answers" },
      sourceRefs: [body.for],
      stepId,
    });
    runtime.events.emit({
      kind: "answers.suggested",
      runId: run.id,
      stepId,
      payload: {
        for: body.for,
        questions: questions.length,
        answers: items.filter((x) => x.kind === "answer").length,
        decisions: items.filter((x) => x.kind === "decision").length,
        unbacked: items.filter((x) => x.unbacked).length,
        ms: Date.now() - started,
      },
    });
    return body;
  } catch (error) {
    runtime.events.emit({
      kind: "answers.failed",
      runId: run.id,
      stepId,
      payload: {
        for: `${doc.artifactId}@${doc.version}`,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return undefined;
  }
}

/** How a person answered one question on the page. */
export interface GivenAnswer {
  readonly question: string;
  readonly mode: "answer" | "analyst" | "scope";
  readonly text?: string;
}

/** The answers as they go back with «Send back»: binding for the document's next version. */
export function answersText(answers: readonly GivenAnswer[]): string {
  const lines = answers.map((a, i) => {
    const n = `${i + 1}.`;
    if (a.mode === "analyst")
      return `${n} ${a.question}\n   → open, for the analyst: keep it as a risk, do not decide it.`;
    if (a.mode === "scope") return `${n} ${a.question}\n   → out of the task's scope: drop it.`;
    return `${n} ${a.question}\n   → ${a.text ?? ""}`;
  });
  return `Answers to the open questions (binding for the next version):\n${lines.join("\n")}`;
}

/** The answers a person gave on this version of a document (the page's «Send back» or «Accept»). */
export function givenFor(runtime: Runtime, doc: ArtifactVersion): GivenAnswer[] | undefined {
  const ref = `${doc.artifactId}@${doc.version}`;
  const found = runtime.artifacts.listLatest(doc.runId, ANSWERS).find((a) => a.sourceRefs.includes(ref));
  if (!found) return undefined;
  try {
    return (JSON.parse(runtime.artifacts.text(found)) as { answers: GivenAnswer[] }).answers;
  } catch {
    return undefined;
  }
}

/**
 * What the form sent for each question (`qa-<n>`: jarvis | opt-<k> | own | analyst | scope, the own text
 * in `qa-text-<n>`), read against the document and its suggestions — nothing of the question's text is
 * taken from the form. Questions left without an answer are not in the list.
 */
export function givenFromForm(
  questions: readonly string[],
  suggestions: SuggestionsDoc | undefined,
  get: (key: string) => string | null,
): GivenAnswer[] {
  const out: GivenAnswer[] = [];
  questions.forEach((question, i) => {
    const n = i + 1;
    const mode = get(`qa-${n}`);
    const s = suggestions?.items[i];
    const own = (get(`qa-text-${n}`) ?? "").trim().slice(0, 4000);
    if (mode === "analyst" || mode === "scope") out.push({ question, mode });
    else if (mode === "jarvis" && s?.answer) out.push({ question, mode: "answer", text: s.answer });
    else if (mode?.startsWith("opt-")) {
      const o = s?.options[Number(mode.slice(4))];
      if (o) out.push({ question, mode: "answer", text: o.text });
    } else if (own) out.push({ question, mode: "answer", text: own });
  });
  return out;
}

/** The answers on the record, next to the version they answer: binding context and an eval's gold. */
export function recordGiven(
  runtime: Runtime,
  doc: ArtifactVersion,
  answers: readonly GivenAnswer[],
  actorId: string,
  stepId?: string,
): void {
  if (answers.length === 0) return;
  runtime.artifacts.put({
    runId: doc.runId,
    type: ANSWERS,
    name: `${doc.type}.json`,
    content: JSON.stringify({ for: `${doc.artifactId}@${doc.version}`, answers, by: actorId }, null, 2),
    mediaType: "application/json",
    provenance: { kind: "human", actor: { kind: "user", id: actorId, verified: false } },
    sourceRefs: [`${doc.artifactId}@${doc.version}`],
    ...(stepId ? { stepId } : {}),
  });
}

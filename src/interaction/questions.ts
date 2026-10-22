import { z } from "zod";
import { type FrameName, humanizeNodeIds } from "../design/frames.ts";

/**
 * An open question of a document, as a person at the gate reads it: what is asked, about what — the
 * screen by its title, the field by its label —, and the answers in sight. Ids are for the tools.
 * A plain string is still a question (documents before this, and short ones).
 */
export const OpenQuestion = z.union([
  z.string().min(1),
  z.object({
    question: z
      .string()
      .min(1)
      .describe("asked so a person can answer it without opening any tool: no node ids, no requirement ids"),
    about: z
      .string()
      .optional()
      .describe(
        "what it is about as a person sees it: the screen by its title, the field by its label, the text in «»",
      ),
    options: z.array(z.string().min(1)).optional().describe("the answers you see, each a short full phrase"),
    refs: z
      .array(z.string())
      .optional()
      .describe("for the tools: Figma node ids, requirement ids, paths — never in the question"),
  }),
]);
export type OpenQuestionT = z.infer<typeof OpenQuestion>;

/** The question as one line for a person: the question, what it is about, the options. */
export function questionText(
  q: unknown,
  names: ReadonlyMap<string, FrameName> = new Map(),
): string | undefined {
  if (typeof q === "string") return q.trim() ? humanizeNodeIds(q.trim(), names) : undefined;
  if (!q || typeof q !== "object") return undefined;
  const o = q as { question?: unknown; about?: unknown; options?: unknown };
  const question = typeof o.question === "string" ? o.question.trim() : "";
  if (!question) return undefined;
  const about = typeof o.about === "string" ? o.about.trim() : "";
  const options = Array.isArray(o.options)
    ? o.options.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  const line = [
    question,
    about && !question.includes(about) ? ` (${about})` : "",
    options.length > 0 ? ` — ${options.map((x) => x.trim()).join(" / ")}` : "",
  ].join("");
  return humanizeNodeIds(line, names);
}

/** A document's `openQuestions`, strings or objects, as lines. */
export function questionsOf(value: unknown, names?: ReadonlyMap<string, FrameName>): string[] {
  return Array.isArray(value)
    ? value.map((q) => questionText(q, names)).filter((q): q is string => q !== undefined)
    : [];
}

/** A question as the page asks it: its line (the question's identity), the question alone, its options. */
export interface QuestionDetail {
  readonly line: string;
  /** The question with what it is about, without the options. */
  readonly head: string;
  readonly options: readonly string[];
}

/**
 * A question kept as one line («question (about) — A / B / C», documents before the questions were kept
 * whole): its options taken back, when the line reads so — the question ends with «?» or «)» and two or
 * more options follow.
 */
function splitLine(line: string): { head: string; options: string[] } {
  const m = /^(.*?[?)]) — (.+)$/s.exec(line);
  const options = m ? (m[2] as string).split(" / ").map((x) => x.trim()) : [];
  return m && options.length >= 2 && options.every(Boolean)
    ? { head: m[1] as string, options }
    : { head: line, options: [] };
}

/** A document's `openQuestions` with their options apart, for a page to offer them as choices. */
export function questionDetailsOf(
  value: unknown,
  names: ReadonlyMap<string, FrameName> = new Map(),
): QuestionDetail[] {
  if (!Array.isArray(value)) return [];
  const out: QuestionDetail[] = [];
  for (const q of value) {
    const line = questionText(q, names);
    if (line === undefined) continue;
    if (typeof q === "string") {
      out.push({ line, ...splitLine(line) });
      continue;
    }
    const o = q as { question?: unknown; about?: unknown; options?: unknown };
    const question = String(o.question).trim();
    const about = typeof o.about === "string" ? o.about.trim() : "";
    const head = humanizeNodeIds(
      `${question}${about && !question.includes(about) ? ` (${about})` : ""}`,
      names,
    );
    const options = Array.isArray(o.options)
      ? o.options
          .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          .map((x) => humanizeNodeIds(x.trim(), names))
      : [];
    out.push({ line, head, options });
  }
  return out;
}

/** A question kept whole, its words for people: frame ids as titles; the ids for the tools stay. */
export function questionForPeople(q: unknown, names: ReadonlyMap<string, FrameName>): unknown {
  if (typeof q === "string") return humanizeNodeIds(q, names);
  if (!q || typeof q !== "object") return q;
  const o = q as Record<string, unknown>;
  const h = (v: unknown) => (typeof v === "string" ? humanizeNodeIds(v, names) : v);
  return {
    ...o,
    question: h(o.question),
    ...(o.about !== undefined ? { about: h(o.about) } : {}),
    ...(Array.isArray(o.options) ? { options: o.options.map(h) } : {}),
  };
}

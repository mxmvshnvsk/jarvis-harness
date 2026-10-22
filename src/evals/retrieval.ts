import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { Runtime } from "../app/runtime.ts";
import type { RetrievalResult } from "../knowledge/retrieval/retriever.ts";
import { projectKeyOf, search } from "../knowledge/retrieval/service.ts";
import type { KnowledgeRoots } from "../knowledge/standards.ts";

/**
 * Retrieval evals (ADR-0015 §6): labelled cases «query → refs that must be found», run against the
 * current index, measured as Recall@5/@10, MRR, the irrelevant-context ratio and retrieved tokens.
 * This is the gate before embeddings or a reranker: Required-source Recall@10 below the target
 * and misses that are a language gap, not a hole in FTS or the graph.
 */
export const RETRIEVAL_TARGET = 0.9;
export const DEFAULT_CASES_FILE = "evals/retrieval/cases.yaml";

const CaseSchema = z.strictObject({
  id: z.string().min(1),
  query: z.string().min(1),
  /** Refs as search returns them, or shorter: `src/a.ts` (any unit of it), `src/a.ts:42`, `knowledge:onboarding`. */
  expected: z.array(z.string().min(1)).min(1),
});
const CasesFileSchema = z.strictObject({ cases: z.array(CaseSchema).min(1) });
export type RetrievalCase = z.infer<typeof CaseSchema>;

export interface CaseScore {
  readonly id: string;
  readonly query: string;
  readonly expected: string[];
  /** Expected refs found in the top 5 / top 10, as shares. */
  readonly recallAt5: number;
  readonly recallAt10: number;
  /** 1 / rank of the first relevant hit; 0 when none is in the list. */
  readonly reciprocalRank: number;
  /** Share of the top 10 that answers none of the expected refs. */
  readonly irrelevant: number;
  /** Tokens (chars / 4) of the top 10 units: what a model would read. */
  readonly tokens: number;
  readonly missed: string[];
  readonly top: string[];
  readonly expansions: string[];
}

export interface RetrievalSummary {
  readonly cases: number;
  readonly recallAt5: number;
  readonly recallAt10: number;
  readonly mrr: number;
  readonly irrelevantRatio: number;
  readonly retrievedTokens: number;
  /** §6: Required-source Recall@10 against the target. */
  readonly gate: { readonly target: number; readonly passed: boolean };
}

export interface RetrievalEvalResult {
  readonly suite: "retrieval";
  readonly at: string;
  readonly glossary: boolean;
  readonly indexes: string[];
  readonly cases: CaseScore[];
  readonly summary: RetrievalSummary;
}

export function loadRetrievalCases(file: string): RetrievalCase[] {
  if (!existsSync(file)) throw new Error(`no retrieval cases at ${file}`);
  return CasesFileSchema.parse(parse(readFileSync(file, "utf8"))).cases;
}

/** Whether a retrieved ref answers an expected one: the same unit, a unit of that file, or the line in it. */
export function refMatches(ref: string, expected: string): boolean {
  if (ref === expected || ref === `${expected}.md`) return true;
  if (ref.startsWith(`${expected}:`) || ref.startsWith(`${expected}@`) || ref.startsWith(`${expected}#`))
    return true;
  const line = /^(.+):(\d+)$/.exec(expected);
  const range = /^(.+):(\d+)-(\d+)$/.exec(ref);
  if (line && range && line[1] === range[1]) {
    const n = Number(line[2]);
    return n >= Number(range[2]) && n <= Number(range[3]);
  }
  return false;
}

const round = (x: number) => Number(x.toFixed(4));
const mean = (xs: readonly number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** The scores of one case from what retrieval returned, best first. */
export function scoreCase(
  c: RetrievalCase,
  result: Pick<RetrievalResult, "evidence" | "expansions">,
  sizes: ReadonlyMap<string, number> = new Map(),
): CaseScore {
  const refs = result.evidence.map((e) => e.ref);
  const found = (k: number) => c.expected.filter((x) => refs.slice(0, k).some((r) => refMatches(r, x)));
  const first = refs.findIndex((r) => c.expected.some((x) => refMatches(r, x)));
  const top10 = result.evidence.slice(0, 10);
  const irrelevant = top10.filter((e) => !c.expected.some((x) => refMatches(e.ref, x))).length;
  return {
    id: c.id,
    query: c.query,
    expected: c.expected,
    recallAt5: round(found(5).length / c.expected.length),
    recallAt10: round(found(10).length / c.expected.length),
    reciprocalRank: first < 0 ? 0 : round(1 / (first + 1)),
    irrelevant: top10.length === 0 ? 0 : round(irrelevant / top10.length),
    tokens: Math.ceil(top10.reduce((n, e) => n + (sizes.get(e.sourceId) ?? 0), 0) / 4),
    missed: c.expected.filter((x) => !found(10).includes(x)),
    top: refs.slice(0, 10),
    expansions: result.expansions.map((x) => `${x.term} → ${x.added.join(", ")}`),
  };
}

export function summarize(scores: readonly CaseScore[], target = RETRIEVAL_TARGET): RetrievalSummary {
  const recallAt10 = round(mean(scores.map((s) => s.recallAt10)));
  return {
    cases: scores.length,
    recallAt5: round(mean(scores.map((s) => s.recallAt5))),
    recallAt10,
    mrr: round(mean(scores.map((s) => s.reciprocalRank))),
    irrelevantRatio: round(mean(scores.map((s) => s.irrelevant))),
    retrievedTokens: Math.round(mean(scores.map((s) => s.tokens))),
    gate: { target, passed: recallAt10 >= target },
  };
}

/** Runs every case against the index as it is (refresh it first), as agents search. */
export async function runRetrievalEval(
  runtime: Runtime,
  roots: KnowledgeRoots,
  cases: readonly RetrievalCase[],
  options: { glossary?: boolean; at?: Date } = {},
): Promise<RetrievalEvalResult> {
  const scores: CaseScore[] = [];
  let indexes: string[] = [];
  for (const c of cases) {
    const result = await search(runtime, roots, c.query, {
      limit: 10,
      ...(options.glossary === false ? { glossary: false } : {}),
    });
    indexes = result.indexes;
    scores.push(
      scoreCase(
        c,
        result,
        runtime.index.sizes(
          result.evidence.map((e) => e.sourceId),
          projectKeyOf(roots),
        ),
      ),
    );
  }
  return {
    suite: "retrieval",
    at: (options.at ?? new Date()).toISOString(),
    glossary: options.glossary !== false,
    indexes,
    cases: scores,
    summary: summarize(scores),
  };
}

const HIGHER_IS_BETTER = ["recallAt5", "recallAt10", "mrr"] as const;
const LOWER_IS_BETTER = ["irrelevantRatio", "retrievedTokens"] as const;

/** Against the baseline, as `jarvis evals diff` does: a drop (or a rise, for cost) beyond tolerance regresses. */
export function diffRetrieval(
  baseline: Pick<RetrievalEvalResult, "summary">,
  current: Pick<RetrievalEvalResult, "summary">,
  tolerance = 0.05,
): { ok: boolean; regressions: string[]; deltas: Record<string, number> } {
  const regressions: string[] = [];
  const deltas: Record<string, number> = {};
  for (const m of [...HIGHER_IS_BETTER, ...LOWER_IS_BETTER]) {
    const before = baseline.summary[m];
    const after = current.summary[m];
    const delta = after - before;
    deltas[m] = round(delta);
    const allowed = Math.max(tolerance * Math.abs(before), tolerance);
    const worse = (HIGHER_IS_BETTER as readonly string[]).includes(m) ? -delta : delta;
    if (worse > allowed) regressions.push(`${m}: ${before} → ${after}`);
  }
  return { ok: regressions.length === 0, regressions, deltas };
}

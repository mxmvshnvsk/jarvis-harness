import type { Embedder } from "./embedder.ts";
import { expandQuery, type GlossaryEntry, tokenize } from "./glossary.ts";
import type { KnowledgeIndex, UnitKind } from "./index.ts";

/**
 * Retriever (ADR-0015 §5): lexical (FTS5 + glossary expansion) and, when an embedder is
 * configured, semantic lists merged by Reciprocal Rank Fusion — no learned weights; metadata filters
 * before the merge; every hit carries its retrievalPath for the trace.
 */
export interface Evidence {
  readonly sourceId: string;
  readonly ref: string;
  readonly kind: UnitKind;
  readonly title: string;
  readonly score: number;
  readonly retrievalPath: Array<{ index: "lexical" | "semantic"; rank: number }>;
  readonly snippet?: string;
}

export interface RetrievalResult {
  readonly query: string;
  readonly terms: string[];
  readonly expansions: Array<{ term: string; added: string[] }>;
  readonly evidence: Evidence[];
  readonly indexes: Array<"lexical" | "semantic">;
}

export interface RetrieveOptions {
  readonly kinds?: readonly UnitKind[];
  readonly limit?: number;
  readonly glossary?: readonly GlossaryEntry[];
  readonly embedder?: Embedder;
}

const RRF_K = 60;

export async function retrieve(
  index: KnowledgeIndex,
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievalResult> {
  const { terms, expansions } = expandQuery(query, options.glossary ?? []);
  const limit = options.limit ?? 10;
  const kinds = options.kinds;
  const lexical = index.lexical(terms.length > 0 ? terms : tokenize(query), {
    ...(kinds ? { kinds } : {}),
    limit: limit * 2,
  });
  const lists: Array<{
    name: "lexical" | "semantic";
    hits: Array<{ sourceId: string; ref: string; kind: UnitKind; title: string; snippet?: string }>;
  }> = [{ name: "lexical", hits: lexical }];
  if (options.embedder) {
    const [vector] = await options.embedder.embed([query]);
    if (vector)
      lists.push({
        name: "semantic",
        hits: index.semantic(vector, options.embedder.id, { ...(kinds ? { kinds } : {}), limit: limit * 2 }),
      });
  }
  const fused = new Map<string, Evidence>();
  for (const list of lists) {
    list.hits.forEach((hit, i) => {
      const rank = i + 1;
      const prev = fused.get(hit.sourceId);
      const score = (prev?.score ?? 0) + 1 / (RRF_K + rank);
      const snippet = hit.snippet ?? prev?.snippet;
      fused.set(hit.sourceId, {
        sourceId: hit.sourceId,
        ref: hit.ref,
        kind: hit.kind,
        title: hit.title,
        score,
        retrievalPath: [...(prev?.retrievalPath ?? []), { index: list.name, rank }],
        ...(snippet !== undefined ? { snippet } : {}),
      });
    });
  }
  const evidence = [...fused.values()]
    .sort((a, b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId))
    .slice(0, limit);
  return { query, terms, expansions, evidence, indexes: lists.map((l) => l.name) };
}

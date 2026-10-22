import { resolve as resolvePath } from "node:path";
import type { Runtime } from "../../app/runtime.ts";
import { isTerminal } from "../../core/domain/run.ts";
import { mainCheckoutOf } from "../../core/paths.ts";
import type { KnowledgeDoc } from "../resolver.ts";
import type { KnowledgeRoots } from "../standards.ts";
import { type CodeScan, scanCode } from "./code.ts";
import { loadGlossary } from "./glossary.ts";
import { type IndexReport, KnowledgeIndex, type KnowledgeUnit, type UnitKind } from "./index.ts";
import { type RetrievalResult, retrieve } from "./retriever.ts";

/**
 * The key a project's units are indexed under: its main checkout, so a run's worktree and the
 * repository itself share one index, and two repositories never mix (ADR-0015).
 */
export function projectKeyOf(roots: KnowledgeRoots): string {
  return roots.projectRoot ? `repo:${resolvePath(mainCheckoutOf(roots.projectRoot))}` : "home";
}

const runKey = (runId: string) => `run:${runId}`;

/** Keeps the index in step with the project and the run, and ranks knowledge for a task. */
export async function refreshIndex(
  runtime: Runtime,
  roots: KnowledgeRoots,
  runId?: string,
): Promise<IndexReport> {
  const project = projectKeyOf(roots);
  // ADR-0015 §5: what goes to the index and the embeddings endpoint is redacted, documents too
  const redact = (u: KnowledgeUnit): KnowledgeUnit => ({ ...u, body: runtime.redactor.redact(u.body).text });
  const units = KnowledgeIndex.projectUnits(roots).map(redact);
  const report = await runtime.index.upsert(units, runtime.embedder, project);
  const artifacts = runId
    ? await runtime.index.upsert(
        KnowledgeIndex.artifactUnits(runtime, runId).map(redact),
        runtime.embedder,
        runKey(runId),
      )
    : undefined;
  const code = await refreshCode(runtime, roots, project);
  const removed =
    runtime.index.prune(
      new Set([
        ...units.map((u) => u.sourceId),
        ...(code?.keep ?? []),
        ...(code?.units.map((u) => u.sourceId) ?? []),
      ]),
      project,
    ) + dropEndedRuns(runtime);
  const own = {
    indexed: report.indexed + (artifacts?.indexed ?? 0),
    unchanged: report.unchanged + (artifacts?.unchanged ?? 0),
    embedded: report.embedded + (artifacts?.embedded ?? 0),
  };
  if (!code) return { ...own, removed };
  return {
    indexed: own.indexed + code.report.indexed,
    unchanged: own.unchanged + code.report.unchanged + code.keep.length,
    removed,
    embedded: own.embedded,
    code: { files: code.files, changed: code.changed, skipped: code.skipped },
  };
}

/** The artifacts of runs that ended leave the index: no search reaches them (they grew with every run). */
function dropEndedRuns(runtime: Runtime): number {
  const ended = runtime.index.projects("run:").filter((p) => {
    const run = runtime.runs.get(p.slice("run:".length));
    return !run || isTerminal(run.state);
  });
  return ended.length > 0 ? runtime.index.dropProjects(ended) : 0;
}

/**
 * Tracked source files of the project root (ADR-0015 §2 v0.4), only those git says changed. Code
 * gets no vectors: embeddings for it wait for the §6 gate.
 */
async function refreshCode(
  runtime: Runtime,
  roots: KnowledgeRoots,
  project: string,
): Promise<(CodeScan & { report: IndexReport }) | undefined> {
  const config = runtime.loaded.config.knowledge.retrieval.code;
  if (!config.enabled || !roots.projectRoot) return undefined;
  const scan = await scanCode(roots.projectRoot, config, runtime.index.codeVersions(project), roots.isDenied);
  // ADR-0010: a key hard-coded in a source file never reaches the index or a search snippet
  const units = scan.units.map((u) => ({ ...u, body: runtime.redactor.redact(u.body).text }));
  return { ...scan, units, report: await runtime.index.upsert(units, undefined, project) };
}

export async function search(
  runtime: Runtime,
  roots: KnowledgeRoots,
  query: string,
  /** `glossary: false` searches without query expansion (to measure what the glossary adds, §6). */
  options: { kinds?: readonly UnitKind[]; limit?: number; glossary?: boolean; runId?: string } = {},
): Promise<RetrievalResult> {
  return retrieve(runtime.index, query, {
    projects: [projectKeyOf(roots), ...(options.runId ? [runKey(options.runId)] : [])],
    glossary: options.glossary === false ? [] : loadGlossary(roots.projectRoot),
    ...(runtime.embedder ? { embedder: runtime.embedder } : {}),
    ...(options.kinds ? { kinds: options.kinds } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
}

/**
 * ADR-0015 §2: once more knowledge documents match a task than `rankAbove`, the index decides their
 * order — retrieved ones first by fused rank, the rest after in scope order. Nothing is dropped;
 * the budget fill (ADR-0020 §3) shows the head and lists the tail as available on request.
 */
export async function rankKnowledge(
  runtime: Runtime,
  roots: KnowledgeRoots,
  docs: readonly KnowledgeDoc[],
  query: string,
): Promise<{ docs: KnowledgeDoc[]; result?: RetrievalResult }> {
  const threshold = runtime.loaded.config.knowledge.retrieval.rankAbove;
  if (docs.length <= threshold || query.trim().length === 0) return { docs: [...docs] };
  const result = await search(runtime, roots, query, { kinds: ["knowledge"], limit: 50 });
  const order = new Map<string, number>();
  result.evidence.forEach((e, i) => {
    const name = e.ref.replace(/^knowledge:/, "");
    if (!order.has(name)) order.set(name, i);
  });
  const ranked = [...docs].sort(
    (a, b) => (order.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.name) ?? Number.MAX_SAFE_INTEGER),
  );
  return { docs: ranked, result };
}

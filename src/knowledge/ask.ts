import { createEngine } from "../app/engine.ts";
import type { Runtime } from "../app/runtime.ts";
import { resolveActor } from "../core/actor/resolve.ts";
import { leaseOwner } from "../orchestration/lease.ts";
import { newRunId } from "../storage/runStore.ts";
import { git } from "../tools/local/exec.ts";
import { readByRef } from "./resolver.ts";
import { type GlossaryEntry, loadGlossary, matchTerms } from "./retrieval/glossary.ts";
import type { Evidence, RetrievalResult } from "./retrieval/retriever.ts";
import { refreshIndex, search } from "./retrieval/service.ts";
import type { KnowledgeRoots } from "./standards.ts";

/**
 * `jarvis ask` (reference mode): what the project's own knowledge says. Terms come straight from the
 * glossary; a question is answered by an agent that may only read the knowledge base, and its
 * citations are checked against the cited text — an answer nobody can point to is not shown.
 */
export interface Citation {
  readonly ref: string;
  readonly quote: string;
}

export interface AnswerDoc {
  readonly found: boolean;
  readonly answer: string;
  readonly citations: readonly Citation[];
  readonly gaps: readonly string[];
  readonly general?: string | undefined;
}

export interface VerifiedAnswer {
  readonly found: boolean;
  readonly answer: string;
  readonly citations: Citation[];
  readonly rejected: Array<{ ref: string; why: string }>;
  readonly gaps: string[];
  readonly general?: string;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Keeps the answer only when at least one citation is really in the text it points to. */
export function verifyAnswer(doc: AnswerDoc, read: (ref: string) => string | undefined): VerifiedAnswer {
  const citations: Citation[] = [];
  const rejected: Array<{ ref: string; why: string }> = [];
  for (const c of doc.citations) {
    const text = read(c.ref);
    if (text === undefined) rejected.push({ ref: c.ref, why: "no such source" });
    else if (!squash(text).includes(squash(c.quote)))
      rejected.push({ ref: c.ref, why: "the excerpt is not in the source" });
    else citations.push({ ref: c.ref, quote: squash(c.quote) });
  }
  const confirmed = doc.found && doc.answer.trim().length > 0 && citations.length > 0;
  return {
    found: confirmed,
    answer: confirmed ? doc.answer.trim() : "",
    citations,
    rejected,
    gaps: [...doc.gaps],
    ...(doc.general?.trim() ? { general: doc.general.trim() } : {}),
  };
}

export interface AskPlan {
  readonly terms: GlossaryEntry[];
  readonly retrieval: RetrievalResult;
}

/** The deterministic part: glossary terms in the question and the best sources for it. */
export async function plan(
  runtime: Runtime,
  roots: KnowledgeRoots,
  question: string,
  limit: number,
): Promise<AskPlan> {
  await refreshIndex(runtime, roots);
  const glossary = loadGlossary(roots.projectRoot);
  return {
    terms: matchTerms(question, glossary),
    retrieval: await search(runtime, roots, question, { kinds: ["knowledge", "standard", "skill"], limit }),
  };
}

export function taskFor(question: string, evidence: readonly Evidence[], allowGeneral: boolean): string {
  const lines = [`Question: ${question}`, ""];
  if (evidence.length > 0) {
    lines.push("Candidate sources found by search (read them with knowledge.read):");
    for (const e of evidence)
      lines.push(
        `- ${e.ref} — ${e.title}${e.snippet ? `: ${e.snippet.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
      );
  } else
    lines.push("Search found no candidate sources; try knowledge.search with other words before giving up.");
  lines.push(
    "",
    allowGeneral
      ? 'General knowledge is allowed: put it only in "general", never in "answer".'
      : 'General knowledge is NOT allowed: leave "general" empty.',
  );
  return lines.join("\n");
}

export interface AnswerResult {
  readonly runId: string;
  readonly state: string;
  readonly verified?: VerifiedAnswer;
  readonly problem?: string;
}

export async function answerFromKnowledge(
  runtime: Runtime,
  options: {
    root: string;
    roots: KnowledgeRoots;
    question: string;
    evidence: readonly Evidence[];
    allowGeneral: boolean;
    env: NodeJS.ProcessEnv;
  },
): Promise<AnswerResult> {
  const resolved = await resolveActor(runtime.loaded.config, options.env, options.root);
  if (!resolved.actor)
    return {
      runId: "",
      state: "NOT_STARTED",
      problem: "cannot determine the actor (JARVIS_ACTOR, actor.id or git config user.email)",
    };
  const head = (await git(["rev-parse", "HEAD"], options.root)).stdout.trim() || "HEAD";
  const run = runtime.runs.create({
    id: newRunId(),
    task: taskFor(options.question, options.evidence, options.allowGeneral),
    workflow: "ask",
    owner: resolved.actor,
    workspace: {
      mode: "cwd",
      repoRoot: options.root,
      path: options.root,
      baseRef: head,
      baseCommit: head,
      headCommit: head,
    },
    dataClass: runtime.loaded.config.dataClass,
    ...(runtime.loaded.config.profile ? { profile: runtime.loaded.config.profile } : {}),
  });
  runtime.events.emit({
    kind: "run.created",
    runId: run.id,
    actor: `${resolved.actor.kind}:${resolved.actor.id}`,
    payload: { task: options.question, workflow: "ask", trigger: "ask" },
  });
  const result = await createEngine(runtime).execute(run.id, { owner: leaseOwner("cli"), steal: false });
  const artifact = runtime.artifacts.listLatest(run.id, "answer").at(-1);
  if (result.run.state !== "COMPLETED" || !artifact)
    return {
      runId: run.id,
      state: result.run.state,
      problem: `the answering run ended ${result.run.state}${result.run.stateReason ? `: ${result.run.stateReason}` : ""}`,
    };
  const doc = JSON.parse(runtime.artifacts.text(artifact)) as AnswerDoc;
  return {
    runId: run.id,
    state: result.run.state,
    verified: verifyAnswer(
      doc,
      (ref) =>
        readByRef(options.roots, ref) ??
        // documents are named with their extension (knowledge:hooks.md); accept the common slip
        (ref.startsWith("knowledge:") && !ref.endsWith(".md")
          ? readByRef(options.roots, `${ref}.md`)
          : undefined),
    ),
  };
}

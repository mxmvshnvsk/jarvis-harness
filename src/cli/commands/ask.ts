import { createRuntime } from "../../app/runtime.ts";
import { type AnswerResult, answerFromKnowledge, plan } from "../../knowledge/ask.ts";
import { knowledgeRootsOf } from "../../knowledge/sources.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT } from "../output.ts";
import { followRun } from "../progress.ts";
import { loadForCli } from "./config.ts";

/**
 * `jarvis ask <question>` — the project's knowledge base as a reference desk. Glossary terms are
 * answered from the glossary alone; a question goes to an agent that can only read the knowledge base,
 * and only an answer with checked citations is shown. Without `--general` nothing comes from the model's memory.
 */
export interface AskOptions {
  /** false with --no-llm: glossary and ranked sources only. */
  readonly llm?: boolean;
  readonly general?: boolean;
  readonly limit?: number;
}

export async function runAsk(ctx: CliContext, words: readonly string[], options: AskOptions): Promise<void> {
  const question = words.join(" ").trim();
  if (!question) {
    ctx.out.error('ask what? e.g. jarvis ask "how do we pass dependencies into hooks"');
    throw new CliExit(EXIT.error);
  }
  const loaded = await loadForCli(ctx);
  const root = loaded.project?.root ?? ctx.cwd;
  const roots = knowledgeRootsOf(loaded, root);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const { terms, retrieval } = await plan(runtime, roots, question, options.limit ?? 8);
    const sources = retrieval.evidence;

    // The model is called only when it can add something: sources to read, or general knowledge asked for.
    const useModel = options.llm !== false && (sources.length > 0 || options.general === true);
    let answered: AnswerResult | undefined;
    const progress = useModel ? followRun(ctx, runtime) : undefined;
    if (useModel)
      answered = await answerFromKnowledge(runtime, {
        root,
        roots,
        question,
        evidence: sources,
        allowGeneral: options.general === true,
        env: ctx.env,
        ...(retrieval.expansions.length > 0 ? { expansions: retrieval.expansions } : {}),
      }).finally(() => progress?.stop());
    const verified = answered?.verified;
    const nothing = terms.length === 0 && sources.length === 0 && !verified?.general;

    ctx.out.result(
      {
        question,
        terms,
        sources: sources.map((s) => ({ ref: s.ref, kind: s.kind, title: s.title, snippet: s.snippet })),
        expansions: retrieval.expansions,
        answered: useModel,
        found: verified?.found ?? false,
        answer: verified?.answer,
        citations: verified?.citations ?? [],
        rejectedCitations: verified?.rejected ?? [],
        gaps: verified?.gaps ?? [],
        general: verified?.general,
        runId: answered?.runId || undefined,
        problem: answered?.problem,
      },
      () => {
        if (terms.length > 0) {
          ctx.out.line("Glossary");
          for (const t of terms) {
            ctx.out.line(`  ${t.term}${t.definition ? ` — ${t.definition}` : ""}`);
            if (t.synonyms.length > 0) ctx.out.line(`    also: ${t.synonyms.join(", ")}`);
            if (t.symbols.length > 0) ctx.out.line(`    in code: ${t.symbols.join(", ")}`);
            if (t.sources.length > 0) ctx.out.line(`    sources: ${t.sources.join(", ")}`);
          }
          ctx.out.line();
        }
        if (verified?.found) {
          ctx.out.line("Answer (from the knowledge base)");
          for (const l of verified.answer.split("\n")) ctx.out.line(`  ${l}`);
          ctx.out.line();
          ctx.out.line("Sources");
          for (const c of verified.citations) ctx.out.line(`  ${c.ref} — "${c.quote}"`);
          ctx.out.line();
        } else if (useModel && !answered?.problem) {
          ctx.out.line(
            "The knowledge base has no confirmed answer to this question" +
              (verified?.rejected.length ? " (the answer's citations did not match the sources)." : "."),
          );
          ctx.out.line();
        }
        if (verified && verified.gaps.length > 0) {
          ctx.out.line("Not covered by the knowledge base");
          for (const g of verified.gaps) ctx.out.line(`  - ${g}`);
          ctx.out.line();
        }
        if (verified?.general) {
          ctx.out.line("NOT from the knowledge base (the model's general knowledge)");
          for (const l of verified.general.split("\n")) ctx.out.line(`  ${l}`);
          ctx.out.line();
        }
        if (answered?.problem) {
          ctx.out.line(`model unavailable: ${answered.problem}`);
          ctx.out.line();
        }
        if (!verified?.found && sources.length > 0) {
          ctx.out.line("Closest sources");
          for (const s of sources)
            ctx.out.line(
              `  ${s.ref} [${s.kind}] ${s.title}${s.snippet ? `\n      ${s.snippet.replace(/\s+/g, " ").slice(0, 200)}` : ""}`,
            );
          ctx.out.line();
        }
        if (nothing)
          ctx.out.line(
            "Nothing in the knowledge base. Add a document to .jarvis/knowledge/ (or terms to glossary.md), or try --general for a labelled answer from the model's own knowledge.",
          );
      },
    );
    if (answered?.problem && terms.length === 0 && sources.length === 0) throw new CliExit(EXIT.error);
  } finally {
    await runtime.close();
  }
}

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { planProgressOf } from "../app/planProgress.ts";
import { redoNotesFor } from "../app/redo.ts";
import { stableJson } from "../context/serialize.ts";
import type { ProjectGraphExtractor } from "../core/capabilities/contracts.ts";
import type { KnowledgeConfig } from "../core/config/schema.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import { ANSWERS, givenFor, SUGGESTIONS } from "../interaction/answers.ts";
import { requirementCorrectionsOf } from "../interaction/corrections.ts";
import { notesOf, notesText } from "../interaction/notes.ts";
import {
  currentSymbols,
  findSymbol,
  OUTLINE_ABOVE_LINES,
  type OutlineSymbol,
  outlineText,
} from "../knowledge/graph/outline.ts";
import { renderPackage } from "../knowledge/package.ts";
import type { EngineeringContextPackage } from "../knowledge/resolver.ts";
import type { Message } from "../models/types.ts";
import type { StepContext } from "../orchestration/types.ts";
import { recordRedaction } from "../security/redactionStats.ts";
import type { CapabilityDescriptor } from "../tools/types.ts";
import type { AgentDefinition } from "./definition.ts";
import { contentHash } from "./rereads.ts";

/**
 * Context assembly for an agent call (ADR-0001 §7, ADR-0013 §4). Layers in a fixed order and
 * byte-stable text, so a prefix cache survives across the tool rounds of one step:
 *
 *   L0 system/security/policy   never compacted, identical for every call of the step
 *   L1 task / instructions / output contract
 *   L2 current state (step, iteration, loop reasons)
 *   L3 working set: input artifacts
 *   L4 EngineeringContextPackage: skills > standards > knowledge (ADR-0020 §3)
 *   L5 tool history (appended by the runner)
 */
export interface ContextBudget {
  /** Characters available for L3+L4 together. */
  readonly chars: number;
}

function clip(text: string, max: number, ref?: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars${ref ? ` — knowledge.read ${ref} for the whole` : ""}]`;
}

/** A file's text as repo.read shows it: numbered lines. */
export function numberedLines(text: string): string {
  return text
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(5)}  ${l}`)
    .join("\n");
}

/** An input produced by an agent that ran out of its budget: say so, so it is not taken as complete. */
export function incompleteNote(a: ArtifactVersion): string {
  const p = a.provenance;
  if (p.kind !== "agent") return "";
  if (!p.budgetExhausted)
    return p.shortened
      ? `> SHORTENED: agent ${p.agentId}'s document was cut at the output limit and written again shorter; items may be missing. Verify what you rely on.\n\n`
      : "";
  const what =
    p.budgetExhausted === "tools"
      ? "tool calls"
      : p.budgetExhausted === "model"
        ? "model calls"
        : "its step budget (tokens or requests)";
  return `> INCOMPLETE: agent ${p.agentId} ran out of ${what} while producing this; what it did not cover is unknown. Verify what you rely on.\n\n`;
}

const LANGUAGES: Readonly<Record<string, string>> = {
  ru: "Russian",
  en: "English",
  uk: "Ukrainian",
  be: "Belarusian",
  kk: "Kazakh",
  de: "German",
  fr: "French",
  es: "Spanish",
};

/** The rule on the language of what the agent writes for people (`language` in the configuration). */
export function languageRule(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const name = LANGUAGES[language.toLowerCase()] ?? language;
  return `- Write every text meant for people in ${name}: summaries, findings, requirements, questions, comments, answers, documents. Keep as they are: JSON keys and enum values of the output contract, identifiers, code, file paths, commands, and quotes from sources (quote them in their own language).`;
}

export function systemLayer(
  def: AgentDefinition,
  tools: readonly CapabilityDescriptor[],
  language?: string,
): string {
  const lang = languageRule(language);
  const toolList = tools
    .map((t) => `- ${t.name}${t.access !== "read" ? ` (${t.access})` : ""}: ${t.description}`)
    .join("\n");
  return [
    "# Jarvis agent runtime",
    "Rules:",
    "- You act inside one repository workspace through the tools listed below; nothing else exists.",
    "- Evidence first: read files before making claims; cite paths and line numbers as sources.",
    // pilot: 44 of 58 model calls asked for two tools, mostly independent reads; every call re-sends the
    // whole prompt and takes its seconds, so the count of calls is the run's time
    "- Batch what is independent: every read, search or listing you already know you need goes into the same turn as parallel tool calls (up to 6 at once). One call per turn only when the next depends on its result.",
    "- Never invent file contents, APIs, tickets or test results. What you cannot verify is an unknown.",
    "- Secrets in tool output appear as [REDACTED:…]; never try to recover or guess them.",
    "- Tool calls that are denied by policy are final; do not retry them with other arguments.",
    "- Do not create scratch or probe files in the workspace: everything you write there becomes part of the change. Text files written with the tools end with a newline; do not try to fix line endings yourself.",
    "- Precedence of guidance: these rules and the agent instructions, then required standards, then skills, then recommended standards and project knowledge.",
    // pilot: a reasoning model wrote the whole document in its head at the loop's end, spent its output
    // limit on thinking (16k) and answered nothing — 143 s lost, then asked for the document anyway
    '- When you have what you need (where your instructions say "produce the result document"), reply without tool calls with one line: DONE — and, if any, one sentence on what stays unknown. Do not write the document in that reply: the runtime asks you for it right after, as JSON.',
    ...(lang ? [lang] : []),
    "",
    `# Agent: ${def.id}`,
    def.description,
    "",
    "# Instructions",
    def.instructions,
    "",
    "# Tools",
    toolList.length > 0 ? toolList : "(no tools)",
  ].join("\n");
}

export function outputContract(def: AgentDefinition): string {
  const schema = z.toJSONSchema(def.output.schema, { target: "draft-7" });
  return [
    "# Result document",
    `When asked for the result, answer with one JSON document matching this schema (artifact type "${def.output.type}"):`,
    stableJson(schema),
    `Allowed values of "outcome": ${def.output.outcomes.map((o) => `"${o}"`).join(", ")}. Use "ok" unless the instructions say otherwise, and fill "reasons" whenever outcome is not "ok".`,
    'Inside string values quote with «» (or escape a double quote as \\"): a bare " ends the string and breaks the document.',
  ].join("\n");
}

export interface BuildInput {
  readonly def: AgentDefinition;
  readonly ctx: StepContext;
  readonly tools: readonly CapabilityDescriptor[];
  readonly inputs: ReadonlyArray<{ artifact: ArtifactVersion; text: string }>;
  readonly pkg: EngineeringContextPackage;
  readonly knowledgeConfig: KnowledgeConfig;
  readonly budget: ContextBudget;
  /**
   * Filled with the files the task message shows whole (path → hash of their numbered text): a
   * repo.read of one of them, unchanged, is answered with a pointer (src/agents/rereads.ts).
   */
  readonly shown?: Map<string, string>;
  /** Classes and methods of the long files the task message may show (`outlinesFor`): shown sliced. */
  readonly outlines?: ReadonlyMap<string, readonly OutlineSymbol[]>;
  /** Filled with the knowledge documents the message shows whole (a knowledge.read of one: a pointer). */
  readonly knowledgeShown?: Set<string>;
  /** The change under review as git.diff gives it (review): in the message, not a first call for it. */
  readonly change?: string;
}

/** L0–L4 as two messages: a byte-stable system message and the task message. */
export function buildBaseMessages(input: BuildInput): Message[] {
  const { def, ctx } = input;
  const run = ctx.run;
  const loopReasons = describeLoopReasons(ctx);
  const l1 = [
    `# Task ${run.task}`,
    `Workflow: ${run.workflow}; step: ${ctx.step.id} (iteration ${ctx.iteration}); workspace: ${ctx.workspace.ref.mode}.`,
    outputContract(def),
  ].join("\n");
  const clarifications = describeClarifications(ctx);
  const decided = describeAcceptances(ctx);
  const corrected = describeRequirementCorrections(ctx);
  const review = humanReviewOf(ctx, def);
  const sentBack = redoNotesFor(ctx.runtime, run.id, ctx.step.id, ctx.iteration);
  const l2 = [
    sentBack.length > 0
      ? `# A person sent the run back to this step (binding)\n${sentBack.map((r) => `- ${r.actor ?? "a person"}: ${r.note}`).join("\n")}`
      : "",
    loopReasons ? `# Why this step runs again\n${loopReasons}` : "",
    review ? review.instructions : "",
    clarifications ? `# Clarifications decided with a human (binding)\n${clarifications}` : "",
    corrected ? `# Requirements corrected by a human in review (binding)\n${corrected}` : "",
    decided ? `# Decided by a human when accepting documents (binding)\n${decided}` : "",
    ((n) => (n.length > 0 ? `# Notes from a person during the run (binding)\n${notesText(n)}` : ""))(
      notesOf(ctx.runtime, ctx.run.id),
    ),
  ]
    .filter(Boolean)
    .join("\n\n");

  const knowledgeBudget = Math.floor(input.budget.chars * 0.3);
  // the knowledge takes what it renders to, at most its 30%: the rest of it goes to the inputs (an
  // empty L4 still held 30% back, and the research the step builds on was cut for nothing)
  const l4 = renderPackage(input.pkg, knowledgeBudget, input.knowledgeConfig, input.knowledgeShown);
  const inputBudget = input.budget.chars - Math.min(knowledgeBudget, l4.length);
  const fullTypes = new Set(def.contextInputs ?? []);
  const full = input.inputs.filter((i) => fullTypes.size === 0 || fullTypes.has(i.artifact.type));
  const perInput = full.length > 0 ? Math.floor(inputBudget / full.length) : 0;
  const l3 = full.map(
    (i) =>
      `## Artifact ${i.artifact.type}/${i.artifact.name}@${i.artifact.version}\n${incompleteNote(i.artifact)}${clip(i.text, perInput, `${i.artifact.type}/${i.artifact.name}@${i.artifact.version}`)}`,
  );
  const named = input.inputs
    .filter((i) => !full.includes(i))
    .map(
      (i) =>
        `- ${i.artifact.type}/${i.artifact.name}@${i.artifact.version}${incompleteNote(i.artifact) ? " (incomplete: its agent ran out of budget)" : ""}`,
    );
  if (named.length > 0)
    l3.push(`## Other inputs (available on request: knowledge.read with the ref)\n${named.join("\n")}`);
  // an implementation works on the plan step that is open, with its files as they are now
  const step =
    def.output.type === "implementation"
      ? planStepNow(ctx, Math.min(Math.floor(inputBudget * 0.2), 30_000), input.shown, input.outlines)
      : undefined;
  // bounded: every model call of the step re-sends it (no prefix cache on the pilot gateway). With a
  // plan step open its files are the code that matters: the research's reads would go with every call
  const read = step
    ? undefined
    : codeReadInRun(ctx, Math.min(Math.floor(inputBudget * 0.25), 40_000), input.shown, input.outlines);
  if (read) l3.push(read);
  if (step) l3.push(step);
  if (input.change)
    l3.push(
      `## The change under review (git.diff against the base; call git.diff with a path for a file it cut)\n${clip(input.change, Math.min(Math.floor(inputBudget * 0.35), 24_000))}`,
    );
  // the version the human sent back comes first: the agent revises it rather than starting over
  if (review) l3.unshift(review.previous(perInput > 0 ? perInput : inputBudget));

  const user = [l1, l2, l3.length > 0 ? `# Inputs\n${l3.join("\n\n")}` : "# Inputs\n(none)", l4]
    .filter((s) => s.length > 0)
    .join("\n\n");

  return [
    { role: "system", content: systemLayer(def, input.tools, ctx.runtime.loaded.config.language) },
    { role: "user", content: user },
  ];
}

/**
 * A human sent this agent's previous result back (`request_changes`, ADR-0005 §4): the decision's
 * comment — answers to the document's open questions, what to change — and that version itself.
 * Pilot: the second pass of `spec` got neither, re-researched the code for 13 minutes, spent its tool
 * limit and asked the answered questions again.
 */
export function humanReviewOf(
  ctx: StepContext,
  def: AgentDefinition,
): { instructions: string; previous: (chars: number) => string } | undefined {
  if (ctx.iteration <= 1) return undefined;
  const previous = ctx.runtime.artifacts.listLatest(ctx.run.id, def.output.type)[0];
  if (!previous) return undefined;
  const decisions = ctx.runtime.artifacts
    .approvalsFor(previous.artifactId, previous.version)
    .filter((a) => a.decision !== "approve");
  if (decisions.length === 0) return undefined;
  const lines = decisions.map(
    (a) =>
      `- ${a.decision} by ${a.actor.id}${
        a.comment
          ? `:\n${a.comment
              .split("\n")
              .map((l) => `  ${l}`)
              .join("\n")}`
          : " (no comment)"
      }`,
  );
  const ref = `${previous.type}/${previous.name}@${previous.version}`;
  return {
    instructions: [
      `# Human review of your previous version ${ref} (binding)`,
      ...lines,
      "",
      `Revise ${ref} (below, under Inputs) instead of starting over: apply every point of the review and keep what it does not touch.`,
      "A question the review answers is decided: put the answer into the document (requirements, non-goals, decisions) and remove it from the open questions; never ask it again.",
      "Use tools only to check something the review raises; the research is done.",
    ].join("\n"),
    previous: (chars) =>
      `## Your previous version ${ref} (sent back)\n${clip(ctx.runtime.artifacts.text(previous), chars)}`,
  };
}

/** Files repo.read in this run (and the run it went on from): how often, by which steps, which parts. */
function readsInRun(
  ctx: StepContext,
): Map<
  string,
  { n: number; last: number; steps: Set<string>; symbols: Set<string>; ranges: Array<[number, number]> }
> {
  const runs = [ctx.run.id];
  const created = ctx.runtime.events.list({ runId: ctx.run.id, kind: "run.created", limit: 1 })[0];
  const from = (created?.payload as { continuedFrom?: string } | undefined)?.continuedFrom;
  if (from) runs.push(from);
  const count = new Map<
    string,
    { n: number; last: number; steps: Set<string>; symbols: Set<string>; ranges: Array<[number, number]> }
  >();
  for (const runId of runs) {
    for (const e of ctx.runtime.events.list({ runId, kind: "tool.call", limit: 100_000 })) {
      const p = (e.payload ?? {}) as { capability?: string; ok?: boolean; args?: string };
      if (p.capability !== "repo.read" || p.ok === false || typeof p.args !== "string") continue;
      let args: { path?: unknown; symbol?: unknown; startLine?: unknown; endLine?: unknown };
      try {
        args = JSON.parse(p.args) as typeof args;
      } catch {
        continue;
      }
      const path = args.path;
      if (typeof path !== "string" || path.length === 0) continue;
      const entry = count.get(path) ?? {
        n: 0,
        last: 0,
        steps: new Set<string>(),
        symbols: new Set<string>(),
        ranges: [],
      };
      entry.n += 1;
      entry.last = Math.max(entry.last, e.seq);
      if (e.stepId) entry.steps.add(e.stepId);
      if (typeof args.symbol === "string" && args.symbol.trim()) entry.symbols.add(args.symbol.trim());
      if (typeof args.startLine === "number" || typeof args.endLine === "number")
        entry.ranges.push([Number(args.startLine ?? 1), Number(args.endLine ?? args.startLine ?? 1)]);
      count.set(path, entry);
    }
  }
  return count;
}

/**
 * A long file for a task message: its outline, then the parts that matter — the symbols named, the
 * line ranges given — numbered as in the file. Undefined when the file is short or has no outline.
 */
export function slicedFile(
  path: string,
  text: string,
  symbols: readonly OutlineSymbol[],
  wanted: Iterable<string>,
  ranges: ReadonlyArray<readonly [number, number]> = [],
): string | undefined {
  const lines = text.split("\n");
  if (lines.length <= OUTLINE_ABOVE_LINES || symbols.filter((x) => x.kind === "method").length < 2)
    return undefined;
  const parts = new Map<string, [number, number]>();
  for (const w of wanted) for (const f of findSymbol(symbols, w)) parts.set(f.name, [f.line, f.endLine]);
  ranges.forEach(([a, b], i) => {
    if (b >= a) parts.set(`lines ${a}-${b}#${i}`, [a, Math.min(b, lines.length)]);
  });
  const bodies = [...parts.entries()]
    .sort((x, y) => x[1][0] - y[1][0])
    .map(([name, [a, b]]) => {
      const body = lines
        .slice(a - 1, b)
        .map((l, i) => `${String(a + i).padStart(5)}  ${l}`)
        .join("\n");
      const title = name.startsWith("lines ") ? `lines ${a}-${b}` : `${name} (lines ${a}-${b})`;
      return `#### ${title}\n${body}`;
    });
  return [outlineText(path, lines.length, symbols), ...bodies].join("\n\n");
}

/**
 * Classes and methods of the long files a task message may show — read before, or the open plan
 * step's — from the stack's extractor on each file as it is now.
 */
export async function outlinesFor(
  ctx: StepContext,
  extractors: readonly ProjectGraphExtractor[],
): Promise<Map<string, readonly OutlineSymbol[]>> {
  const out = new Map<string, readonly OutlineSymbol[]>();
  if (extractors.length === 0) return out;
  const reads = [...readsInRun(ctx).entries()]
    .sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last)
    .slice(0, 8);
  const progress = planProgressOf(
    ctx.runtime,
    ctx.run,
    ctx.runtime.events.list({ runId: ctx.run.id, limit: 100_000 }),
  );
  const at = progress?.current;
  const stepFiles = at === undefined ? [] : (progress?.steps[at]?.files ?? []);
  const root = resolve(ctx.workspace.ref.path);
  for (const path of new Set([...reads.map(([p]) => p), ...stepFiles])) {
    const full = resolve(root, path);
    if (!full.startsWith(`${root}/`) || !existsSync(full) || ctx.runtime.pathPolicy.isDenied(path)) continue;
    const text = readFileSync(full, "utf8");
    if (text.split("\n").length <= OUTLINE_ABOVE_LINES) continue;
    const symbols = await currentSymbols(extractors, path, text);
    if (symbols.length > 0) out.set(path, symbols);
  }
  return out;
}

/** A file's text on its way into a model request: redacted, and the redaction counted (ADR-0010 §4). */
function redactForModel(ctx: StepContext, text: string): string {
  const report = ctx.runtime.redactor.redact(text);
  recordRedaction(ctx.runtime.events, report, {
    boundary: "model-request",
    runId: ctx.run.id,
    stepId: ctx.step.id,
  });
  return report.text;
}

/**
 * The files earlier steps of this run (and of the run it went on from) read, in their current
 * content, most read first: the next agent starts with them instead of reading them again. Pilot:
 * research, requirements, spec and impact each re-read `order-form.tsx`, a model round trip
 * (up to five minutes on the pilot gateway) every time.
 */
export function codeReadInRun(
  ctx: StepContext,
  chars: number,
  shown?: Map<string, string>,
  outlines?: ReadonlyMap<string, readonly OutlineSymbol[]>,
): string | undefined {
  const count = readsInRun(ctx);
  if (count.size === 0 || chars <= 0) return undefined;
  const root = ctx.workspace.ref.path;
  const ordered = [...count.entries()].sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last);
  const sections: string[] = [];
  let left = chars;
  for (const [path, info] of ordered.slice(0, 8)) {
    if (left < 2_000) break;
    if (ctx.runtime.pathPolicy.isDenied(path)) continue;
    const full = resolve(root, path);
    if (!full.startsWith(`${resolve(root)}/`) || !existsSync(full)) continue;
    const buffer = readFileSync(full);
    if (buffer.includes(0)) continue;
    const text = redactForModel(ctx, buffer.toString("utf8"));
    const numbered = numberedLines(text);
    // a long file: its outline and the parts read before, not all of it
    const symbols = outlines?.get(path);
    const sliced = symbols ? slicedFile(path, text, symbols, info.symbols, info.ranges) : undefined;
    const body = clip(sliced ?? numbered, Math.min(left, 16_000));
    left -= body.length;
    if (body === numbered) shown?.set(path, contentHash(numbered));
    sections.push(
      `### ${path} (read ${info.n} time${info.n === 1 ? "" : "s"} by ${[...info.steps].join(", ") || "earlier steps"})\n${body}`,
    );
  }
  if (sections.length === 0) return undefined;
  return [
    "## Code already read in this run (current content)",
    "These files are shown as they are now in the workspace. Do not read them again with repo.read: read other files, the part of a file cut off here (startLine), or a file here after you changed it.",
    ...sections,
  ].join("\n\n");
}

/**
 * The plan step an implementation works on now (src/app/planProgress.ts) with the current text of its
 * files, so it starts editing instead of reading the whole plan's code first (pilot: 64 model calls of
 * reading, five trims, no edit).
 */
/** The files of the plan step open now (implementation), or undefined without a plan or an open step. */
export function planStepFilesNow(ctx: StepContext): string[] | undefined {
  const progress = planProgressOf(
    ctx.runtime,
    ctx.run,
    ctx.runtime.events.list({ runId: ctx.run.id, kinds: ["step.start", "tool.call"], limit: 100_000 }),
  );
  const at = progress?.current;
  const step = at === undefined ? undefined : progress?.steps[at];
  return step && step.files.length > 0 ? [...step.files] : undefined;
}

export function planStepNow(
  ctx: StepContext,
  chars: number,
  shown?: Map<string, string>,
  outlines?: ReadonlyMap<string, readonly OutlineSymbol[]>,
): string | undefined {
  const progress = planProgressOf(
    ctx.runtime,
    ctx.run,
    ctx.runtime.events.list({ runId: ctx.run.id, limit: 100_000 }),
  );
  const at = progress?.current;
  const step = at === undefined ? undefined : progress?.steps[at];
  if (!progress || !step || at === undefined) return undefined;
  const root = ctx.workspace.ref.path;
  const lines = [
    `## The plan step to work on now: ${step.id} (${at + 1} of ${progress.steps.length}) — ${step.description}`,
    step.verification ? `Check: ${step.verification}` : "",
    "Work one plan step at a time: this step's files below, edit, verify, plan.step done, then the next step.",
  ].filter(Boolean);
  let left = chars;
  for (const path of step.files) {
    if (left < 1_000 || ctx.runtime.pathPolicy.isDenied(path)) continue;
    const full = resolve(root, path);
    if (!full.startsWith(`${resolve(root)}/`)) continue;
    if (!existsSync(full)) {
      lines.push(`### ${path}\n(new file — not there yet)`);
      continue;
    }
    // redacted as every other way a file reaches the model (it was not: a secret in a plan step's file
    // went into the prompt as it was)
    const text = redactForModel(ctx, readFileSync(full, "utf8"));
    // a long file: its outline and the methods the step names
    const symbols = outlines?.get(path);
    const named = symbols
      ? symbols
          .filter((x) => x.kind === "method")
          .map((x) => x.name.replace(/\/-?\d+$/, ""))
          .filter((n) =>
            new RegExp(`\\b${n.replace(/^.*\./, "")}\\b`).test(
              `${step.description} ${step.verification ?? ""}`,
            ),
          )
      : [];
    const shownText = (symbols && slicedFile(path, text, symbols, named)) || text;
    const body =
      shownText.length > left
        ? `${shownText.slice(0, left)}\n…[cut: ${shownText.length - left} more chars — repo.read it]`
        : shownText;
    left -= body.length;
    if (body === text) shown?.set(path, contentHash(numberedLines(text)));
    lines.push(
      `### ${path} (as it is now${shownText !== text ? ": outline and the methods this step names" : ""})\n${body}`,
    );
  }
  return lines.join("\n\n");
}

/** Resolved clarification threads of the run (ADR-0019 §4): rules agents must follow. */
function describeClarifications(ctx: StepContext): string | undefined {
  const docs = ctx.runtime.artifacts.listLatest(ctx.run.id, "clarification");
  if (docs.length === 0) return undefined;
  const lines: string[] = [];
  for (const a of docs) {
    try {
      const doc = JSON.parse(ctx.runtime.artifacts.text(a)) as {
        question?: string;
        rule?: string;
        requirementCorrections?: string[];
        assumptions?: string[];
      };
      lines.push(`- Q: ${clip(doc.question ?? "", 400).replace(/\n+/g, " ")}`);
      lines.push(`  Rule: ${doc.rule ?? ""}`);
      for (const c of doc.requirementCorrections ?? []) lines.push(`  Requirement correction: ${c}`);
      for (const c of doc.assumptions ?? []) lines.push(`  Assumption: ${c}`);
    } catch {
      // not JSON
    }
  }
  return lines.join("\n");
}

/**
 * Requirement corrections from a review (ADR-0019 §5): binding for every later step. Those from a
 * clarification are already in its block above, with the rule they came with.
 */
function describeRequirementCorrections(ctx: StepContext): string | undefined {
  const lines = requirementCorrectionsOf(ctx.runtime, ctx.run.id)
    .filter((c) => c.doc.from !== "clarification")
    .flatMap((c) => [
      `- by ${c.doc.by}${c.doc.basedOn ? `, against requirements ${c.doc.basedOn}` : ""}:`,
      ...c.doc.corrections.map((x) => `  ${clip(String(x), 1000).replace(/\n+/g, " ")}`),
    ]);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * What a person said when accepting a document — the comment of «Accept», the answers to its open
 * questions given on the page — for every later step. Pilot: a spec was accepted with its open questions
 * answered in the comment, and impact, plan and implementation never saw it (only a «Send back» reached
 * an agent, and only the one sent back to).
 */
export function describeAcceptances(ctx: StepContext): string | undefined {
  const lines: string[] = [];
  for (const a of ctx.runtime.artifacts.listLatest(ctx.run.id)) {
    if (a.type === ANSWERS || a.type === SUGGESTIONS) continue;
    const accepted = ctx.runtime.artifacts
      .approvalsFor(a.artifactId, a.version)
      .find((x) => x.decision === "approve");
    if (!accepted) continue;
    const given = givenFor(ctx.runtime, a) ?? [];
    const comment = (accepted.comment ?? "").replace(/^approved in run \S+(: )?/, "").trim();
    if (!comment && given.length === 0) continue;
    lines.push(`- ${a.type}/${a.name}@${a.version}, accepted by ${accepted.actor.id}:`);
    if (comment)
      lines.push(
        ...clip(comment, 6000)
          .split("\n")
          .map((l) => `  ${l}`),
      );
    for (const g of given)
      lines.push(
        `  Q: ${g.question}`,
        `  A: ${g.mode === "analyst" ? "open, for the analyst — do not decide it; keep today's behaviour and say so" : g.mode === "scope" ? "out of the task's scope" : (g.text ?? "")}`,
      );
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function describeLoopReasons(ctx: StepContext): string | undefined {
  // The most recent artifact of the step that sent us back carries `reasons` (ADR-0004 §2, §4).
  const loops = Object.entries(ctx.run.iterations).filter(
    ([edge, n]) => n > 0 && edge.includes(`->${ctx.step.id}#`),
  );
  if (loops.length === 0) return undefined;
  const lines: string[] = [];
  for (const [edge, n] of loops) {
    const from = edge.split("->")[0] as string;
    const outcome = edge.split("#")[1] as string;
    lines.push(`- ${from} returned "${outcome}" (${n} time${n > 1 ? "s" : ""})`);
    // A composite step carries no artifact of its own: look at its children too (ADR-0020 §2).
    const children = ctx.workflow.steps.find((s) => s.id === from)?.children ?? [];
    const latestArtifacts = ctx.runtime.artifacts.listLatest(ctx.run.id);
    const stepIds = new Set([from, ...children]);
    const candidates = latestArtifacts.filter(
      (a) =>
        a.stepId !== undefined && stepIds.has(a.stepId) && a.type !== "tool-output" && a.type !== "candidate",
    );
    for (const latest of candidates) {
      try {
        const doc = JSON.parse(ctx.runtime.artifacts.text(latest)) as {
          reasons?: Array<{ kind: string; summary: string }>;
        };
        for (const r of doc.reasons ?? []) lines.push(`  - ${r.kind}: ${r.summary}`);
      } catch {
        // not JSON — nothing to quote
      }
    }
  }
  return lines.join("\n");
}

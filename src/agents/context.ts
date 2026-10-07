import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { stableJson } from "../context/serialize.ts";
import type { KnowledgeConfig } from "../core/config/schema.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import { renderPackage } from "../knowledge/package.ts";
import type { EngineeringContextPackage } from "../knowledge/resolver.ts";
import type { Message } from "../models/types.ts";
import type { StepContext } from "../orchestration/types.ts";
import type { CapabilityDescriptor } from "../tools/types.ts";
import type { AgentDefinition } from "./definition.ts";

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

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

/** An input produced by an agent that ran out of its budget: say so, so it is not taken as complete. */
export function incompleteNote(a: ArtifactVersion): string {
  const p = a.provenance;
  if (p.kind !== "agent" || !p.budgetExhausted) return "";
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
    "- Batch what is independent: every read, search or listing you already know you need goes into the same turn as parallel tool calls (up to 8 at once). One call per turn only when the next depends on its result.",
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
  const review = humanReviewOf(ctx, def);
  const l2 = [
    loopReasons ? `# Why this step runs again\n${loopReasons}` : "",
    review ? review.instructions : "",
    clarifications ? `# Clarifications decided with a human (binding)\n${clarifications}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const knowledgeBudget = Math.floor(input.budget.chars * 0.3);
  const inputBudget = input.budget.chars - knowledgeBudget;
  const fullTypes = new Set(def.contextInputs ?? []);
  const full = input.inputs.filter((i) => fullTypes.size === 0 || fullTypes.has(i.artifact.type));
  const perInput = full.length > 0 ? Math.floor(inputBudget / full.length) : 0;
  const l3 = full.map(
    (i) =>
      `## Artifact ${i.artifact.type}/${i.artifact.name}@${i.artifact.version}\n${incompleteNote(i.artifact)}${clip(i.text, perInput)}`,
  );
  const named = input.inputs
    .filter((i) => !full.includes(i))
    .map(
      (i) =>
        `- ${i.artifact.type}/${i.artifact.name}@${i.artifact.version}${incompleteNote(i.artifact) ? " (incomplete: its agent ran out of budget)" : ""}`,
    );
  if (named.length > 0) l3.push(`## Other inputs (available on request)\n${named.join("\n")}`);
  // bounded: every model call of the step re-sends it (no prefix cache on the pilot gateway)
  const read = codeReadInRun(ctx, Math.min(Math.floor(inputBudget * 0.25), 40_000));
  if (read) l3.push(read);
  // the version the human sent back comes first: the agent revises it rather than starting over
  if (review) l3.unshift(review.previous(perInput > 0 ? perInput : inputBudget));

  const l4 = renderPackage(input.pkg, knowledgeBudget, input.knowledgeConfig);

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

/**
 * The files earlier steps of this run (and of the run it went on from) read, in their current
 * content, most read first: the next agent starts with them instead of reading them again. Pilot:
 * research, requirements, spec and impact each re-read `order-form.tsx`, a model round trip
 * (up to five minutes on the pilot gateway) every time.
 */
export function codeReadInRun(ctx: StepContext, chars: number): string | undefined {
  const runs = [ctx.run.id];
  const created = ctx.runtime.events.list({ runId: ctx.run.id, kind: "run.created", limit: 1 })[0];
  const from = (created?.payload as { continuedFrom?: string } | undefined)?.continuedFrom;
  if (from) runs.push(from);
  const count = new Map<string, { n: number; last: number; steps: Set<string> }>();
  for (const runId of runs) {
    for (const e of ctx.runtime.events.list({ runId, kind: "tool.call", limit: 100_000 })) {
      const p = (e.payload ?? {}) as { capability?: string; ok?: boolean; args?: string };
      if (p.capability !== "repo.read" || p.ok === false || typeof p.args !== "string") continue;
      let path: unknown;
      try {
        path = (JSON.parse(p.args) as { path?: unknown }).path;
      } catch {
        continue;
      }
      if (typeof path !== "string" || path.length === 0) continue;
      const entry = count.get(path) ?? { n: 0, last: 0, steps: new Set<string>() };
      entry.n += 1;
      entry.last = Math.max(entry.last, e.seq);
      if (e.stepId) entry.steps.add(e.stepId);
      count.set(path, entry);
    }
  }
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
    const text = ctx.runtime.redactor.redact(buffer.toString("utf8")).text;
    const numbered = text
      .split("\n")
      .map((l, i) => `${String(i + 1).padStart(5)}  ${l}`)
      .join("\n");
    const body = clip(numbered, Math.min(left, 16_000));
    left -= body.length;
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

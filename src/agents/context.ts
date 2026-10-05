import { z } from "zod";
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

export function systemLayer(def: AgentDefinition, tools: readonly CapabilityDescriptor[]): string {
  const toolList = tools
    .map((t) => `- ${t.name}${t.access !== "read" ? ` (${t.access})` : ""}: ${t.description}`)
    .join("\n");
  return [
    "# Jarvis agent runtime",
    "Rules:",
    "- You act inside one repository workspace through the tools listed below; nothing else exists.",
    "- Evidence first: read files before making claims; cite paths and line numbers as sources.",
    "- Never invent file contents, APIs, tickets or test results. What you cannot verify is an unknown.",
    "- Secrets in tool output appear as [REDACTED:…]; never try to recover or guess them.",
    "- Tool calls that are denied by policy are final; do not retry them with other arguments.",
    "- Precedence of guidance: these rules and the agent instructions, then required standards, then skills, then recommended standards and project knowledge.",
    "- When you are done, reply without tool calls with the result document itself (the JSON of the output contract); a prose reply makes the runtime ask for it again.",
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
    JSON.stringify(schema),
    `Allowed values of "outcome": ${def.output.outcomes.map((o) => `"${o}"`).join(", ")}. Use "ok" unless the instructions say otherwise, and fill "reasons" whenever outcome is not "ok".`,
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
  const l2 = [
    loopReasons ? `# Why this step runs again\n${loopReasons}` : "",
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
      `## Artifact ${i.artifact.type}/${i.artifact.name}@${i.artifact.version}\n${clip(i.text, perInput)}`,
  );
  const named = input.inputs
    .filter((i) => !full.includes(i))
    .map((i) => `- ${i.artifact.type}/${i.artifact.name}@${i.artifact.version}`);
  if (named.length > 0) l3.push(`## Other inputs (available on request)\n${named.join("\n")}`);

  const l4 = renderPackage(input.pkg, knowledgeBudget, input.knowledgeConfig);

  const user = [l1, l2, l3.length > 0 ? `# Inputs\n${l3.join("\n\n")}` : "# Inputs\n(none)", l4]
    .filter((s) => s.length > 0)
    .join("\n\n");

  return [
    { role: "system", content: systemLayer(def, input.tools) },
    { role: "user", content: user },
  ];
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

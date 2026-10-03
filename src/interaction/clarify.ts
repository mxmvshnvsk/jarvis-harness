import { z } from "zod";
import type { Runtime } from "../app/runtime.ts";
import type { Run } from "../core/domain/run.ts";
import { resolveModel } from "../models/router.ts";
import { generateStructured } from "../models/structured.ts";
import type { Message } from "../models/types.ts";
import type { Interaction, InteractionMessage } from "./store.ts";

/**
 * Clarification threads (ADR-0019 §4, §7): a short conversation about one question, built from the
 * problem's context rather than the run's history, that ends in a structured `clarification`
 * artifact. Agents consume the artifact; the transcript stays in the thread for audit.
 */
export const ClarifierTurn = z.object({
  kind: z.enum(["question", "resolution"]).describe("ask one more question, or propose the resolution"),
  text: z.string().min(1).describe("the next question, or a one-paragraph summary of the resolution"),
  proposal: z
    .object({
      rule: z.string().min(1).describe("the business rule or decision, stated so it can be tested"),
      requirementCorrections: z.array(z.string()).default([]).describe("requirement ids/texts to change"),
      assumptions: z.array(z.string()).default([]),
    })
    .optional(),
});
export type ClarifierTurnT = z.infer<typeof ClarifierTurn>;

export interface ClarificationResolution {
  readonly rule: string;
  readonly requirementCorrections: string[];
  readonly assumptions: string[];
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

/** L0–L6 of ADR-0019 §7 as two messages. */
export function clarifierMessages(
  rt: Runtime,
  run: Run,
  thread: Interaction,
  messages: readonly InteractionMessage[],
): Message[] {
  const artifactsOf = (type: string) =>
    rt.artifacts
      .listLatest(run.id, type)
      .slice(0, 1)
      .map((a) => `## ${a.type}/${a.name}@${a.version}\n${clip(rt.artifacts.text(a), 6000)}`);
  const relevant = [...artifactsOf("requirements"), ...artifactsOf("spec")].join("\n\n");
  const origin = thread.contentRef
    ? `${thread.origin ?? "agent"} (artifact ${thread.contentRef})`
    : (thread.origin ?? "agent");
  const history = messages
    .slice(-12)
    .map((m) => `${m.role === "human" ? "Human" : "Jarvis"}: ${m.text}`)
    .join("\n");
  return [
    {
      role: "system",
      content: [
        "# Jarvis clarification thread",
        "You resolve exactly one open question about an engineering task together with a human.",
        "Rules:",
        "- Ask one question at a time, only when the answer changes the rule; otherwise propose the resolution.",
        "- A resolution states the rule precisely (states, conditions, edge cases) and lists the requirement corrections it implies.",
        "- Never invent business facts; what the human did not say is an assumption and must be listed as one.",
        "- Keep questions and summaries short; the human reads them in a terminal.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `# Task ${run.task}`,
        `Origin: ${origin}`,
        relevant ? `# Relevant requirements and specification\n${relevant}` : "",
        `# Thread so far\n${history}`,
        "# Now",
        "Decide: ask the next question (kind: question) or propose the resolution (kind: resolution, with proposal).",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
}

/** One Jarvis turn: either another question or a proposed resolution, appended to the thread. */
export async function clarifierTurn(rt: Runtime, run: Run, thread: Interaction): Promise<InteractionMessage> {
  const messages = rt.interactions.messages(thread.id);
  const config = rt.loaded.config;
  const route = resolveModel(config, "research", { structuredOutput: "json" });
  const result = await generateStructured(rt.gateway, {
    modelId: route.modelId,
    mode: route.structuredMode,
    name: "clarifier-turn",
    schema: ClarifierTurn,
    messages: [
      ...clarifierMessages(rt, run, thread, messages),
      { role: "user", content: "Answer with the JSON document now." },
    ],
    request: { role: "research", agentId: "clarifier", temperature: 0, runId: run.id },
  });
  const turn = result.value;
  const text =
    turn.kind === "resolution" && turn.proposal
      ? `${turn.text}\n\nProposed rule: ${turn.proposal.rule}`
      : turn.text;
  const message = rt.interactions.say(thread.id, {
    role: "jarvis",
    actor: "clarifier",
    text,
    ...(turn.kind === "resolution" && turn.proposal ? { proposal: turn.proposal } : {}),
  });
  if (turn.kind === "resolution") rt.interactions.setState(thread.id, "ready_for_review");
  rt.events.emit({
    kind: "interaction.turn",
    runId: run.id,
    stepId: thread.stepId,
    payload: { interactionId: thread.id, kind: turn.kind, modelId: route.modelId },
  });
  return message;
}

/** The latest proposal in the thread, if Jarvis made one. */
export function latestProposal(rt: Runtime, thread: Interaction): ClarificationResolution | undefined {
  const withProposal = [...rt.interactions.messages(thread.id)].reverse().find((m) => m.proposal);
  if (!withProposal?.proposal) return undefined;
  const p = withProposal.proposal as Partial<ClarificationResolution>;
  return {
    rule: String(p.rule ?? ""),
    requirementCorrections: Array.isArray(p.requirementCorrections)
      ? p.requirementCorrections.map(String)
      : [],
    assumptions: Array.isArray(p.assumptions) ? p.assumptions.map(String) : [],
  };
}

/**
 * Accepts a resolution: writes the `clarification` artifact, closes the thread, clears the
 * run's waiting state so `resume` continues the parked step with the answer in its context.
 */
export function resolveClarification(
  rt: Runtime,
  run: Run,
  thread: Interaction,
  resolution: ClarificationResolution,
  actorId: string,
): { artifactRef: string; thread: Interaction } {
  const messages = rt.interactions.messages(thread.id);
  const question = messages.find((m) => m.role === "jarvis")?.text ?? "";
  const answers = messages.filter((m) => m.role === "human").map((m) => m.text);
  const artifact = rt.artifacts.put({
    runId: run.id,
    type: "clarification",
    name: `${thread.id}.json`,
    content: JSON.stringify(
      {
        threadId: thread.id,
        origin: thread.origin ?? "agent",
        stepId: thread.stepId,
        question,
        answers,
        rule: resolution.rule,
        requirementCorrections: resolution.requirementCorrections,
        assumptions: resolution.assumptions,
        resolvedBy: actorId,
      },
      null,
      2,
    ),
    mediaType: "application/json",
    provenance: { kind: "human", actor: { kind: "user", id: actorId, verified: false } },
    sourceRefs: thread.contentRef ? [thread.contentRef] : [],
    stepId: thread.stepId,
    iteration: thread.iteration,
  });
  const ref = `${artifact.artifactId}@${artifact.version}`;
  const closed = rt.interactions.close(thread.id, "resolved", actorId, ref);
  rt.runs.setWaitingFor(run.id, undefined);
  rt.events.emit({
    kind: "interaction.resolved",
    runId: run.id,
    stepId: thread.stepId,
    payload: { interactionId: thread.id, kind: thread.kind, artifact: ref, by: actorId },
  });
  return { artifactRef: ref, thread: closed };
}

export function rejectThread(rt: Runtime, run: Run, thread: Interaction, actorId: string): Interaction {
  const closed = rt.interactions.close(thread.id, "rejected", actorId);
  rt.events.emit({
    kind: "interaction.rejected",
    runId: run.id,
    stepId: thread.stepId,
    payload: { interactionId: thread.id, kind: thread.kind, by: actorId },
  });
  return closed;
}

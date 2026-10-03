import type { ArtifactVersion } from "../core/domain/artifact.ts";
import { ModelError } from "../models/errors.ts";
import { resolveModel } from "../models/router.ts";
import { generateStructured, StructuredOutputError } from "../models/structured.ts";
import type { Message, ToolDefinition } from "../models/types.ts";
import type { AgentRunner } from "../orchestration/executors.ts";
import type { StepContext, StepOutcome } from "../orchestration/types.ts";
import type { ToolResult } from "../tools/types.ts";
import { buildBaseMessages } from "./context.ts";
import type { AgentRegistry } from "./definition.ts";
import { packageForStep } from "./knowledge.ts";

/**
 * AgentRuntime (ADR-0001 §6): runs one agent for one step — context assembly, the tool-calling
 * loop through the policy-filtered BoundTools, intra-step checkpoints of the transcript
 * (ADR-0002 §4), and a final structured result stored as the step's artifact (ADR-0005).
 */
interface TranscriptState {
  readonly transcriptRef: string;
  readonly toolCalls: number;
  readonly modelCalls: number;
}

interface AgentResultDoc {
  outcome?: string;
  reasons?: Array<{ kind: string; summary: string }>;
  sources?: string[];
  candidates?: Array<{
    kind: string;
    title: string;
    rationale: string;
    evidence?: string[];
    proposal?: string;
  }>;
}

/** Knowledge candidates proposed by an agent become `candidate` artifacts (ADR-0020 §6). */
function storeCandidates(
  rt: StepContext["runtime"],
  ctx: StepContext,
  agentId: string,
  doc: AgentResultDoc,
  from: ArtifactVersion,
): void {
  for (const [i, c] of (doc.candidates ?? []).entries()) {
    rt.artifacts.put({
      runId: ctx.run.id,
      type: "candidate",
      name: `${ctx.step.id}-${ctx.iteration}-${i + 1}.json`,
      content: JSON.stringify(
        { ...c, from: `${from.artifactId}@${from.version}`, status: "proposed" },
        null,
        2,
      ),
      mediaType: "application/json",
      provenance: { kind: "agent", agentId },
      sourceRefs: c.evidence ?? [],
      stepId: ctx.step.id,
      iteration: ctx.iteration,
    });
  }
}

export class AgentRuntimeRunner implements AgentRunner {
  private readonly registry: AgentRegistry;

  constructor(registry: AgentRegistry) {
    this.registry = registry;
  }

  async run(ctx: StepContext): Promise<StepOutcome> {
    const def = this.registry.get(ctx.step.agent as string);
    if (!def) return { status: "failure", reason: `unknown agent "${ctx.step.agent}"` };
    const rt = ctx.runtime;
    const config = rt.loaded.config;

    const route = resolveModel(config, def.role, def.requires);
    const bound = rt.tools.bind({
      run: ctx.run,
      stepId: ctx.step.id,
      iteration: ctx.iteration,
      lease: ctx.lease,
      workspacePath: ctx.workspace.ref.path,
      agentCapabilities: def.capabilities,
      env: rt.env,
    });
    const toolDescriptors = bound.list();
    const toolDefs: ToolDefinition[] = toolDescriptors.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));

    const inputs = ctx.inputs
      .map((ref) => {
        const [artifactId, version] = ref.split("@");
        return rt.artifacts.get(artifactId as string, Number(version));
      })
      .filter((a): a is ArtifactVersion => a !== undefined)
      .map((artifact) => ({ artifact, text: rt.artifacts.text(artifact) }));
    const pkg = packageForStep(ctx, def.id);
    const charBudget = Math.floor(route.model.contextWindow * 0.45 * 3.5);
    const base = buildBaseMessages({
      def,
      ctx,
      tools: toolDescriptors,
      inputs,
      pkg,
      knowledgeConfig: config.knowledge,
      budget: { chars: charBudget },
    });

    const restored = ctx.restored as Partial<TranscriptState> | undefined;
    let transcript: Message[] = restored?.transcriptRef
      ? (JSON.parse(rt.blobs.getText(restored.transcriptRef)) as Message[])
      : [];
    let toolCalls = restored?.toolCalls ?? 0;
    let modelCalls = restored?.modelCalls ?? 0;
    const emit = (kind: string, payload: Record<string, unknown>) =>
      rt.events.emit({
        kind,
        runId: ctx.run.id,
        stepId: ctx.step.id,
        iteration: ctx.iteration,
        payload: { agent: def.id, ...payload },
      });
    emit("agent.start", {
      modelId: route.modelId,
      tools: toolDefs.length,
      restoredToolCalls: toolCalls,
      knowledge: pkg.provenance,
    });

    const checkpoint = () => {
      const transcriptRef = rt.blobs.put(JSON.stringify(transcript), "application/json").contentRef;
      ctx.saveCheckpoint({ transcriptRef, toolCalls, modelCalls } satisfies TranscriptState);
    };

    let budgetExhaustedNotice = false;
    for (;;) {
      if (ctx.cancelRequested()) {
        checkpoint();
        return { status: "failure", reason: "cancel requested" };
      }
      if (modelCalls >= def.limits.maxModelCalls) break;
      const allowTools = toolDefs.length > 0 && toolCalls < def.limits.maxToolCalls;
      if (!allowTools && toolDefs.length > 0 && !budgetExhaustedNotice) {
        transcript = [
          ...transcript,
          { role: "user", content: "Your tool budget for this step is used up. Finish with what you have." },
        ];
        budgetExhaustedNotice = true;
      }
      const response = await ctx.gateway.call({
        modelId: route.modelId,
        role: def.role,
        agentId: def.id,
        messages: [...base, ...transcript],
        ...(allowTools ? { tools: toolDefs } : {}),
        temperature: 0,
      });
      modelCalls += 1;
      if (response.toolCalls.length === 0) break;

      transcript = [
        ...transcript,
        { role: "assistant", content: response.text, toolCalls: response.toolCalls },
      ];
      for (const call of response.toolCalls) {
        let args: Record<string, unknown> = {};
        let parseError: string | undefined;
        try {
          const parsed: unknown = call.arguments.trim() ? JSON.parse(call.arguments) : {};
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            args = parsed as Record<string, unknown>;
          else parseError = "arguments must be a JSON object";
        } catch (error) {
          parseError = `arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
        }
        const result: ToolResult | undefined = parseError ? undefined : await bound.invoke(call.name, args);
        toolCalls += 1;
        transcript = [
          ...transcript,
          { role: "tool", toolCallId: call.id, content: formatToolResult(call.name, result, parseError) },
        ];
        if (toolCalls % def.limits.checkpointEvery === 0) checkpoint();
      }
    }

    // Finalization: the structured result document (ADR-0007 §4).
    const finalMessages: Message[] = [
      ...base,
      ...transcript,
      { role: "user", content: `Produce the result document for artifact type "${def.output.type}" now.` },
    ];
    try {
      const result = await generateStructured(ctx.gateway, {
        modelId: route.modelId,
        mode: route.structuredMode,
        name: def.output.type,
        schema: def.output.schema,
        messages: finalMessages,
        request: { role: def.role, agentId: def.id, temperature: 0 },
      });
      const doc = result.value as AgentResultDoc;
      const outcome = doc.outcome ?? "ok";
      if (outcome !== "ok" && !def.output.outcomes.includes(outcome)) {
        emit("agent.finish", {
          status: "failure",
          toolCalls,
          modelCalls: modelCalls + 1 + result.repairs,
          reason: "undeclared outcome",
        });
        return { status: "failure", reason: `agent ${def.id} produced undeclared outcome "${outcome}"` };
      }
      const artifact = rt.artifacts.put({
        runId: ctx.run.id,
        type: def.output.type,
        name: `${def.output.type}.json`,
        content: JSON.stringify(result.value, null, 2),
        mediaType: "application/json",
        provenance: { kind: "agent", agentId: def.id },
        // What the agent was told (ADR-0020 §4) joins what it read (ADR-0005).
        sourceRefs: [...(doc.sources ?? []), ...pkg.provenance],
        stepId: ctx.step.id,
        iteration: ctx.iteration,
      });
      storeCandidates(rt, ctx, def.id, doc, artifact);
      const reason = (doc.reasons ?? []).map((r) => `${r.kind}: ${r.summary}`).join("; ");
      emit("agent.finish", {
        status: "success",
        outcome,
        toolCalls,
        modelCalls: modelCalls + 1 + result.repairs,
        repairs: result.repairs,
        artifact: `${artifact.artifactId}@${artifact.version}`,
      });
      return {
        status: "success",
        ...(outcome !== "ok" ? { outcome } : {}),
        outputs: [`${artifact.artifactId}@${artifact.version}`],
        ...(reason ? { reason } : {}),
      };
    } catch (error) {
      if (error instanceof StructuredOutputError) {
        const invalid = rt.artifacts.put({
          runId: ctx.run.id,
          type: "invalid-output",
          name: `${def.output.type}.txt`,
          content: error.rawText,
          provenance: { kind: "agent", agentId: def.id },
          stepId: ctx.step.id,
          iteration: ctx.iteration,
        });
        emit("agent.finish", {
          status: "failure",
          toolCalls,
          modelCalls,
          reason: "invalid structured output",
          artifact: `${invalid.artifactId}@${invalid.version}`,
        });
        return {
          status: "failure",
          reason: error.message,
          outputs: [`${invalid.artifactId}@${invalid.version}`],
        };
      }
      if (error instanceof ModelError && error.kind === "quota_exhausted") checkpoint();
      throw error;
    }
  }
}

function formatToolResult(
  name: string,
  result: ToolResult | undefined,
  parseError: string | undefined,
): string {
  if (parseError) return `[${name}] error: ${parseError}`;
  if (!result) return `[${name}] error: no result`;
  if (result.denied) return `[${name}] denied: ${result.denied}`;
  const head = `[${name}] ${result.ok ? "ok" : `error: ${result.error ?? "failed"}`}`;
  return result.text ? `${head}\n${result.text}` : head;
}

import { ContextManager, effectiveWindow, resolveThresholds, summarizerMessages } from "../context/index.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import { ModelError } from "../models/errors.ts";
import { resolveModel } from "../models/router.ts";
import {
  extractJson,
  generateStructured,
  parseStructured,
  StructuredOutputError,
} from "../models/structured.ts";
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
export interface TranscriptState {
  readonly transcriptRef: string;
  readonly toolCalls: number;
  readonly modelCalls: number;
  /** Context management (ADR-0013): counters survive a resume; the rest serves `jarvis context|compact`. */
  readonly peakPressure?: number;
  readonly trims?: number;
  readonly compactions?: number;
  readonly resets?: number;
  readonly baseTokens?: number;
  readonly effective?: number;
  readonly modelId?: string;
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
    const pkg = await packageForStep(ctx, def.id);
    // L3/L4 are sized from the window actually used: `context.maxContext` caps it (pilot: a model with a
    // 1M window and maxContext 200k got a knowledge share sized for 1M)
    const window = Math.min(
      route.model.contextWindow,
      config.context.maxContext ?? route.model.contextWindow,
    );
    const charBudget = Math.floor(window * 0.45 * 3.5);
    const buildBase = (chars: number) =>
      buildBaseMessages({
        def,
        ctx,
        tools: toolDescriptors,
        inputs,
        pkg,
        knowledgeConfig: config.knowledge,
        budget: { chars },
      });
    let base = buildBase(charBudget);

    const restored = ctx.restored as Partial<TranscriptState> | undefined;
    let transcript: Message[] = restored?.transcriptRef
      ? (JSON.parse(rt.blobs.getText(restored.transcriptRef)) as Message[])
      : [];
    // project/user `agents.<id>.limits` over the built-in ones
    const override = config.agents[def.id]?.limits;
    const limits = {
      ...def.limits,
      maxToolCalls: override?.maxToolCalls ?? def.limits.maxToolCalls,
      maxModelCalls: override?.maxModelCalls ?? def.limits.maxModelCalls,
    };
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
      maxToolCalls: limits.maxToolCalls,
      maxModelCalls: limits.maxModelCalls,
      restoredToolCalls: toolCalls,
      knowledge: pkg.provenance,
    });

    // Context pressure (ADR-0013): trim / compact / reset before a call would run into the window.
    const estimate = (messages: readonly Message[]) =>
      rt.gateway.estimator.estimateMessages(route.modelId, route.model.tokenizer, messages, toolDefs);
    const roleMaxOutput = config.roles[def.role]?.maxOutput;
    const effective = effectiveWindow({
      contextWindow: route.model.contextWindow,
      maxOutput: route.model.maxOutput,
      ...(config.context.maxContext ? { maxContext: config.context.maxContext } : {}),
      ...(roleMaxOutput ? { roleMaxOutput } : {}),
    });
    const summarizerRoute = (() => {
      try {
        return resolveModel(config, "compaction", { tools: false });
      } catch {
        return route; // no `compaction` role configured: the agent's own model summarises
      }
    })();
    const manager = new ContextManager(
      {
        effective,
        thresholds: resolveThresholds(config.context, route.modelId, ctx.step.phase),
        compactTarget: config.context.compactTarget,
        estimate,
        store: (text) => rt.blobs.put(text, "text/plain").contentRef,
        summarize: async (rendered, previous) => {
          modelCalls += 1;
          const response = await ctx.gateway.call({
            modelId: summarizerRoute.modelId,
            role: summarizerRoute === route ? def.role : "compaction",
            agentId: def.id,
            messages: summarizerMessages(rendered, previous),
            temperature: 0,
            maxOutput: Math.min(2000, summarizerRoute.model.maxOutput),
          });
          return response.text;
        },
        // Aggressive pressure also tightens L3/L4: the same inputs under a smaller budget.
        tighten: () => buildBase(Math.floor(charBudget * 0.6)),
        emit,
      },
      {
        peakPressure: restored?.peakPressure ?? 0,
        trims: restored?.trims ?? 0,
        compactions: restored?.compactions ?? 0,
        resets: restored?.resets ?? 0,
      },
    );
    const manage = async () => {
      const r = await manager.manage(base, transcript);
      base = r.base;
      transcript = r.transcript;
    };

    const checkpoint = () => {
      const transcriptRef = rt.blobs.put(JSON.stringify(transcript), "application/json").contentRef;
      ctx.saveCheckpoint({
        transcriptRef,
        toolCalls,
        modelCalls,
        ...manager.stats,
        baseTokens: estimate(base),
        effective,
        modelId: route.modelId,
      } satisfies TranscriptState);
    };

    let budgetExhaustedNotice = false;
    /** Which limit ended the loop, if one did: the result may be incomplete (pilot: silent partial maps). */
    let budgetExhausted: "tools" | "model" | undefined;
    /** The answer the loop ended with (no tool calls) — often the result document already. */
    let finalAnswer: string | undefined;
    for (;;) {
      if (ctx.cancelRequested()) {
        checkpoint();
        return { status: "failure", reason: "cancel requested" };
      }
      if (modelCalls >= limits.maxModelCalls) {
        budgetExhausted = "model";
        break;
      }
      const allowTools = toolDefs.length > 0 && toolCalls < limits.maxToolCalls;
      if (!allowTools && toolDefs.length > 0 && !budgetExhaustedNotice) {
        budgetExhausted = "tools";
        transcript = [
          ...transcript,
          { role: "user", content: "Your tool budget for this step is used up. Finish with what you have." },
        ];
        budgetExhaustedNotice = true;
      }
      await manage();
      const response = await ctx.gateway.call({
        modelId: route.modelId,
        role: def.role,
        agentId: def.id,
        messages: [...base, ...transcript],
        ...(allowTools ? { tools: toolDefs } : {}),
        temperature: 0,
      });
      modelCalls += 1;
      if (response.toolCalls.length === 0) {
        finalAnswer = response.text;
        break;
      }

      transcript = [
        ...transcript,
        { role: "assistant", content: response.text, toolCalls: response.toolCalls },
      ];
      for (const call of response.toolCalls) {
        // several calls in one answer may overrun the limit (pilot: 41/40): each needs an answer,
        // the ones past the limit get "skipped" instead of running
        if (toolCalls >= limits.maxToolCalls) {
          budgetExhausted = "tools";
          transcript = [
            ...transcript,
            {
              role: "tool",
              toolCallId: call.id,
              content: `[${call.name}] skipped: the tool budget for this step is used up`,
            },
          ];
          continue;
        }
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
        if (toolCalls % limits.checkpointEvery === 0) checkpoint();
      }
    }

    // Finalization: the structured result document (ADR-0007 §4). When the loop already ended with a
    // valid document, that is the result: asking again cost the pilot two slow calls, and the second
    // answer echoed the JSON Schema instead of filling it.
    const early =
      finalAnswer !== undefined && finalAnswer.trim() !== ""
        ? parseStructured(finalAnswer, def.output.schema)
        : undefined;
    try {
      let result: { value: unknown; repairs: number; calls: number };
      if (early?.ok) {
        result = { value: early.value, repairs: 0, calls: 0 };
      } else {
        await manage();
        const produce = `Produce the result document for artifact type "${def.output.type}" now.`;
        const finalMessages: Message[] = [
          ...base,
          ...transcript,
          // keep the answer the loop ended with: the model fixes it instead of writing it from scratch
          ...(early && finalAnswer !== undefined
            ? [
                { role: "assistant" as const, content: finalAnswer },
                {
                  role: "user" as const,
                  // prose is just context; a document that misses the schema gets its issues
                  content:
                    extractJson(finalAnswer) === undefined
                      ? produce
                      : `${produce} Your answer above does not match the required schema:\n- ${early.issues.join("\n- ")}`,
                },
              ]
            : [{ role: "user" as const, content: produce }]),
        ];
        const generated = await generateStructured(ctx.gateway, {
          modelId: route.modelId,
          mode: route.structuredMode,
          name: def.output.type,
          schema: def.output.schema,
          messages: finalMessages,
          request: { role: def.role, agentId: def.id, temperature: 0 },
        });
        result = { value: generated.value, repairs: generated.repairs, calls: 1 + generated.repairs };
      }
      const doc = result.value as AgentResultDoc;
      const outcome = doc.outcome ?? "ok";
      if (outcome !== "ok" && !def.output.outcomes.includes(outcome)) {
        emit("agent.finish", {
          status: "failure",
          toolCalls,
          modelCalls: modelCalls + result.calls,
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
        provenance: { kind: "agent", agentId: def.id, ...(budgetExhausted ? { budgetExhausted } : {}) },
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
        context: { ...manager.stats, effective },
        toolCalls,
        modelCalls: modelCalls + result.calls,
        repairs: result.repairs,
        finalizedFromLoop: result.calls === 0,
        artifact: `${artifact.artifactId}@${artifact.version}`,
        ...(budgetExhausted ? { budgetExhausted } : {}),
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
      // the run parks (quota window, or a model that is down): keep the conversation to go on from
      if (error instanceof ModelError && (error.kind === "quota_exhausted" || error.kind === "transient"))
        checkpoint();
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

import { BudgetExceededError, grantsFromEvents } from "../budget/runBudget.ts";
import {
  ContextManager,
  effectiveWindow,
  resolveThresholds,
  SUMMARY_MAX_OUTPUT,
  summarizerMessages,
} from "../context/index.ts";
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
import { InterruptedError, interruption } from "../orchestration/interrupt.ts";
import { type StepContext, type StepOutcome, SuspendRun } from "../orchestration/types.ts";
import type { ToolResult } from "../tools/types.ts";
import { buildBaseMessages } from "./context.ts";
import type { AgentRegistry } from "./definition.ts";
import { packageForStep } from "./knowledge.ts";
import { ReadLedger, readKey } from "./rereads.ts";
import { SearchLedger } from "./searches.ts";

/** The agent's "I have what I need": the document is asked for next (system rule in context.ts). */
export const saidDone = (text: string): boolean => /^\s*\**DONE\b/i.test(text);

/** Calls of one answer that run at once at most (reads without effects). */
export const PARALLEL_TOOLS = 6;

/** Tools that change the workspace: an agent with them that only reads is nudged, then stopped. */
const WRITE_TOOLS = new Set(["repo.write", "repo.edit"]);
/** Model calls without an edit before the first nudge (the second at twice, the stop at three times). */
export const IDLE_CALLS = 12;

/** Runs `work` over the items, at most `limit` at a time; settles when all have. */
export async function inParallel<T>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const k = next;
      next += 1;
      await work(items[k] as T, k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

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
    // reads without effects may run side by side; a write, a command, an effect runs alone and in order
    const readOnly = new Set(
      toolDescriptors.filter((t) => t.access === "read" && !t.effect).map((t) => t.name),
    );
    const parallelOk = (name: string) => readOnly.has(name);
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
    // project/user `agents.<id>.limits` over the built-in ones, plus what a person granted on a stop
    const override = config.agents[def.id]?.limits;
    const grants = grantsFromEvents(rt.db.db, ctx.run.id, ctx.step.id, ctx.iteration);
    // in the pool's unlimited hours the limits grow (`unlimitedScale`), read anew at every check: a
    // step that began at night is held to the day's limits once the night is over
    const toolLimit = override?.maxToolCalls ?? def.limits.maxToolCalls;
    const modelLimit = override?.maxModelCalls ?? def.limits.maxModelCalls;
    const scale = () => rt.budget.scaleNow(route.pool);
    const limits = {
      ...def.limits,
      get maxToolCalls() {
        return toolLimit * scale() + grants.toolCalls;
      },
      get maxModelCalls() {
        return modelLimit * scale() + grants.modelCalls;
      },
    };
    // a used-up limit: finish with what there is (marked incomplete), or — `onLimit: ask`, a person at
    // hand — the run waits for more calls or "finish"; never asks where nobody answers (CI)
    const ask =
      (config.agents[def.id]?.onLimit ?? ctx.step.onLimit ?? "finish") === "ask" &&
      config.interactive !== false &&
      !grants.finish;
    // files read in this step, from the conversation itself (src/agents/rereads.ts)
    const reads = ReadLedger.from(transcript);
    const searches = SearchLedger.from(transcript);
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
      ...(grants.toolCalls + grants.modelCalls > 0
        ? { granted: { toolCalls: grants.toolCalls, modelCalls: grants.modelCalls } }
        : {}),
      ...(grants.finish ? { finishing: true } : {}),
      ...(ask ? { onLimit: "ask" } : {}),
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
            maxOutput: Math.min(SUMMARY_MAX_OUTPUT, summarizerRoute.model.maxOutput),
          });
          return { text: response.text, truncated: response.finishReason === "length" };
        },
        // Aggressive pressure also tightens L3/L4: the same inputs under a smaller budget.
        tighten: () => buildBase(Math.floor(charBudget * 0.6)),
        emit,
        pinned: (id) => reads.pinned(id),
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
    let budgetExhausted: "tools" | "model" | "budget" | undefined;
    /** The run parks with the conversation kept: the step goes on from here on resume. */
    const parkable = (error: unknown) =>
      error instanceof InterruptedError ||
      error instanceof BudgetExceededError ||
      (error instanceof ModelError && (error.kind === "quota_exhausted" || error.kind === "transient"));
    /** `onLimit: ask`: keep the conversation and wait for a person — more calls, or finish. */
    const parkOnLimit = (dimension: "toolCalls" | "modelCalls", used: number, cap: number): never => {
      checkpoint();
      const what = dimension === "toolCalls" ? "tool calls" : "model calls";
      emit("agent.limit", { dimension, used, cap, onLimit: "ask" });
      throw new SuspendRun(
        "WAITING_HUMAN",
        `${def.id} used its ${cap} ${what}: more, or finish with what it has`,
        {
          checkpointState: { budget: { scope: "agent", dimension, used, cap, agent: def.id } },
          waitingFor: { kind: "budget", detail: `agent ${dimension}` },
        },
      );
    };
    /** The answer the loop ended with (no tool calls) — often the result document already. */
    let finalAnswer: string | undefined;
    // an agent that changes the workspace and only reads: told to start, then stopped (pilot: an
    // implementation read for 64 model calls and 268 tools, trimming and reading back, and edited nothing)
    // the implementation only: the agents of verify (tests, telemetry) may rightly find nothing to change
    // (pilot: both were told to «start the plan step» while they checked)
    const writer =
      def.output.type === "implementation" &&
      (toolDefs.some((t) => WRITE_TOOLS.has(t.name)) || def.capabilities.some((c) => WRITE_TOOLS.has(c)));
    let lastEdit = modelCalls;
    for (;;) {
      if (ctx.cancelRequested()) {
        checkpoint();
        return { status: "failure", reason: "cancel requested" };
      }
      if (grants.finish) {
        // a person said "finish with what it has": straight to the result document
        budgetExhausted =
          toolCalls >= limits.maxToolCalls
            ? "tools"
            : modelCalls >= limits.maxModelCalls
              ? "model"
              : "budget";
        break;
      }
      // Ctrl-C between calls: keep the conversation, park the run (src/orchestration/interrupt.ts)
      if (interruption.requested) checkpoint();
      interruption.throwIfRequested();
      if (modelCalls >= limits.maxModelCalls) {
        if (ask) parkOnLimit("modelCalls", modelCalls, limits.maxModelCalls);
        budgetExhausted = "model";
        break;
      }
      const allowTools = toolDefs.length > 0 && toolCalls < limits.maxToolCalls;
      if (!allowTools && toolDefs.length > 0 && !budgetExhaustedNotice) {
        if (ask) parkOnLimit("toolCalls", toolCalls, limits.maxToolCalls);
        budgetExhausted = "tools";
        transcript = [
          ...transcript,
          { role: "user", content: "Your tool budget for this step is used up. Finish with what you have." },
        ];
        budgetExhaustedNotice = true;
      }
      let response: Awaited<ReturnType<typeof ctx.gateway.call>>;
      try {
        await manage();
        response = await ctx.gateway.call({
          modelId: route.modelId,
          role: def.role,
          agentId: def.id,
          messages: [...base, ...transcript],
          ...(allowTools ? { tools: toolDefs } : {}),
          temperature: 0,
        });
      } catch (error) {
        // a cap of the run, the quota window, a model that is down: go on from this very call later
        if (parkable(error)) checkpoint();
        throw error;
      }
      modelCalls += 1;
      if (response.toolCalls.length === 0) {
        finalAnswer = response.text;
        break;
      }

      transcript = [
        ...transcript,
        { role: "assistant", content: response.text, toolCalls: response.toolCalls },
      ];
      const callsBefore = toolCalls;
      // 1. what runs: in order, past the limit "skipped" (pilot: 41/40 — several calls in one answer may
      //    overrun it, and each needs an answer); arguments that are not a JSON object are answered as such
      const planned = response.toolCalls.map((call) => {
        if (toolCalls >= limits.maxToolCalls) {
          budgetExhausted = "tools";
          return { call, args: {} as Record<string, unknown>, skipped: true as const };
        }
        toolCalls += 1;
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
        return { call, args, ...(parseError ? { parseError } : {}) };
      });
      // 2. the calls of one answer at once: reads without effects side by side (a few at a time), the rest
      //    alone and in order; their answers go into the transcript in the order asked, as before
      const runnable = planned
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => !("skipped" in p) && !("parseError" in p && p.parseError));
      const results: Array<ToolResult | undefined> = planned.map(() => undefined);
      const batch = modelCalls;
      if (runnable.length > 1)
        emit("tool.batch", {
          modelCall: batch,
          size: runnable.length,
          parallel: runnable.filter(({ p }) => parallelOk(p.call.name)).length > 1,
          calls: runnable.map(({ p }) => ({
            capability: p.call.name,
            args: rt.redactor.redact(JSON.stringify(p.args)).text.slice(0, 600),
          })),
        });
      const invoke = async ({ p, i }: (typeof runnable)[number], slot: number) => {
        results[i] = await bound.invoke(
          p.call.name,
          p.args,
          runnable.length > 1 ? { batch, slot } : undefined,
        );
      };
      for (let at = 0; at < runnable.length; ) {
        const group: Array<(typeof runnable)[number]> = [];
        while (at < runnable.length && parallelOk((runnable[at] as (typeof runnable)[number]).p.call.name)) {
          group.push(runnable[at] as (typeof runnable)[number]);
          at += 1;
        }
        if (group.length === 0) {
          await invoke(runnable[at] as (typeof runnable)[number], at);
          at += 1;
          continue;
        }
        const start = at - group.length;
        await inParallel(group, PARALLEL_TOOLS, (item, k) => invoke(item, start + k));
      }
      // 3. the answers, in the order the model asked
      for (const [i, p] of planned.entries()) {
        const { call, args } = p;
        if ("skipped" in p) {
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
        const parseError = "parseError" in p ? p.parseError : undefined;
        // the same file again: a pointer while its text is still above, else the text kept this time
        const key = parseError ? undefined : readKey(call.name, args);
        const answered = reads.answer(
          key,
          call.id,
          formatToolResult(call.name, results[i], parseError),
          transcript,
        );
        if (answered.kind !== "first")
          emit("tool.reread", { capability: call.name, path: args.path, kind: answered.kind });
        // the same empty search again: it ran, and the answer says it was empty before too
        const sought = searches.answer(call.name, args, call.id, answered.content);
        if (sought.kind !== "first")
          emit("tool.repeat", { capability: call.name, pattern: args.pattern, kind: sought.kind });
        transcript = [...transcript, { role: "tool", toolCallId: call.id, content: sought.content }];
      }
      // after the whole answer: a checkpoint mid-way would keep tool calls without their results
      if (Math.floor(toolCalls / limits.checkpointEvery) > Math.floor(callsBefore / limits.checkpointEvery))
        checkpoint();
      if (writer) {
        if (planned.some((p, i) => WRITE_TOOLS.has(p.call.name) && results[i]?.ok === true))
          lastEdit = modelCalls;
        const idle = modelCalls - lastEdit;
        if (idle >= IDLE_CALLS * 3) {
          emit("agent.idle", { modelCalls: idle, stopped: true });
          transcript = [
            ...transcript,
            {
              role: "user",
              content: `${idle} model calls without a single edit: stop reading. Produce the result document now; in notes, say what you did and what keeps you from editing.`,
            },
          ];
          break;
        }
        if (idle === IDLE_CALLS || idle === IDLE_CALLS * 2) {
          emit("agent.idle", { modelCalls: idle, nudged: true });
          transcript = [
            ...transcript,
            {
              role: "user",
              content: `${idle} model calls and no edit yet. You have read enough: start the first open step of the plan now — read only that step's files, edit, verify, mark it with plan.step, then the next step.${idle >= IDLE_CALLS * 2 ? ` After ${IDLE_CALLS} more calls without an edit the step stops.` : ""}`,
            },
          ];
        }
      }
    }

    // Finalization: the structured result document (ADR-0007 §4). When the loop already ended with a
    // valid document, that is the result: asking again cost the pilot two slow calls, and the second
    // answer echoed the JSON Schema instead of filling it.
    const early =
      finalAnswer !== undefined && finalAnswer.trim() !== "" && !saidDone(finalAnswer)
        ? parseStructured(finalAnswer, def.output.schema)
        : undefined;
    // how the loop ended: the agent said DONE (the document is asked for now), wrote the document anyway,
    // answered in prose, or nothing (its output limit spent on thinking)
    const endedWith =
      finalAnswer === undefined
        ? "limit"
        : finalAnswer.trim() === ""
          ? "empty"
          : saidDone(finalAnswer)
            ? "done"
            : early?.ok
              ? "document"
              : "text";
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
          ...(endedWith === "done" && finalAnswer !== undefined
            ? [
                // what the agent said is still unknown goes with the request
                { role: "assistant" as const, content: finalAnswer.trim() },
                { role: "user" as const, content: produce },
              ]
            : early && finalAnswer !== undefined
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
        endedWith,
        artifact: `${artifact.artifactId}@${artifact.version}`,
        ...(budgetExhausted ? { budgetExhausted } : {}),
        ...((n) => (n > 0 ? { contradictions: n } : {}))(contradictionsIn(result.value)),
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
      // the run parks (quota window, a model that is down, Ctrl-C): keep the conversation to go on from
      if (parkable(error)) checkpoint();
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

/** How many contradictions a result lists (research, requirements): shown with the step, not buried. */
function contradictionsIn(value: unknown): number {
  const list = (value as { contradictions?: unknown } | undefined)?.contradictions;
  return Array.isArray(list) ? list.length : 0;
}

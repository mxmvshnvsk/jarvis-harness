import type { Runtime } from "../app/runtime.ts";
import {
  compactTranscript,
  effectiveWindow,
  isHandoff,
  levelOf,
  type PressureLevel,
  pressureOf,
  resolveThresholds,
  SUMMARY_MAX_OUTPUT,
  splitBlocks,
  summarizerMessages,
  type Thresholds,
  TRIMMED_MARKER,
  trimToolResults,
} from "../context/index.ts";
import type { Run } from "../core/domain/run.ts";
import { resolveModel } from "../models/router.ts";
import type { Message } from "../models/types.ts";
import { loadWorkflows } from "../workflows/load.ts";
import type { TranscriptState } from "./runner.ts";

/**
 * Manual context controls (ADR-0001 §15, ADR-0013): `jarvis context | compact | reset-context`
 * work on the transcript the agent loop checkpointed for the step a parked run stands in. The
 * next `resume` continues from the reshaped transcript; originals stay in the blob store.
 */
export interface StepTranscript {
  readonly stepId: string;
  readonly iteration: number;
  readonly state: TranscriptState;
  readonly transcript: Message[];
}

/** The transcript of the step the run is in — only while that step's latest checkpoint is intra-step. */
export function currentTranscript(rt: Runtime, run: Run): StepTranscript | undefined {
  // A parked run also has a `suspend` checkpoint on top; the transcript is the last non-suspend one.
  const latest = rt.checkpoints
    .list(run.id)
    .filter((c) => c.kind !== "suspend")
    .at(-1);
  if (latest?.kind !== "intra") return undefined;
  const state = latest.state as Partial<TranscriptState>;
  if (!state.transcriptRef || !rt.blobs.has(state.transcriptRef)) return undefined;
  return {
    stepId: latest.stepId,
    iteration: latest.iteration,
    state: state as TranscriptState,
    transcript: JSON.parse(rt.blobs.getText(state.transcriptRef)) as Message[],
  };
}

function phaseOf(rt: Runtime, run: Run, stepId: string): string | undefined {
  const workflow = loadWorkflows(rt.loaded.project?.root).get(run.workflow);
  return workflow?.steps.find((s) => s.id === stepId)?.phase;
}

export interface ContextView {
  readonly stepId: string;
  readonly iteration: number;
  readonly modelId: string;
  readonly effective: number;
  readonly baseTokens: number;
  readonly transcriptTokens: number;
  readonly messages: number;
  readonly blocks: number;
  readonly handoffs: number;
  readonly trimmedResults: number;
  readonly pressure: number;
  readonly level: PressureLevel;
  readonly thresholds: Thresholds;
  readonly peakPressure: number;
  readonly trims: number;
  readonly compactions: number;
  readonly resets: number;
}

export function inspectContext(rt: Runtime, run: Run): ContextView | undefined {
  const t = currentTranscript(rt, run);
  if (!t?.state.modelId) return undefined;
  const config = rt.loaded.config;
  const model = config.models[t.state.modelId];
  const effective =
    t.state.effective ??
    (model ? effectiveWindow({ contextWindow: model.contextWindow, maxOutput: model.maxOutput }) : 0);
  const baseTokens = t.state.baseTokens ?? 0;
  const transcriptTokens = rt.gateway.estimator.estimateMessages(
    t.state.modelId,
    model?.tokenizer,
    t.transcript,
  );
  const thresholds = resolveThresholds(config.context, t.state.modelId, phaseOf(rt, run, t.stepId));
  const pressure = pressureOf(baseTokens + transcriptTokens, effective);
  return {
    stepId: t.stepId,
    iteration: t.iteration,
    modelId: t.state.modelId,
    effective,
    baseTokens,
    transcriptTokens,
    messages: t.transcript.length,
    blocks: splitBlocks(t.transcript).length,
    handoffs: t.transcript.filter((m) => isHandoff(m)).length,
    trimmedResults: t.transcript.filter((m) => m.role === "tool" && m.content.includes(TRIMMED_MARKER))
      .length,
    pressure,
    level: levelOf(pressure, thresholds),
    thresholds,
    peakPressure: t.state.peakPressure ?? 0,
    trims: t.state.trims ?? 0,
    compactions: t.state.compactions ?? 0,
    resets: t.state.resets ?? 0,
  };
}

export type ReshapeKind = "compact" | "aggressive" | "reset";

export interface ReshapeReport {
  readonly kind: ReshapeKind;
  readonly dryRun: boolean;
  readonly stepId: string;
  readonly blocksBefore: number;
  readonly blocksCompacted: number;
  readonly trimmed: number;
  readonly tokensBefore: number;
  readonly tokensAfter?: number;
  readonly originals: string[];
}

/** Trims and compacts (or resets) the checkpointed transcript; `dryRun` reports the plan without a model call. */
export async function reshapeContext(
  rt: Runtime,
  run: Run,
  options: { kind: ReshapeKind; dryRun: boolean },
): Promise<ReshapeReport> {
  const t = currentTranscript(rt, run);
  if (!t?.state.modelId)
    throw new Error("the run has no checkpointed agent transcript (the step has not run a tool round yet)");
  const config = rt.loaded.config;
  const modelId = t.state.modelId;
  const model = config.models[modelId];
  const estimate = (messages: readonly Message[]) =>
    rt.gateway.estimator.estimateMessages(modelId, model?.tokenizer, messages);
  const baseTokens = t.state.baseTokens ?? 0;
  const effective = t.state.effective ?? 0;
  const tokensBefore = baseTokens + estimate(t.transcript);
  const blocksBefore = splitBlocks(t.transcript).length;
  const store = (text: string) => rt.blobs.put(text, "text/plain").contentRef;

  const keepRecent = options.kind === "reset" ? 0 : options.kind === "aggressive" ? 2 : 4;
  const trimmed =
    options.kind === "reset"
      ? { transcript: t.transcript, trimmed: 0, savedChars: 0 }
      : trimToolResults(
          t.transcript,
          options.dryRun
            ? { keepRecent, store: () => "dry-run" }
            : { keepRecent, ...(options.kind === "aggressive" ? { minChars: 300 } : {}), store },
        );
  const keepBlocks = options.kind === "reset" ? 0 : options.kind === "aggressive" ? 2 : 3;
  const share = config.context.compactTarget * (options.kind === "aggressive" ? 0.7 : 1);
  const tailBudget = Math.max(Math.floor(share * effective - baseTokens), Math.floor(0.1 * effective));

  // The `compaction` role when configured, else the model the agent was already using.
  let summarizerModelId = modelId;
  let summarizerMaxOutput = model?.maxOutput ?? 1000;
  try {
    const route = resolveModel(config, "compaction", { tools: false });
    summarizerModelId = route.modelId;
    summarizerMaxOutput = route.model.maxOutput;
  } catch {
    // no compaction role
  }
  const summarizeVia = async (rendered: string, previous?: string) => {
    const response = await rt.gateway.call({
      modelId: summarizerModelId,
      role: "compaction",
      runId: run.id,
      stepId: t.stepId,
      iteration: t.iteration,
      messages: summarizerMessages(rendered, previous),
      temperature: 0,
      maxOutput: Math.min(SUMMARY_MAX_OUTPUT, summarizerMaxOutput),
    });
    return { text: response.text, truncated: response.finishReason === "length" };
  };

  const compacted = await compactTranscript(trimmed.transcript, {
    keepBlocks,
    ...(keepBlocks > 0 ? { tailBudgetTokens: tailBudget } : {}),
    estimate,
    store: options.dryRun ? () => "dry-run" : store,
    summarize: options.dryRun ? async () => "(dry run)" : summarizeVia,
    kind: options.kind === "reset" ? "reset" : "compact",
    ...(options.dryRun
      ? {}
      : {
          onSummarize: (blocks: number) =>
            rt.events.emit({
              kind: "context.compacting",
              runId: run.id,
              stepId: t.stepId,
              iteration: t.iteration,
              payload: { manual: true, kind: options.kind, tokens: tokensBefore, blocks },
            }),
        }),
  });
  const next = compacted?.transcript ?? trimmed.transcript;
  const report: ReshapeReport = {
    kind: options.kind,
    dryRun: options.dryRun,
    stepId: t.stepId,
    blocksBefore,
    blocksCompacted: compacted?.compactedBlocks ?? 0,
    trimmed: trimmed.trimmed,
    tokensBefore,
    ...(options.dryRun ? {} : { tokensAfter: baseTokens + estimate(next) }),
    originals: compacted?.originals ?? [],
  };
  if (options.dryRun) return report;

  const transcriptRef = rt.blobs.put(JSON.stringify(next), "application/json").contentRef;
  const state: TranscriptState = {
    ...t.state,
    transcriptRef,
    trims: (t.state.trims ?? 0) + (trimmed.trimmed > 0 ? 1 : 0),
    compactions: (t.state.compactions ?? 0) + (compacted && options.kind !== "reset" ? 1 : 0),
    resets: (t.state.resets ?? 0) + (compacted && options.kind === "reset" ? 1 : 0),
  };
  rt.checkpoints.save({
    runId: run.id,
    stepId: t.stepId,
    iteration: t.iteration,
    kind: "intra",
    state: { ...state },
  });
  rt.events.emit({
    kind: options.kind === "reset" ? "context.reset" : "context.compacted",
    runId: run.id,
    stepId: t.stepId,
    iteration: t.iteration,
    payload: {
      manual: true,
      mode: options.kind,
      before: tokensBefore,
      after: report.tokensAfter,
      blocks: report.blocksCompacted,
      trimmed: report.trimmed,
      ...(compacted?.fallback ? { fallback: compacted.fallback } : {}),
      originals: report.originals,
    },
  });
  return report;
}

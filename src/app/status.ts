import type { Approval } from "../artifacts/store.ts";
import type { WindowUsage } from "../budget/usage.ts";
import type { ProjectCapabilities } from "../capabilities/registry.ts";
import type { QuotaPool } from "../core/config/schema.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import type { Interaction } from "../interaction/store.ts";
import type { Checkpoint, StepRecord } from "../storage/checkpoints.ts";
import type { EffectRecord } from "../storage/effects.ts";
import type { StoredEvent } from "../telemetry/events.ts";
import { type Activity, activityOf, type FormatOptions } from "./activity.ts";
import type { Runtime } from "./runtime.ts";
import { MASTER_WORKFLOW, masterOf, type SubtaskView, splitOf, subtasksOf } from "./subtasks.ts";

/**
 * Status data for `jarvis status` and, later, the TUI (ADR-0018 §1, §3). Pure reads over the
 * stores — no runtime participation.
 */
export interface PoolStatus {
  readonly pool: string;
  readonly usage: WindowUsage;
  readonly limits: QuotaPool["limits"];
  readonly windowMinutes: number;
  readonly soft: number;
  readonly pressure: number;
}

export interface RunsOverview {
  readonly runs: readonly Run[];
  readonly pools: readonly PoolStatus[];
}

export interface RunTokens {
  readonly calls: number;
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly retries: number;
  /** Some of `cachedTokens` is Jarvis's estimate (models.<id>.prefixCache), not the gateway's word. */
  readonly cachedEstimated?: boolean;
}

export interface RunDetail {
  readonly run: Run;
  readonly steps: readonly StepRecord[];
  readonly checkpoint?: Checkpoint;
  readonly artifacts: readonly (ArtifactVersion & { readonly approved: boolean })[];
  readonly pendingApprovals: readonly ArtifactVersion[];
  readonly approvals: readonly Approval[];
  readonly effects: { readonly counts: Record<string, number>; readonly recent: readonly EffectRecord[] };
  readonly events: readonly StoredEvent[];
  readonly tokens: RunTokens;
  readonly leaseLive: boolean;
  /** Open human interactions (ADR-0019 §2). */
  readonly interactions: readonly Interaction[];
  /** ADR-0021 §7: the capability level the run works at. */
  readonly capabilities?: ProjectCapabilities;
  /** What the run does right now, from its events (ADR-0018). */
  readonly activity?: Activity;
  readonly activityOptions?: FormatOptions;
  /** A subtask of a task across services (ADR-0025 §6): its master and its place. */
  readonly subtaskOf?: {
    readonly master: Run;
    readonly key: string;
    readonly service?: string;
    readonly of: number;
  };
  /** A master: its subtasks. */
  readonly subtasks?: readonly SubtaskView[];
}

/** Artifact types that pass through a human gate and therefore may be awaiting approval. */
export const GATED_ARTIFACT_TYPES = [
  "spec",
  "plan",
  "review",
  "implementation",
  "split",
  "contract-check",
] as const;

export function poolStatuses(runtime: Runtime): PoolStatus[] {
  return Object.entries(runtime.loaded.config.quotaPools).map(([pool, def]) => {
    const usage = runtime.budget.windowUsage(pool) as WindowUsage;
    const ratios: number[] = [];
    if (def.limits.outputTokens) ratios.push(usage.outputTokens / def.limits.outputTokens);
    if (def.limits.inputTokens) ratios.push(usage.promptTokens / def.limits.inputTokens);
    if (def.limits.requests) ratios.push(usage.requests / def.limits.requests);
    return {
      pool,
      usage,
      limits: def.limits,
      windowMinutes: def.window.minutes,
      soft: def.soft,
      pressure: ratios.length > 0 ? Math.max(...ratios) : 0,
    };
  });
}

export function runsOverview(
  runtime: Runtime,
  options: { includeTerminal?: boolean; limit?: number } = {},
): RunsOverview {
  return {
    runs: runtime.runs.list({
      includeTerminal: options.includeTerminal ?? false,
      limit: options.limit ?? 50,
    }),
    pools: poolStatuses(runtime),
  };
}

function capabilitiesOf(
  runtime: Runtime,
  latest: readonly ArtifactVersion[],
): { capabilities?: ProjectCapabilities } {
  const a = latest.find((x) => x.type === "project-capabilities");
  if (!a) return {};
  try {
    return { capabilities: JSON.parse(runtime.artifacts.text(a)) as ProjectCapabilities };
  } catch {
    return {};
  }
}

export function runDetail(runtime: Runtime, run: Run, now: Date = new Date()): RunDetail {
  const steps = runtime.history.list(run.id);
  const checkpoint = runtime.checkpoints.latest(run.id);
  const latest = runtime.artifacts.listLatest(run.id);
  const artifacts = latest.map((a) => ({
    ...a,
    approved: runtime.artifacts.isApproved(a.artifactId).approved,
  }));
  const approvals = latest.flatMap((a) => runtime.artifacts.approvalsFor(a.artifactId));
  const pendingApprovals = runtime.artifacts.pendingApprovals(run.id, GATED_ARTIFACT_TYPES);
  const allEffects = runtime.effects.byRun(run.id);
  const counts: Record<string, number> = {};
  for (const e of allEffects) counts[e.status] = (counts[e.status] ?? 0) + 1;
  const events = runtime.events.list({ runId: run.id, limit: 5000 });
  const tokens: RunTokens = events
    .filter((e) => e.kind === "model.call")
    .reduce<RunTokens>(
      (acc, e) => {
        const p = (e.payload ?? {}) as Record<string, number>;
        // a gateway that reports no cache: Jarvis's estimate from the prompt shared with the call before
        const estimated = !p.cachedTokens && (p.cachedEstimated ?? 0) > 0;
        return {
          calls: acc.calls + 1,
          promptTokens: acc.promptTokens + (p.promptTokens ?? 0),
          cachedTokens: acc.cachedTokens + (p.cachedTokens || p.cachedEstimated || 0),
          outputTokens: acc.outputTokens + (p.outputTokens ?? 0),
          retries: acc.retries + (p.retries ?? 0),
          ...(acc.cachedEstimated || estimated ? { cachedEstimated: true } : {}),
        };
      },
      { calls: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0, retries: 0 },
    );
  return {
    run,
    steps,
    ...(checkpoint ? { checkpoint } : {}),
    artifacts,
    pendingApprovals,
    approvals,
    effects: { counts, recent: allEffects.slice(-5) },
    interactions: runtime.interactions.listForRun(run.id, { openOnly: true }),
    ...capabilitiesOf(runtime, latest),
    events: events.slice(-15),
    tokens,
    leaseLive: run.lease !== undefined && Date.parse(run.lease.until) >= now.getTime(),
    ...activityFields(runtime, events, now),
    ...crossFields(runtime, run, now),
  };
}

/** A subtask's master, or a master's subtasks (ADR-0025 §6). */
function crossFields(runtime: Runtime, run: Run, now: Date): Pick<RunDetail, "subtaskOf" | "subtasks"> {
  const of = masterOf(runtime, run);
  if (of)
    return {
      subtaskOf: {
        master: of.master,
        key: run.options?.parent?.key ?? "?",
        ...(of.subtask ? { service: of.subtask.service } : {}),
        of: splitOf(runtime, of.master)?.subtasks.length ?? 0,
      },
    };
  const subtasks = run.workflow === MASTER_WORKFLOW ? subtasksOf(runtime, run, now) : [];
  return subtasks.length > 0 ? { subtasks } : {};
}

function activityFields(
  runtime: Runtime,
  events: readonly StoredEvent[],
  now: Date,
): { activity?: Activity; activityOptions?: FormatOptions } {
  const activity = activityOf(events, now);
  if (!activity) return {};
  const modelId = activity.step?.modelId;
  const timeoutMs = modelId ? runtime.loaded.config.models[modelId]?.timeoutMs : undefined;
  const stepOutputTokens = runtime.loaded.config.budget.perStep.outputTokens;
  const stepInputTokens = runtime.loaded.config.budget.perStep.inputTokens;
  return {
    activity,
    activityOptions: {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(stepOutputTokens !== undefined ? { stepOutputTokens } : {}),
      ...(stepInputTokens !== undefined ? { stepInputTokens } : {}),
    },
  };
}

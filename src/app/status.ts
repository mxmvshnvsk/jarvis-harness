import type { Approval } from "../artifacts/store.ts";
import type { WindowUsage } from "../budget/usage.ts";
import type { QuotaPool } from "../core/config/schema.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import type { Checkpoint, StepRecord } from "../storage/checkpoints.ts";
import type { EffectRecord } from "../storage/effects.ts";
import type { StoredEvent } from "../telemetry/events.ts";
import type { Runtime } from "./runtime.ts";

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
}

/** Artifact types that pass through a human gate and therefore may be awaiting approval. */
export const GATED_ARTIFACT_TYPES = ["spec", "plan", "review"] as const;

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
        return {
          calls: acc.calls + 1,
          promptTokens: acc.promptTokens + (p.promptTokens ?? 0),
          cachedTokens: acc.cachedTokens + (p.cachedTokens ?? 0),
          outputTokens: acc.outputTokens + (p.outputTokens ?? 0),
          retries: acc.retries + (p.retries ?? 0),
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
    events: events.slice(-15),
    tokens,
    leaseLive: run.lease !== undefined && Date.parse(run.lease.until) >= now.getTime(),
  };
}

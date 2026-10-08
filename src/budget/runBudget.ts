import type { DatabaseSync } from "node:sqlite";
import type { BudgetConfig, ResolvedConfig } from "../core/config/schema.ts";
import type { ModelCaller } from "../models/gateway.ts";
import type { ModelRequest, ModelResponse } from "../models/types.ts";

/**
 * Per-run and per-step caps (ADR-0018 §4). Independent of provider pools: the provider may still
 * have quota, the plan for this run is what ran out — so the run asks a human, not the window.
 */
export interface StepUsage {
  readonly outputTokens: number;
  readonly inputTokens: number;
  readonly requests: number;
}

export class BudgetExceededError extends Error {
  readonly scope: "perRun" | "perStep";
  readonly dimension: "outputTokens" | "inputTokens" | "requests";
  readonly used: number;
  readonly cap: number;
  constructor(
    scope: BudgetExceededError["scope"],
    dimension: BudgetExceededError["dimension"],
    used: number,
    cap: number,
  ) {
    super(`budget.${scope}.${dimension} exceeded: ${used} of ${cap}`);
    this.name = "BudgetExceededError";
    this.scope = scope;
    this.dimension = dimension;
    this.used = used;
    this.cap = cap;
  }
}

/**
 * More budget granted by a person for a run that stopped on a cap or a limit (`budget.grant` events,
 * src/app/budgetStop.ts): added to the configured caps, never replacing them. `finish` — the step
 * ends with what it has: its agent goes straight to its result document.
 */
export interface Grants {
  readonly perRun: StepUsage;
  readonly perStep: StepUsage;
  readonly toolCalls: number;
  readonly modelCalls: number;
  readonly finish: boolean;
}

export const NO_GRANTS: Grants = {
  perRun: { outputTokens: 0, inputTokens: 0, requests: 0 },
  perStep: { outputTokens: 0, inputTokens: 0, requests: 0 },
  toolCalls: 0,
  modelCalls: 0,
  finish: false,
};

/** The grants of a run (perRun) and of one step's iteration (perStep, the agent's limits, finish). */
export function grantsFromEvents(db: DatabaseSync, runId: string, stepId: string, iteration: number): Grants {
  const rows = db
    .prepare(
      "SELECT step_id AS stepId, iteration, payload_json AS payload FROM events WHERE kind = 'budget.grant' AND run_id = ?",
    )
    .all(runId) as Array<{ stepId: string | null; iteration: number | null; payload: string }>;
  let grants = NO_GRANTS;
  for (const row of rows) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
    const here = row.stepId === stepId && row.iteration === iteration;
    const add = (u: StepUsage): StepUsage => ({
      outputTokens: u.outputTokens + n(p.outputTokens),
      inputTokens: u.inputTokens + n(p.inputTokens),
      requests: u.requests + n(p.requests),
    });
    if (p.scope === "perRun") grants = { ...grants, perRun: add(grants.perRun) };
    else if (here && p.scope === "perStep") grants = { ...grants, perStep: add(grants.perStep) };
    else if (here && p.scope === "agent")
      grants = {
        ...grants,
        toolCalls: grants.toolCalls + n(p.toolCalls),
        modelCalls: grants.modelCalls + n(p.modelCalls),
      };
    if (here && p.finish === true) grants = { ...grants, finish: true };
  }
  return grants;
}

/**
 * The usage of the calls made outside the pools' unlimited hours (`free(modelId, at)` — the call was in
 * them). Pilot: a run spent 80M input tokens at night under the tenfold cap; at 8:00 the cap fell back
 * and the run stopped at once on what the night had spent.
 */
export function limitedUsageFromEvents(
  db: DatabaseSync,
  free: (modelId: string, at: Date) => boolean,
  runId: string,
  stepId?: string,
  iteration?: number,
): StepUsage {
  const clauses = ["kind = 'model.call'", "run_id = ?"];
  const params: Array<string | number> = [runId];
  if (stepId !== undefined) {
    clauses.push("step_id = ?");
    params.push(stepId);
  }
  if (iteration !== undefined) {
    clauses.push("iteration = ?");
    params.push(iteration);
  }
  const rows = db
    .prepare(
      `SELECT ts, json_extract(payload_json, '$.modelId') AS modelId, COALESCE(json_extract(payload_json, '$.outputTokens'), 0) AS output,
              COALESCE(json_extract(payload_json, '$.promptTokens'), 0) AS input
       FROM events WHERE ${clauses.join(" AND ")}`,
    )
    .all(...params) as Array<{ ts: string; modelId: string | null; output: number; input: number }>;
  const usage = { outputTokens: 0, inputTokens: 0, requests: 0 };
  for (const r of rows) {
    if (r.modelId && free(r.modelId, new Date(r.ts))) continue;
    usage.outputTokens += r.output;
    usage.inputTokens += r.input;
    usage.requests += 1;
  }
  return usage;
}

export function usageFromEvents(
  db: DatabaseSync,
  runId: string,
  stepId?: string,
  iteration?: number,
): StepUsage {
  const clauses = ["kind = 'model.call'", "run_id = ?"];
  const params: Array<string | number> = [runId];
  if (stepId !== undefined) {
    clauses.push("step_id = ?");
    params.push(stepId);
  }
  if (iteration !== undefined) {
    clauses.push("iteration = ?");
    params.push(iteration);
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(json_extract(payload_json, '$.outputTokens')), 0) AS output,
              COALESCE(SUM(json_extract(payload_json, '$.promptTokens')), 0) AS input
       FROM events WHERE ${clauses.join(" AND ")}`,
    )
    .get(...params) as { requests: number; output: number; input: number };
  return { outputTokens: row.output, inputTokens: row.input, requests: row.requests };
}

export interface BudgetScope {
  readonly runId: string;
  readonly stepId: string;
  readonly iteration: number;
}

/** Wraps a gateway so every call is checked against the run's own caps before it is made. */
export class BudgetedGateway implements ModelCaller {
  private readonly inner: ModelCaller;
  private readonly db: DatabaseSync;
  private readonly budget: BudgetConfig;
  private readonly scope: BudgetScope;

  /** How many times the caps grow for a call of this model now (its pool's unlimited hours). */
  private readonly scale: (modelId: string) => number;
  /** A call of this model at that time was in its pool's unlimited hours: outside them it does not count. */
  private readonly free: ((modelId: string, at: Date) => boolean) | undefined;

  constructor(
    inner: ModelCaller,
    db: DatabaseSync,
    config: ResolvedConfig,
    scope: BudgetScope,
    scale: (modelId: string) => number = () => 1,
    free?: (modelId: string, at: Date) => boolean,
  ) {
    this.inner = inner;
    this.db = db;
    this.budget = config.budget;
    this.scope = scope;
    this.scale = scale;
    this.free = free;
  }

  /**
   * Caps are checked on consumed tokens: a call is refused once the cap is reached, so a step may
   * overshoot by at most one response. Counting the reserve would make small caps unusable.
   */
  check(scale = 1): void {
    // in unlimited hours: everything against the grown caps; after them: only what was spent outside
    const free = scale === 1 ? this.free : undefined;
    const run = free
      ? limitedUsageFromEvents(this.db, free, this.scope.runId)
      : usageFromEvents(this.db, this.scope.runId);
    const step = free
      ? limitedUsageFromEvents(this.db, free, this.scope.runId, this.scope.stepId, this.scope.iteration)
      : usageFromEvents(this.db, this.scope.runId, this.scope.stepId, this.scope.iteration);
    const grants = grantsFromEvents(this.db, this.scope.runId, this.scope.stepId, this.scope.iteration);
    const plus = (cap: number | undefined, extra: number) =>
      cap === undefined ? undefined : cap * scale + extra;
    const perRun = {
      outputTokens: plus(this.budget.perRun.outputTokens, grants.perRun.outputTokens),
      inputTokens: plus(this.budget.perRun.inputTokens, grants.perRun.inputTokens),
      requests: plus(this.budget.perRun.requests, grants.perRun.requests),
    };
    const perStep = {
      outputTokens: plus(this.budget.perStep.outputTokens, grants.perStep.outputTokens),
      inputTokens: plus(this.budget.perStep.inputTokens, grants.perStep.inputTokens),
      requests: plus(this.budget.perStep.requests, grants.perStep.requests),
    };
    if (perRun.outputTokens !== undefined && run.outputTokens >= perRun.outputTokens) {
      throw new BudgetExceededError("perRun", "outputTokens", run.outputTokens, perRun.outputTokens);
    }
    if (perRun.inputTokens !== undefined && run.inputTokens >= perRun.inputTokens) {
      throw new BudgetExceededError("perRun", "inputTokens", run.inputTokens, perRun.inputTokens);
    }
    if (perRun.requests !== undefined && run.requests + 1 > perRun.requests) {
      throw new BudgetExceededError("perRun", "requests", run.requests, perRun.requests);
    }
    if (perStep.outputTokens !== undefined && step.outputTokens >= perStep.outputTokens) {
      throw new BudgetExceededError("perStep", "outputTokens", step.outputTokens, perStep.outputTokens);
    }
    if (perStep.inputTokens !== undefined && step.inputTokens >= perStep.inputTokens) {
      throw new BudgetExceededError("perStep", "inputTokens", step.inputTokens, perStep.inputTokens);
    }
    if (perStep.requests !== undefined && step.requests + 1 > perStep.requests) {
      throw new BudgetExceededError("perStep", "requests", step.requests, perStep.requests);
    }
  }

  async call(request: ModelRequest): Promise<ModelResponse> {
    this.check(this.scale(request.modelId));
    return this.inner.call({
      ...request,
      runId: this.scope.runId,
      stepId: this.scope.stepId,
      iteration: this.scope.iteration,
    });
  }
}

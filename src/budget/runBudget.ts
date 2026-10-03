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
  readonly requests: number;
}

export class BudgetExceededError extends Error {
  readonly scope: "perRun" | "perStep";
  readonly dimension: "outputTokens" | "requests";
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
      `SELECT COUNT(*) AS requests, COALESCE(SUM(json_extract(payload_json, '$.outputTokens')), 0) AS output
       FROM events WHERE ${clauses.join(" AND ")}`,
    )
    .get(...params) as { requests: number; output: number };
  return { outputTokens: row.output, requests: row.requests };
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

  constructor(inner: ModelCaller, db: DatabaseSync, config: ResolvedConfig, scope: BudgetScope) {
    this.inner = inner;
    this.db = db;
    this.budget = config.budget;
    this.scope = scope;
  }

  /**
   * Caps are checked on consumed tokens: a call is refused once the cap is reached, so a step may
   * overshoot by at most one response. Counting the reserve would make small caps unusable.
   */
  check(): void {
    const run = usageFromEvents(this.db, this.scope.runId);
    const step = usageFromEvents(this.db, this.scope.runId, this.scope.stepId, this.scope.iteration);
    const perRun = this.budget.perRun;
    const perStep = this.budget.perStep;
    if (perRun.outputTokens !== undefined && run.outputTokens >= perRun.outputTokens) {
      throw new BudgetExceededError("perRun", "outputTokens", run.outputTokens, perRun.outputTokens);
    }
    if (perRun.requests !== undefined && run.requests + 1 > perRun.requests) {
      throw new BudgetExceededError("perRun", "requests", run.requests, perRun.requests);
    }
    if (perStep.outputTokens !== undefined && step.outputTokens >= perStep.outputTokens) {
      throw new BudgetExceededError("perStep", "outputTokens", step.outputTokens, perStep.outputTokens);
    }
    if (perStep.requests !== undefined && step.requests + 1 > perStep.requests) {
      throw new BudgetExceededError("perStep", "requests", step.requests, perStep.requests);
    }
  }

  async call(request: ModelRequest): Promise<ModelResponse> {
    this.check();
    return this.inner.call({
      ...request,
      runId: this.scope.runId,
      stepId: this.scope.stepId,
      iteration: this.scope.iteration,
    });
  }
}

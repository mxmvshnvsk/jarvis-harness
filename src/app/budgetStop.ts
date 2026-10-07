import type { Actor } from "../core/domain/actor.ts";
import type { Run } from "../core/domain/run.ts";
import { type DecisionChannel, parkedAt } from "./decide.ts";
import type { Runtime } from "./runtime.ts";

/**
 * A run stopped on a budget (ADR-0018 §4): a cap of the run or the step (`budget.perRun|perStep`), or
 * the agent's own limit of tool or model calls on a step with `onLimit: ask`. The person decides: more
 * and go on from where it stopped (the agent's conversation is kept), or finish the step with what it
 * has — its result marked incomplete for the steps after it. Recorded as `budget.grant` with the actor,
 * from the terminal card or the page alike. Pilot: such a stop parked the run with an empty card.
 */
export type BudgetScope = "perRun" | "perStep" | "agent";
export type BudgetDimension = "outputTokens" | "requests" | "toolCalls" | "modelCalls";

export interface BudgetStop {
  readonly scope: BudgetScope;
  readonly dimension: BudgetDimension;
  readonly used: number;
  readonly cap: number;
  readonly stepId: string;
  readonly iteration: number;
  readonly agent?: string;
  /** What "more" adds unless the person says otherwise: half the cap, rounded. */
  readonly suggested: number;
}

export interface BudgetGrant {
  readonly seq: number;
  readonly finish: boolean;
  readonly amount?: number;
  readonly actor?: string;
  readonly channel?: DecisionChannel;
}

const SCOPES: readonly string[] = ["perRun", "perStep", "agent"];
const DIMENSIONS: readonly string[] = ["outputTokens", "requests", "toolCalls", "modelCalls"];
/** "Finish" after a cap of the run or the step: enough for the result document and its repairs. */
export const FINISH_ALLOWANCE = { requests: 4, outputTokens: 32_000 } as const;

/** Units for people: "tool calls", "output tokens". */
export function unitOf(dimension: BudgetDimension): string {
  return {
    outputTokens: "output tokens",
    requests: "model requests",
    toolCalls: "tool calls",
    modelCalls: "model calls",
  }[dimension];
}

/** Where the cap comes from, for the card's subtitle. */
export function sourceOf(stop: Pick<BudgetStop, "scope" | "agent">): string {
  return stop.scope === "agent"
    ? `the ${stop.agent ?? "agent"} agent's limit (agents.${stop.agent ?? "<id>"}.limits)`
    : `budget.${stop.scope}`;
}

export function suggestedMore(dimension: BudgetDimension, cap: number): number {
  if (dimension === "outputTokens") return Math.max(5_000, Math.round(cap / 2 / 1_000) * 1_000);
  return Math.max(10, Math.round(cap / 2));
}

/** What the run waits for, when it waits for budget: from the checkpoint of its stop. */
export function budgetStopOf(runtime: Runtime, run: Run): BudgetStop | undefined {
  if (run.state !== "WAITING_HUMAN" || run.waitingFor?.kind !== "budget") return undefined;
  const parked = runtime.checkpoints
    .list(run.id)
    .filter((c) => c.kind === "suspend")
    .at(-1);
  const b = parked?.state.budget as Record<string, unknown> | undefined;
  if (!parked || !b || !SCOPES.includes(String(b.scope)) || !DIMENSIONS.includes(String(b.dimension)))
    return undefined;
  const used = Number(b.used);
  const cap = Number(b.cap);
  if (!Number.isFinite(used) || !Number.isFinite(cap)) return undefined;
  const dimension = b.dimension as BudgetDimension;
  return {
    scope: b.scope as BudgetScope,
    dimension,
    used,
    cap,
    stepId: parked.stepId ?? run.currentStep ?? "?",
    iteration: parked.iteration ?? run.currentIteration ?? 1,
    ...(typeof b.agent === "string" ? { agent: b.agent } : {}),
    suggested: suggestedMore(dimension, cap),
  };
}

/** More, or "finish": recorded for the step that stopped; the run goes on with `continue` / `resume`. */
export function grantBudget(
  runtime: Runtime,
  run: Run,
  stop: BudgetStop,
  actor: Actor,
  choice: { readonly more: number } | { readonly finish: true },
  channel: DecisionChannel,
): void {
  const amount =
    "more" in choice
      ? { [stop.dimension]: Math.max(1, Math.floor(choice.more)) }
      : stop.scope === "agent"
        ? {}
        : FINISH_ALLOWANCE;
  runtime.events.emit({
    kind: "budget.grant",
    runId: run.id,
    stepId: stop.stepId,
    iteration: stop.iteration,
    actor: `${actor.kind}:${actor.id}`,
    payload: {
      scope: stop.scope,
      dimension: stop.dimension,
      ...amount,
      ...("finish" in choice ? { finish: true } : {}),
      used: stop.used,
      cap: stop.cap,
      channel,
    },
  });
}

/** A grant made since the run last stopped for a person (in the terminal or on the page), if any. */
export function budgetGranted(runtime: Runtime, runId: string): BudgetGrant | undefined {
  const grant = runtime.events.list({ runId, kind: "budget.grant", limit: 100_000 }).at(-1);
  if (!grant || grant.seq < parkedAt(runtime, runId)) return undefined;
  const p = grant.payload ?? {};
  const dimension = String(p.dimension);
  const amount = Number(p[dimension]);
  const channel = p.channel;
  return {
    seq: grant.seq,
    finish: p.finish === true,
    ...(Number.isFinite(amount) && amount > 0 && p.finish !== true ? { amount } : {}),
    ...(grant.actor ? { actor: grant.actor.replace(/^(user|service|ci):/, "") } : {}),
    ...(channel === "cli" || channel === "ui" ? { channel } : {}),
  };
}

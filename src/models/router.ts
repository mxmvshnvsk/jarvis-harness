import type { BudgetManager } from "../budget/admission.ts";
import type { ModelConfig, ResolvedConfig } from "../core/config/schema.ts";
import { modelAllowed } from "../security/policy/egress.ts";
import { ModelError } from "./errors.ts";

/** ADR-0007 §2 — what an agent needs from a model. */
export interface AgentRequirements {
  readonly structuredOutput?: "schema" | "json" | "text";
  readonly tools?: boolean;
  readonly minContext?: number;
  readonly reasoning?: boolean;
}

export type StructuredMode = "schema" | "json" | "text";

export interface RouteResult {
  readonly modelId: string;
  readonly model: ModelConfig;
  readonly role: string;
  /** Best structured-output mode the model supports (ADR-0007 §4). */
  readonly structuredMode: StructuredMode;
  readonly pool: string;
}

export interface RouteRejection {
  readonly modelId: string;
  readonly reason: string;
}

export interface RouteOptions {
  /** Skip models whose pool is exhausted right now and try the next candidate (ADR-0007 §3). */
  readonly fallbackPools?: boolean;
  readonly budget?: BudgetManager;
  readonly reserveOutput?: number;
}

export function structuredModeOf(model: ModelConfig): StructuredMode {
  if (model.supports.jsonSchema) return "schema";
  if (model.supports.jsonMode) return "json";
  return "text";
}

const MODE_RANK: Record<StructuredMode, number> = { text: 0, json: 1, schema: 2 };

/** Why a model cannot serve the requirements, or undefined when it can. */
export function rejectModel(
  modelId: string,
  model: ModelConfig,
  requires: AgentRequirements,
  dataClass: ResolvedConfig["dataClass"],
): string | undefined {
  if (!modelAllowed(dataClass, model.egress))
    return `egress "${model.egress}" not allowed for dataClass "${dataClass}"`;
  if (requires.tools && !model.supports.tools) return "does not support tool calling";
  if (requires.reasoning && !model.supports.reasoning) return "does not support reasoning";
  if (requires.minContext !== undefined && model.contextWindow < requires.minContext) {
    return `context window ${model.contextWindow} < required ${requires.minContext}`;
  }
  if (
    requires.structuredOutput &&
    MODE_RANK[structuredModeOf(model)] < MODE_RANK[requires.structuredOutput]
  ) {
    return `structured output "${structuredModeOf(model)}" < required "${requires.structuredOutput}"`;
  }
  void modelId;
  return undefined;
}

/**
 * ADR-0007 §3: candidates of the role in preference order → filter by requirements and egress →
 * first fit (optionally skipping exhausted pools). Throws a policy error listing every rejection
 * so the failure is explainable at run creation, not at step time.
 */
export function resolveModel(
  config: ResolvedConfig,
  role: string,
  requires: AgentRequirements = {},
  options: RouteOptions = {},
): RouteResult {
  const roleConfig = config.roles[role];
  if (!roleConfig) throw new ModelError("policy", `role "${role}" has no models configured (roles.${role})`);
  const rejections: RouteRejection[] = [];
  for (const modelId of roleConfig.models) {
    const model = config.models[modelId];
    if (!model) {
      rejections.push({ modelId, reason: "unknown model" });
      continue;
    }
    const reason = rejectModel(modelId, model, requires, config.dataClass);
    if (reason) {
      rejections.push({ modelId, reason });
      continue;
    }
    const pool = model.quotaPool ?? `model:${modelId}`;
    if (options.fallbackPools && options.budget) {
      const decision = options.budget.admit({
        pool,
        estimatedOutputTokens: options.reserveOutput ?? roleConfig.maxOutput ?? model.maxOutput,
      });
      if (!decision.allowed) {
        rejections.push({ modelId, reason: `pool "${pool}" exhausted: ${decision.reason}` });
        continue;
      }
    }
    return { modelId, model, role, structuredMode: structuredModeOf(model), pool };
  }
  const detail = rejections.map((r) => `${r.modelId}: ${r.reason}`).join("; ");
  throw new ModelError("policy", `no model for role "${role}" satisfies the requirements — ${detail}`);
}

/** Validates every role a workflow needs before a run starts (ADR-0007 §3, ADR-0016 §2). */
export function validateRoles(
  config: ResolvedConfig,
  needs: ReadonlyArray<{ role: string; requires?: AgentRequirements }>,
): RouteRejection[] {
  const problems: RouteRejection[] = [];
  for (const need of needs) {
    try {
      resolveModel(config, need.role, need.requires ?? {});
    } catch (error) {
      problems.push({ modelId: need.role, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return problems;
}

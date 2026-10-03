import { BudgetManager } from "../budget/admission.ts";
import { MemoryUsageStore, type UsageStore } from "../budget/usage.ts";
import type { ModelConfig, ResolvedConfig } from "../core/config/schema.ts";
import { EnvSecretResolver, type SecretRef, type SecretResolver } from "../core/config/secrets.ts";
import { modelAllowed } from "../security/policy/egress.ts";
import { type EventSink, MemoryEventStore } from "../telemetry/events.ts";
import { type CassetteMode, type CassetteStore, cassetteKey, cassetteRequest } from "./cassette.ts";
import { ModelError } from "./errors.ts";
import { type AdapterRegistry, adapterFor, defaultAdapters } from "./providers/index.ts";
import { charsOfMessages, TokenEstimator } from "./tokens.ts";
import type { ModelRequest, ModelResponse, ProviderResult } from "./types.ts";

/** Bounded retry policy (ADR-0001 §19, ADR-0011 §1). */
export interface RetryPolicy {
  readonly maxTransientRetries: number;
  readonly maxRateLimitRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** A Retry-After longer than this means the window is gone: treat as quota exhaustion. */
  readonly maxRetryAfterMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxTransientRetries: 2,
  maxRateLimitRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 30_000,
};

export interface GatewayOptions {
  readonly config: ResolvedConfig;
  readonly adapters?: AdapterRegistry;
  readonly secrets?: SecretResolver;
  readonly usage?: UsageStore;
  readonly events?: EventSink;
  readonly budget?: BudgetManager;
  readonly estimator?: TokenEstimator;
  readonly cassette?: { readonly mode: CassetteMode; readonly store: CassetteStore };
  readonly retry?: Partial<RetryPolicy>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => Date;
}

class Semaphore {
  private active = 0;
  private limit: number;
  private readonly queue: Array<() => void> = [];
  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }
  setLimit(limit: number): void {
    this.limit = Math.max(1, limit);
  }
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
    return () => this.release();
  }
  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

/**
 * ModelGateway (ADR-0001 §10): the single door to LLMs. Resolves the model, enforces egress and
 * admission, injects credentials at the transport, retries within bounds, records usage and
 * telemetry, and can record/replay calls for tests and evals.
 */
export class ModelGateway {
  private readonly config: ResolvedConfig;
  private readonly adapters: AdapterRegistry;
  private readonly secrets: SecretResolver;
  private readonly usage: UsageStore;
  private readonly events: EventSink;
  readonly budget: BudgetManager;
  readonly estimator: TokenEstimator;
  private readonly cassette: GatewayOptions["cassette"];
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => Date;
  private readonly semaphores = new Map<string, Semaphore>();

  constructor(options: GatewayOptions) {
    this.config = options.config;
    this.adapters = options.adapters ?? defaultAdapters();
    this.secrets = options.secrets ?? new EnvSecretResolver();
    this.usage = options.usage ?? new MemoryUsageStore();
    this.events = options.events ?? new MemoryEventStore();
    this.clock = options.clock ?? (() => new Date());
    this.budget = options.budget ?? new BudgetManager(this.usage, options.config.quotaPools, this.clock);
    this.estimator = options.estimator ?? new TokenEstimator();
    this.cassette = options.cassette;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  model(modelId: string): ModelConfig {
    const model = this.config.models[modelId];
    if (!model) throw new ModelError("policy", `unknown model "${modelId}"`, { modelId });
    return model;
  }

  poolOf(modelId: string): string {
    return this.model(modelId).quotaPool ?? `model:${modelId}`;
  }

  async call(input: ModelRequest): Promise<ModelResponse> {
    const model = this.model(input.modelId);
    const modelId = input.modelId;
    // The effective request carries the output reserve (role cap, model cap) so the adapter,
    // the cassette key and the admission check all see the same limit (ADR-0013 §1).
    const request: ModelRequest = {
      ...input,
      maxOutput: Math.min(
        input.maxOutput ?? this.roleMaxOutput(input.role) ?? model.maxOutput,
        model.maxOutput,
      ),
    };
    if (!modelAllowed(this.config.dataClass, model.egress)) {
      this.emitError(request, new ModelError("policy", "egress denied"), 0);
      throw new ModelError(
        "policy",
        `model ${modelId}: egress "${model.egress}" is not allowed for dataClass "${this.config.dataClass}" (ADR-0016)`,
        { modelId },
      );
    }

    const estimatedPrompt = this.estimator.estimateMessages(
      modelId,
      model.tokenizer,
      request.messages,
      request.tools,
    );
    const reserveOutput = request.maxOutput ?? model.maxOutput;

    // Replay never touches the provider or the budget (ADR-0012 §4).
    const key = this.cassette ? cassetteKey(request) : undefined;
    if (this.cassette && key && this.cassette.mode === "replay") {
      const entry = this.cassette.store.get(key);
      if (!entry) {
        throw new ModelError(
          "replay_miss",
          `model ${modelId}: no cassette entry for key ${key.slice(0, 12)}…`,
          { modelId },
        );
      }
      const response = this.finish(request, entry.response, 0, 0, "replay");
      this.emitCall(request, response, estimatedPrompt);
      return response;
    }

    const pool = this.poolOf(modelId);
    const decision = this.budget.admit({
      pool,
      estimatedOutputTokens: reserveOutput,
      estimatedPromptTokens: estimatedPrompt,
    });
    if (!decision.allowed) {
      const error = new ModelError(
        "quota_exhausted",
        `model ${modelId}: budget admission denied for pool "${pool}": ${decision.reason}`,
        {
          modelId,
          retryAfterMs: Math.max(0, decision.resetAt.getTime() - this.clock().getTime()),
        },
      );
      this.emitError(request, error, 0);
      throw error;
    }

    const headers = await this.authHeaders(model, modelId);
    const adapter = adapterFor(this.adapters, model.provider, modelId);
    const semaphore = this.semaphore(modelId, decision.soft ? 1 : model.maxConcurrency);
    const release = await semaphore.acquire();
    const started = this.clock().getTime();
    let retries = 0;
    try {
      for (;;) {
        try {
          const result = await adapter.call(request, model, { headers });
          const latency = this.clock().getTime() - started;
          const source = this.cassette?.mode === "record" ? "record" : "live";
          const response = this.finish(request, result, latency, retries, source);
          this.account(request, pool, result);
          if (this.cassette && key && this.cassette.mode === "record") {
            this.cassette.store.put({
              key,
              modelId,
              request: cassetteRequest(request),
              response: result,
              recordedAt: this.clock().toISOString(),
              cassetteVersion: 1,
            });
          }
          this.emitCall(request, response, estimatedPrompt);
          return response;
        } catch (error) {
          const modelError =
            error instanceof ModelError
              ? error
              : new ModelError("transient", String(error), { cause: error, modelId });
          const delay = this.retryDelay(modelError, retries);
          if (delay === undefined) {
            this.emitError(request, modelError, retries);
            throw this.escalate(modelError);
          }
          retries += 1;
          this.events.emit({
            kind: "model.retry",
            ...(request.runId ? { runId: request.runId } : {}),
            ...(request.stepId ? { stepId: request.stepId } : {}),
            payload: {
              modelId,
              attempt: retries,
              kind: modelError.kind,
              status: modelError.status,
              delayMs: delay,
            },
          });
          await this.sleep(delay);
        }
      }
    } finally {
      release();
    }
  }

  private roleMaxOutput(role: string | undefined): number | undefined {
    return role ? this.config.roles[role]?.maxOutput : undefined;
  }

  private semaphore(modelId: string, limit: number): Semaphore {
    let s = this.semaphores.get(modelId);
    if (!s) {
      s = new Semaphore(limit);
      this.semaphores.set(modelId, s);
    } else {
      s.setLimit(limit);
    }
    return s;
  }

  private async authHeaders(model: ModelConfig, modelId: string): Promise<Record<string, string>> {
    const headers: Record<string, string> = { ...model.headers };
    const auth = model.auth;
    if (auth.type === "none") return headers;
    const token = await this.secrets.resolve(auth.token as SecretRef);
    if (!token) {
      throw new ModelError(
        "auth",
        `model ${modelId}: secret ${auth.token} is not available (run \`jarvis doctor\`)`,
        { modelId },
      );
    }
    if (auth.type === "bearer") headers.authorization = `Bearer ${token}`;
    else headers[auth.header.toLowerCase()] = token;
    return headers;
  }

  /** undefined → do not retry. */
  private retryDelay(error: ModelError, retries: number): number | undefined {
    if (error.kind === "transient" && retries < this.retry.maxTransientRetries) {
      return Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** retries);
    }
    if (error.kind === "rate_limited" && retries < this.retry.maxRateLimitRetries) {
      if (error.retryAfterMs !== undefined && error.retryAfterMs > this.retry.maxRetryAfterMs)
        return undefined;
      const backoff = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** retries);
      return Math.max(backoff, error.retryAfterMs ?? 0);
    }
    return undefined;
  }

  /** A rate limit that cannot be waited out in-process is a quota exhaustion for the run. */
  private escalate(error: ModelError): ModelError {
    if (error.kind === "rate_limited") {
      return new ModelError("quota_exhausted", error.message, {
        ...(error.status !== undefined ? { status: error.status } : {}),
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        ...(error.modelId !== undefined ? { modelId: error.modelId } : {}),
        cause: error,
      });
    }
    return error;
  }

  private finish(
    request: ModelRequest,
    result: ProviderResult,
    latencyMs: number,
    retries: number,
    source: ModelResponse["source"],
  ): ModelResponse {
    return {
      text: result.text,
      toolCalls: result.toolCalls,
      usage: result.usage,
      finishReason: result.finishReason,
      model: result.model || this.model(request.modelId).model,
      latencyMs,
      retries,
      source,
      ...(result.rateLimit ? { rateLimit: result.rateLimit } : {}),
    };
  }

  private account(request: ModelRequest, pool: string, result: ProviderResult): void {
    this.usage.record({
      pool,
      model: request.modelId,
      ...(request.runId ? { runId: request.runId } : {}),
      promptTokens: result.usage.promptTokens,
      cachedTokens: result.usage.cachedTokens,
      outputTokens: result.usage.outputTokens,
      ts: this.clock(),
    });
    this.budget.observe(pool, result.rateLimit);
    if (result.usage.promptTokens > 0) {
      const chars = charsOfMessages(request.messages, request.tools);
      this.estimator.calibrate(request.modelId, chars, result.usage.promptTokens, request.messages.length);
    }
  }

  private emitCall(request: ModelRequest, response: ModelResponse, estimatedPrompt: number): void {
    this.events.emit({
      kind: "model.call",
      ...(request.runId ? { runId: request.runId } : {}),
      ...(request.stepId ? { stepId: request.stepId } : {}),
      ...(request.iteration !== undefined ? { iteration: request.iteration } : {}),
      payload: {
        modelId: request.modelId,
        model: response.model,
        role: request.role,
        agentId: request.agentId,
        promptTokens: response.usage.promptTokens,
        cachedTokens: response.usage.cachedTokens,
        outputTokens: response.usage.outputTokens,
        estimatedPromptTokens: estimatedPrompt,
        cacheHitRatio:
          response.usage.promptTokens > 0 ? response.usage.cachedTokens / response.usage.promptTokens : 0,
        latencyMs: response.latencyMs,
        finishReason: response.finishReason,
        retries: response.retries,
        source: response.source,
        responseFormat: request.responseFormat?.kind ?? "text",
        toolCount: request.tools?.length ?? 0,
        rateLimit: response.rateLimit,
      },
    });
  }

  private emitError(request: ModelRequest, error: ModelError, retries: number): void {
    this.events.emit({
      kind: "model.error",
      ...(request.runId ? { runId: request.runId } : {}),
      ...(request.stepId ? { stepId: request.stepId } : {}),
      payload: {
        modelId: request.modelId,
        role: request.role,
        kind: error.kind,
        status: error.status,
        retries,
        retryAfterMs: error.retryAfterMs,
      },
    });
  }
}

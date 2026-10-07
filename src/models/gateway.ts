import { BudgetManager } from "../budget/admission.ts";
import { OutputReserve } from "../budget/outputReserve.ts";
import { MemoryUsageStore, type UsageStore } from "../budget/usage.ts";
import { prefixReuse } from "../context/serialize.ts";
import type { ModelConfig, ResolvedConfig } from "../core/config/schema.ts";
import { EnvSecretResolver, type SecretRef, type SecretResolver } from "../core/config/secrets.ts";
import { InterruptedError, interruption } from "../orchestration/interrupt.ts";
import { modelAllowed } from "../security/policy/egress.ts";
import { type EventSink, MemoryEventStore } from "../telemetry/events.ts";
import { errorFields, type Logger, NULL_LOGGER } from "../telemetry/log.ts";
import { type CassetteMode, type CassetteStore, cassetteKey, cassetteRequest } from "./cassette.ts";
import { ModelError } from "./errors.ts";
import { type AdapterRegistry, adapterFor, defaultAdapters } from "./providers/index.ts";
import { type AgentRequirements, rejectModel } from "./router.ts";
import { charsOfMessages, TokenEstimator } from "./tokens.ts";
import type { Message, ModelRequest, ModelResponse, ProviderResult, StreamProgress } from "./types.ts";

/** The one method executors need; the budgeted wrapper (ADR-0018 §4) implements it too. */
export interface ModelCaller {
  call(request: ModelRequest): Promise<ModelResponse>;
}

/** Bounded retry policy (ADR-0001 §19, ADR-0011 §1). */
export interface RetryPolicy {
  readonly maxTransientRetries: number;
  readonly maxRateLimitRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** A Retry-After longer than this means the window is gone: treat as quota exhaustion. */
  readonly maxRetryAfterMs: number;
}

/** How often a streamed answer reports its progress to the journal. */
const PROGRESS_EVERY_MS = 5_000;

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
  readonly log?: Logger;
  readonly budget?: BudgetManager;
  readonly estimator?: TokenEstimator;
  readonly cassette?: { readonly mode: CassetteMode; readonly store: CassetteStore };
  readonly retry?: Partial<RetryPolicy>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => Date;
  /** The output a call reserves in its pool (src/budget/outputReserve.ts); default: from this process's calls. */
  readonly reserve?: OutputReserve;
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
export class ModelGateway implements ModelCaller {
  private readonly config: ResolvedConfig;
  private readonly adapters: AdapterRegistry;
  private readonly secrets: SecretResolver;
  private readonly usage: UsageStore;
  private readonly events: EventSink;
  private readonly log: Logger;
  readonly budget: BudgetManager;
  readonly estimator: TokenEstimator;
  private readonly cassette: GatewayOptions["cassette"];
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => Date;
  private readonly reserve: OutputReserve;
  private readonly semaphores = new Map<string, Semaphore>();
  /** The last prompt of each step (run, step, iteration, model): what the next call can reuse. */
  private readonly lastPrompts = new Map<string, readonly Message[]>();
  /** Steps whose calls go to another model of the role while the first one's pool is full. */
  private readonly failedOver = new Map<string, string>();

  constructor(options: GatewayOptions) {
    this.config = options.config;
    this.adapters = options.adapters ?? defaultAdapters();
    this.secrets = options.secrets ?? new EnvSecretResolver();
    this.usage = options.usage ?? new MemoryUsageStore();
    this.events = options.events ?? new MemoryEventStore();
    this.log = options.log ?? NULL_LOGGER;
    this.clock = options.clock ?? (() => new Date());
    this.budget = options.budget ?? new BudgetManager(this.usage, options.config.quotaPools, this.clock);
    this.estimator = options.estimator ?? new TokenEstimator();
    this.cassette = options.cassette;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.reserve = options.reserve ?? new OutputReserve();
  }

  model(modelId: string): ModelConfig {
    const model = this.config.models[modelId];
    if (!model) throw new ModelError("policy", `unknown model "${modelId}"`, { modelId });
    return model;
  }

  poolOf(modelId: string): string {
    return this.model(modelId).quotaPool ?? `model:${modelId}`;
  }

  async call(input: ModelRequest, failover = false): Promise<ModelResponse> {
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

    const reuse = this.observePrefix(request);
    const estimatedPrompt = this.estimator.estimateMessages(
      modelId,
      model.tokenizer,
      request.messages,
      request.tools,
    );
    // the typical answer of this kind of call, not the whole maxOutput (pilot: a pool of 30k let
    // nothing through after 14k with a 16k reserve per call); the request itself keeps maxOutput
    const reserveKind = {
      agentId: request.agentId,
      role: request.role,
      tools: (request.tools?.length ?? 0) > 0,
    };
    const reserveOutput = this.reserve.reserve(reserveKind, request.maxOutput ?? model.maxOutput);

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
      this.emitCall(request, response, estimatedPrompt, reuse);
      return response;
    }

    const pool = this.poolOf(modelId);
    const decision = this.budget.admit({
      pool,
      estimatedOutputTokens: reserveOutput,
      estimatedPromptTokens: estimatedPrompt,
    });
    if (!decision.allowed) {
      // another model of the role with room in its own pool takes the call (a second cluster)
      const alternate = this.alternateFor(request, modelId, pool);
      const step = `${request.runId ?? "-"}:${request.stepId ?? "-"}:${request.role ?? "-"}`;
      if (alternate && this.failedOver.get(step) === alternate)
        return this.call({ ...input, modelId: alternate }, true);
      if (alternate) {
        // once per stretch: every call of the step goes the same way until the first pool has room
        this.failedOver.set(step, alternate);
        this.events.emit({
          kind: "model.failover",
          ...(request.runId ? { runId: request.runId } : {}),
          ...(request.stepId ? { stepId: request.stepId } : {}),
          payload: { from: modelId, to: alternate, role: request.role, pool, reason: decision.reason },
        });
        return this.call({ ...input, modelId: alternate }, true);
      }
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

    // the preferred model has room again: the next failover is news
    if (!failover)
      this.failedOver.delete(`${request.runId ?? "-"}:${request.stepId ?? "-"}:${request.role ?? "-"}`);
    if (this.log.enabled("debug")) {
      const delta = this.log.promptDelta(
        `${request.runId ?? "-"}:${request.stepId ?? "-"}:${request.iteration ?? 0}:${modelId}`,
        request.messages,
      );
      this.log.debug("model.request", {
        ...(request.runId ? { runId: request.runId } : {}),
        ...(request.stepId ? { stepId: request.stepId } : {}),
        ...(request.iteration !== undefined ? { iteration: request.iteration } : {}),
        modelId,
        model: model.model,
        role: request.role,
        agentId: request.agentId,
        estimatedPromptTokens: estimatedPrompt,
        maxOutput: request.maxOutput,
        reserveOutput,
        tools: request.tools?.map((t) => t.name),
        messageCount: delta.total,
        // only what was not logged before for this step; `from` is where the delta starts
        messagesFrom: delta.from,
        ...(delta.rewritten > 0 ? { rewrittenEarlier: delta.rewritten } : {}),
        messages: delta.messages,
      });
    }

    const headers = await this.authHeaders(model, modelId);
    const adapter = adapterFor(this.adapters, model.provider, modelId);
    const semaphore = this.semaphore(modelId, decision.soft ? 1 : model.maxConcurrency);
    const release = await semaphore.acquire();
    const started = this.clock().getTime();
    let attemptStarted = started;
    let retries = 0;
    try {
      for (;;) {
        attemptStarted = this.clock().getTime();
        let reported = 0;
        const attempt = retries;
        const onProgress = (p: StreamProgress): void => {
          const now = this.clock().getTime();
          if (reported > 0 && now - reported < PROGRESS_EVERY_MS) return;
          reported = now;
          this.events.emit({
            kind: "model.progress",
            ...(request.runId ? { runId: request.runId } : {}),
            ...(request.stepId ? { stepId: request.stepId } : {}),
            ...(request.iteration !== undefined ? { iteration: request.iteration } : {}),
            payload: {
              modelId,
              attempt,
              elapsedMs: now - attemptStarted,
              outputChars: p.outputChars,
              reasoningChars: p.reasoningChars,
              toolCalls: p.toolCalls,
              ...(p.firstTokenMs !== undefined ? { firstTokenMs: p.firstTokenMs } : {}),
            },
          });
        };
        try {
          interruption.throwIfRequested();
          const result = await adapter.call(request, model, {
            headers,
            onProgress,
            signal: interruption.signal,
          });
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
          this.emitCall(request, response, estimatedPrompt, reuse);
          this.log.debug("model.response", {
            ...(request.runId ? { runId: request.runId } : {}),
            ...(request.stepId ? { stepId: request.stepId } : {}),
            ...(request.iteration !== undefined ? { iteration: request.iteration } : {}),
            modelId,
            finishReason: response.finishReason,
            latencyMs: response.latencyMs,
            usage: response.usage,
            text: response.text,
            toolCalls: response.toolCalls,
          });
          return response;
        } catch (error) {
          // Ctrl-C: not a failure of the model, and nothing to retry
          if (interruption.requested) throw new InterruptedError();
          const modelError =
            error instanceof ModelError
              ? error
              : new ModelError("transient", String(error), { cause: error, modelId });
          const delay = this.retryDelay(modelError, retries, request);
          const attemptMs = this.clock().getTime() - attemptStarted;
          if (delay === undefined) {
            this.emitError(request, modelError, retries, attemptMs);
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
              // how many retries this kind of failure gets, and how long the failed attempt took:
              // a gateway that cuts every request at 5:00 shows up as the same attemptMs (pilot)
              maxRetries:
                modelError.kind === "rate_limited"
                  ? this.retry.maxRateLimitRetries
                  : this.retry.maxTransientRetries,
              attemptMs,
              kind: modelError.kind,
              status: modelError.status,
              delayMs: delay,
              message: modelError.message.slice(0, 600),
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
  private retryDelay(error: ModelError, retries: number, request?: ModelRequest): number | undefined {
    if (request?.noRetry) return undefined;
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
      ...(result.streamed ? { streamed: true } : {}),
      ...(result.firstTokenMs !== undefined ? { firstTokenMs: result.firstTokenMs } : {}),
    };
  }

  private account(request: ModelRequest, pool: string, result: ProviderResult): void {
    this.reserve.observe(
      { agentId: request.agentId, role: request.role, tools: (request.tools?.length ?? 0) > 0 },
      result.usage.outputTokens,
    );
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

  /**
   * ADR-0013 §4: within a step the prompt only grows at the end, so a prefix cache can reuse all of
   * it but the newest messages. `prefixReuse` (the share of this prompt identical to the previous
   * call's from the start) shows how cache-friendly the prompts are even where the gateway reports no
   * cache; a change in the stable layers (the first two messages) is a `context.prefixChanged`.
   */
  private observePrefix(request: ModelRequest): number | undefined {
    if (!request.runId || !request.stepId) return undefined;
    const key = `${request.runId}:${request.stepId}:${request.iteration ?? 0}:${request.modelId}`;
    const previous = this.lastPrompts.get(key);
    this.lastPrompts.delete(key);
    this.lastPrompts.set(key, request.messages);
    if (this.lastPrompts.size > 32) this.lastPrompts.delete(this.lastPrompts.keys().next().value as string);
    if (!previous) return undefined;
    const r = prefixReuse(previous, request.messages);
    if (r.changedMessage !== undefined && r.changedMessage < 2) {
      this.events.emit({
        kind: "context.prefixChanged",
        runId: request.runId,
        stepId: request.stepId,
        ...(request.iteration !== undefined ? { iteration: request.iteration } : {}),
        payload: {
          modelId: request.modelId,
          agentId: request.agentId,
          message: r.changedMessage,
          role: request.messages[r.changedMessage]?.role,
          reusedChars: r.reusedChars,
        },
      });
    }
    return r.totalChars > 0 ? Number((r.reusedChars / r.totalChars).toFixed(3)) : undefined;
  }

  private emitCall(
    request: ModelRequest,
    response: ModelResponse,
    estimatedPrompt: number,
    reuse?: number,
  ): void {
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
        ...(response.streamed ? { streamed: true } : {}),
        ...(response.firstTokenMs !== undefined ? { firstTokenMs: response.firstTokenMs } : {}),
        ...(reuse !== undefined ? { prefixReuse: reuse } : {}),
      },
    });
  }

  /**
   * The next model of the call's role, after this one, that can take it now: allowed for the data
   * class, with what the call needs (tools, structured output, room for the prompt), in a pool of its
   * own that admits it. `roles.<role>.models` is the order: the first is preferred, the next ones
   * take over while its pool is full (ADR-0007 §3).
   */
  private alternateFor(request: ModelRequest, modelId: string, pool: string): string | undefined {
    const candidates = request.role ? (this.config.roles[request.role]?.models ?? []) : [];
    const from = candidates.indexOf(modelId);
    if (from < 0) return undefined;
    const requires: AgentRequirements = {
      ...((request.tools?.length ?? 0) > 0 ? { tools: true } : {}),
      ...(request.responseFormat && request.responseFormat.kind !== "text"
        ? { structuredOutput: request.responseFormat.kind }
        : {}),
    };
    for (const id of candidates.slice(from + 1)) {
      const model = this.config.models[id];
      if (!model || this.poolOf(id) === pool) continue;
      if (rejectModel(id, model, requires, this.config.dataClass)) continue;
      const prompt = this.estimator.estimateMessages(id, model.tokenizer, request.messages, request.tools);
      if (prompt + Math.min(request.maxOutput ?? model.maxOutput, model.maxOutput) > model.contextWindow)
        continue;
      const decision = this.budget.admit({
        pool: this.poolOf(id),
        estimatedOutputTokens: this.reserve.reserve(
          { agentId: request.agentId, role: request.role, tools: requires.tools === true },
          model.maxOutput,
        ),
        estimatedPromptTokens: prompt,
      });
      if (decision.allowed) return id;
    }
    return undefined;
  }

  private emitError(request: ModelRequest, error: ModelError, retries: number, attemptMs?: number): void {
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
        ...(attemptMs !== undefined ? { attemptMs } : {}),
        retryAfterMs: error.retryAfterMs,
        // includes the start of the provider's response body (classifyHttpError)
        message: error.message.slice(0, 600),
      },
    });
    // the stack and the cause belong in the log, not in the journal
    this.log.error("model.error.detail", {
      ...(request.runId ? { runId: request.runId } : {}),
      ...(request.stepId ? { stepId: request.stepId } : {}),
      modelId: request.modelId,
      ...errorFields(error),
    });
  }
}

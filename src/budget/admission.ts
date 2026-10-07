import type { QuotaPool } from "../core/config/schema.ts";
import type { RateLimitInfo } from "../models/types.ts";
import { lastUnlimitedEnd, nextUnlimited, type Schedule, unlimitedAt, unlimitedUntil } from "./schedule.ts";
import type { UsageStore, WindowUsage } from "./usage.ts";

/**
 * Budget Manager admission check (ADR-0001 §11, ADR-0018 §4–5): "CAN we call the model now?"
 * Hard limits deny (the run checkpoints and waits); the soft threshold lowers concurrency and
 * gives compaction priority. Provider rate-limit headers, when seen, cap the local estimate.
 */
export interface AdmissionRequest {
  readonly pool: string;
  readonly estimatedOutputTokens: number;
  readonly estimatedPromptTokens?: number;
}

export interface AdmissionAllowed {
  readonly allowed: true;
  readonly pool: string;
  /** Highest utilisation ratio across limited dimensions, 0..1+. */
  readonly pressure: number;
  readonly soft: boolean;
  readonly concurrency: number;
  readonly usage: WindowUsage;
  readonly remaining: { outputTokens?: number; inputTokens?: number; requests?: number };
}

export interface AdmissionDenied {
  readonly allowed: false;
  readonly pool: string;
  readonly reason: string;
  readonly usage: WindowUsage;
  /** When enough budget is expected to be back. */
  readonly resetAt: Date;
}

export type AdmissionDecision = AdmissionAllowed | AdmissionDenied;

interface ProviderObservation {
  readonly info: RateLimitInfo;
  readonly at: Date;
}

export class BudgetManager {
  private readonly usage: UsageStore;
  private readonly pools: Readonly<Record<string, QuotaPool>>;
  private readonly observed = new Map<string, ProviderObservation>();
  private readonly clock: () => Date;

  constructor(
    usage: UsageStore,
    pools: Readonly<Record<string, QuotaPool>>,
    clock: () => Date = () => new Date(),
  ) {
    this.usage = usage;
    this.pools = pools;
    this.clock = clock;
  }

  pool(name: string): QuotaPool | undefined {
    return this.pools[name];
  }

  /** Remember provider headers so the local estimate never exceeds what the provider reports. */
  observe(pool: string, info: RateLimitInfo | undefined): void {
    if (!info) return;
    this.observed.set(pool, { info, at: this.clock() });
  }

  windowUsage(pool: string): WindowUsage | undefined {
    const definition = this.pools[pool];
    if (!definition) return undefined;
    const now = this.clock();
    return this.usage.windowUsage(pool, definition, now, this.since(definition, now));
  }

  /** The pool's unlimited hours now: until when; or when they begin next. */
  unlimited(pool: string): { now: true; until?: Date } | { now: false; next?: Date } | undefined {
    const definition = this.pools[pool];
    if (!definition || definition.unlimited.length === 0) return undefined;
    const now = this.clock();
    const schedule = scheduleOf(definition);
    if (unlimitedAt(schedule, now)) {
      const until = unlimitedUntil(schedule, now);
      return { now: true, ...(until ? { until } : {}) };
    }
    const next = nextUnlimited(schedule, now);
    return { now: false, ...(next ? { next } : {}) };
  }

  /** How many times the agents' limits and the run's budget grow now: `unlimitedScale` in unlimited hours, else 1. */
  scaleNow(pool: string): number {
    const definition = this.pools[pool];
    if (!definition || definition.unlimited.length === 0) return 1;
    return unlimitedAt(scheduleOf(definition), this.clock()) ? definition.unlimitedScale : 1;
  }

  /** What the pool spent in its unlimited hours does not count: the window starts after them. */
  private since(definition: QuotaPool, now: Date): Date | undefined {
    if (definition.unlimited.length === 0) return undefined;
    return lastUnlimitedEnd(scheduleOf(definition), now, definition.window.minutes * 60_000);
  }

  admit(request: AdmissionRequest): AdmissionDecision {
    const definition = this.pools[request.pool];
    const now = this.clock();
    if (!definition) {
      // An unknown pool cannot be limited; treat as unlimited but say so via pressure 0.
      const usage = {
        pool: request.pool,
        windowStart: now,
        windowEnd: now,
        requests: 0,
        promptTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
      };
      return {
        allowed: true,
        pool: request.pool,
        pressure: 0,
        soft: false,
        concurrency: 1,
        usage,
        remaining: {},
      };
    }
    const schedule = scheduleOf(definition);
    if (unlimitedAt(schedule, now)) {
      // the platform's unlimited hours: no check (concurrency still holds)
      const usage = this.usage.windowUsage(request.pool, definition, now);
      return {
        allowed: true,
        pool: request.pool,
        pressure: 0,
        soft: false,
        concurrency: definition.limits.concurrency ?? 1,
        usage,
        remaining: {},
      };
    }
    const usage = this.usage.windowUsage(request.pool, definition, now, this.since(definition, now));
    const limits = definition.limits;
    // a pool that waits goes on when its window frees or its unlimited hours begin, whichever is first
    const frees = this.resetAt(definition, usage, now);
    const opens = nextUnlimited(schedule, now);
    const resetAt = opens && opens < frees ? opens : frees;
    const remaining: { outputTokens?: number; inputTokens?: number; requests?: number } = {};
    const ratios: number[] = [];

    if (limits.outputTokens !== undefined) {
      let left = limits.outputTokens - usage.outputTokens;
      left = this.capByProvider(request.pool, "remainingTokens", left, now);
      remaining.outputTokens = Math.max(0, left);
      ratios.push(usage.outputTokens / limits.outputTokens);
      if (request.estimatedOutputTokens > left) {
        return this.deny(
          request.pool,
          `output tokens: ${usage.outputTokens} used of ${limits.outputTokens} in window, need ${request.estimatedOutputTokens}`,
          usage,
          resetAt,
        );
      }
    }
    if (limits.inputTokens !== undefined) {
      const left = limits.inputTokens - usage.promptTokens;
      remaining.inputTokens = Math.max(0, left);
      ratios.push(usage.promptTokens / limits.inputTokens);
      if ((request.estimatedPromptTokens ?? 0) > left) {
        return this.deny(
          request.pool,
          `input tokens: ${usage.promptTokens} used of ${limits.inputTokens} in window`,
          usage,
          resetAt,
        );
      }
    }
    if (limits.requests !== undefined) {
      let left = limits.requests - usage.requests;
      left = this.capByProvider(request.pool, "remainingRequests", left, now);
      remaining.requests = Math.max(0, left);
      ratios.push(usage.requests / limits.requests);
      if (left < 1) {
        return this.deny(
          request.pool,
          `requests: ${usage.requests} of ${limits.requests} in window`,
          usage,
          resetAt,
        );
      }
    }

    const pressure = ratios.length > 0 ? Math.max(...ratios) : 0;
    const soft = pressure >= definition.soft;
    const concurrency = soft ? 1 : (limits.concurrency ?? 1);
    return { allowed: true, pool: request.pool, pressure, soft, concurrency, usage, remaining };
  }

  private capByProvider(
    pool: string,
    key: "remainingTokens" | "remainingRequests",
    local: number,
    now: Date,
  ): number {
    const seen = this.observed.get(pool);
    if (!seen) return local;
    const value = seen.info[key];
    if (value === undefined) return local;
    const resetKey = key === "remainingTokens" ? "resetTokensMs" : "resetRequestsMs";
    const resetMs = seen.info[resetKey];
    // The observation is stale once the provider's own reset has passed.
    if (resetMs !== undefined && now.getTime() - seen.at.getTime() > resetMs) return local;
    return Math.min(local, value);
  }

  private resetAt(definition: QuotaPool, usage: WindowUsage, now: Date): Date {
    if (definition.window.kind === "fixed") return usage.windowEnd;
    const ms = definition.window.minutes * 60_000;
    const oldest = usage.oldestTs ?? now;
    return new Date(oldest.getTime() + ms + 1000);
  }

  private deny(pool: string, reason: string, usage: WindowUsage, resetAt: Date): AdmissionDenied {
    const definition = this.pools[pool];
    const opens = definition ? nextUnlimited(scheduleOf(definition), this.clock()) : undefined;
    const note = opens && opens.getTime() === resetAt.getTime() ? "; unlimited hours begin then" : "";
    return { allowed: false, pool, reason: `${reason}${note}`, usage, resetAt };
  }
}

const scheduleOf = (definition: QuotaPool): Schedule => ({
  spans: definition.unlimited,
  ...(definition.timezone ? { timezone: definition.timezone } : {}),
});

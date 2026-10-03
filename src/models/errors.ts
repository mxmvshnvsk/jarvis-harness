/**
 * Error classification for model calls (ADR-0011 §1, ADR-0001 §19).
 *
 * - quota_exhausted — the pool/provider is out of budget for the window: no retry, the run
 *   checkpoints and goes WAITING_BUDGET.
 * - rate_limited — short-term throttling: bounded retry honouring Retry-After.
 * - transient — network/timeout/5xx: bounded retry with backoff.
 * - auth — 401/403: no retry, configuration problem.
 * - invalid — other 4xx or malformed response: no retry.
 * - replay_miss — cassette has no recording for this request (ADR-0012 §4).
 * - policy — denied before the call (egress, admission, unsupported capability).
 */
export type ModelErrorKind =
  | "quota_exhausted"
  | "rate_limited"
  | "transient"
  | "auth"
  | "invalid"
  | "replay_miss"
  | "policy";

export interface ModelErrorOptions {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
  readonly modelId?: string;
}

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly modelId?: string;

  constructor(kind: ModelErrorKind, message: string, options: ModelErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelError";
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.modelId !== undefined) this.modelId = options.modelId;
  }

  get retryable(): boolean {
    return this.kind === "transient" || this.kind === "rate_limited";
  }
}

const QUOTA_PATTERNS = [/insufficient_quota/i, /quota/i, /budget/i, /exceeded your current/i, /credit/i];
const RATE_PATTERNS = [/rate[_ ]?limit/i, /too many requests/i, /tokens per min/i, /requests per min/i];

export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Maps an HTTP failure to a ModelError. `body` is the raw response text when available. */
export function classifyHttpError(
  status: number,
  body: string,
  headers: { get(name: string): string | null },
  modelId: string,
): ModelError {
  const retryAfterMs = parseRetryAfter(headers.get("retry-after"));
  const snippet = body.slice(0, 500);
  const base = { status, modelId, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  if (status === 401 || status === 403) {
    return new ModelError("auth", `model ${modelId}: authentication failed (${status}): ${snippet}`, base);
  }
  if (status === 429) {
    if (QUOTA_PATTERNS.some((p) => p.test(body)) && !RATE_PATTERNS.some((p) => p.test(body))) {
      return new ModelError("quota_exhausted", `model ${modelId}: quota exhausted (429): ${snippet}`, base);
    }
    return new ModelError("rate_limited", `model ${modelId}: rate limited (429): ${snippet}`, base);
  }
  if (status === 402) {
    return new ModelError(
      "quota_exhausted",
      `model ${modelId}: payment/quota required (402): ${snippet}`,
      base,
    );
  }
  if (status >= 500 || status === 408) {
    return new ModelError("transient", `model ${modelId}: provider error (${status}): ${snippet}`, base);
  }
  return new ModelError("invalid", `model ${modelId}: request rejected (${status}): ${snippet}`, base);
}

export function classifyNetworkError(error: unknown, modelId: string): ModelError {
  if (error instanceof ModelError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError" || /timed? ?out/i.test(message)) {
    return new ModelError("transient", `model ${modelId}: timeout: ${message}`, { cause: error, modelId });
  }
  return new ModelError("transient", `model ${modelId}: network error: ${message}`, {
    cause: error,
    modelId,
  });
}

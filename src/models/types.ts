import type { ModelConfig } from "../core/config/schema.ts";

/** Messages in the provider-neutral shape the gateway accepts (ADR-0001 §10). */
export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON string as returned by the model; parsed and validated by the caller. */
  readonly arguments: string;
}

export interface Message {
  readonly role: MessageRole;
  readonly content: string;
  /** For `tool` messages: the id of the call this answers. */
  readonly toolCallId?: string;
  /** For `assistant` messages that carried tool calls. */
  readonly toolCalls?: readonly ToolCall[];
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the arguments. */
  readonly parameters: Record<string, unknown>;
}

/** ADR-0007 §4 — how structured output is requested from the provider. */
export type ResponseFormat =
  | { readonly kind: "text" }
  | { readonly kind: "json" }
  | { readonly kind: "schema"; readonly name: string; readonly schema: Record<string, unknown> };

export interface ModelRequest {
  readonly modelId: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolDefinition[];
  readonly responseFormat?: ResponseFormat;
  readonly maxOutput?: number;
  readonly temperature?: number;
  /** Role the call is made for; recorded in telemetry and used for output reserve. */
  readonly role?: string;
  readonly runId?: string;
  readonly stepId?: string;
  readonly iteration?: number;
  readonly agentId?: string;
  /** One attempt only: a health check should say "down" now, not after the retries. */
  readonly noRetry?: boolean;
}

export interface Usage {
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "other";

export interface ModelResponse {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: Usage;
  readonly finishReason: FinishReason;
  readonly model: string;
  readonly latencyMs: number;
  readonly retries: number;
  /** `live`, `replay` or `record` (ADR-0012 §4). */
  readonly source: "live" | "replay" | "record";
  /** Provider rate-limit headers when present (ADR-0018 §5). */
  readonly rateLimit?: RateLimitInfo;
  /** The answer came as a stream; `firstTokenMs` is when its first piece arrived. */
  readonly streamed?: boolean;
  readonly firstTokenMs?: number;
}

export interface RateLimitInfo {
  readonly remainingRequests?: number;
  readonly remainingTokens?: number;
  readonly resetRequestsMs?: number;
  readonly resetTokensMs?: number;
}

/** What a provider adapter returns before the gateway adds accounting. */
export interface ProviderResult {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: Usage;
  readonly finishReason: FinishReason;
  readonly model: string;
  readonly rateLimit?: RateLimitInfo;
  readonly streamed?: boolean;
  readonly firstTokenMs?: number;
}

/** How far a streamed answer has come: characters of the answer and of the model's reasoning. */
export interface StreamProgress {
  readonly outputChars: number;
  readonly reasoningChars: number;
  readonly toolCalls: number;
  readonly firstTokenMs?: number;
}

export interface ProviderCallOptions {
  readonly signal?: AbortSignal;
  readonly headers: Readonly<Record<string, string>>;
  /** Called as pieces of a streamed answer arrive. */
  readonly onProgress?: (progress: StreamProgress) => void;
}

export interface ProviderAdapter {
  readonly name: string;
  call(request: ModelRequest, model: ModelConfig, options: ProviderCallOptions): Promise<ProviderResult>;
}

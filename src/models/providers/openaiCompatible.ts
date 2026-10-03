import type { ModelConfig } from "../../core/config/schema.ts";
import { classifyHttpError, classifyNetworkError, ModelError } from "../errors.ts";
import type {
  FinishReason,
  Message,
  ModelRequest,
  ProviderAdapter,
  ProviderCallOptions,
  ProviderResult,
  RateLimitInfo,
  ToolCall,
} from "../types.ts";

/**
 * OpenAI-compatible `chat/completions` adapter (ADR-0017 §2): corporate gateways, vLLM, Ollama,
 * DeepSeek, Qwen and OpenAI itself. Deliberately a thin fetch client — no SDK, no streaming —
 * so the closed contour has nothing extra to mirror.
 */

interface ChatMessage {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

interface ChatResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    prompt_cache_hit_tokens?: number;
  };
}

function toChatMessage(message: Message): ChatMessage {
  const out: ChatMessage = { role: message.role, content: message.content };
  if (message.toolCallId) out.tool_call_id = message.toolCallId;
  if (message.toolCalls && message.toolCalls.length > 0) {
    out.tool_calls = message.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }));
    if (message.content === "") out.content = null;
  }
  return out;
}

function toFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "other";
  }
}

/** Parses durations like `1s`, `6m0s`, `250ms` from x-ratelimit-reset-* headers. */
export function parseResetDuration(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  let total = 0;
  let matched = false;
  for (const m of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    matched = true;
    const n = Number(m[1]);
    const unit = m[2];
    total += unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
  }
  return matched ? total : undefined;
}

function rateLimitFromHeaders(headers: Headers): RateLimitInfo | undefined {
  const info: Record<string, number> = {};
  const rr = headers.get("x-ratelimit-remaining-requests");
  const rt = headers.get("x-ratelimit-remaining-tokens");
  const resetR = parseResetDuration(headers.get("x-ratelimit-reset-requests"));
  const resetT = parseResetDuration(headers.get("x-ratelimit-reset-tokens"));
  if (rr !== null && Number.isFinite(Number(rr))) info.remainingRequests = Number(rr);
  if (rt !== null && Number.isFinite(Number(rt))) info.remainingTokens = Number(rt);
  if (resetR !== undefined) info.resetRequestsMs = resetR;
  if (resetT !== undefined) info.resetTokensMs = resetT;
  return Object.keys(info).length > 0 ? (info as RateLimitInfo) : undefined;
}

export function buildChatBody(request: ModelRequest, model: ModelConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model.model,
    messages: request.messages.map(toChatMessage),
    stream: false,
  };
  const maxOutput = request.maxOutput ?? model.maxOutput;
  body.max_tokens = Math.min(maxOutput, model.maxOutput);
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  const format = request.responseFormat;
  if (format?.kind === "json") body.response_format = { type: "json_object" };
  if (format?.kind === "schema") {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: format.name, schema: format.schema, strict: true },
    };
  }
  return body;
}

export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly name = "openai-compatible";
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async call(
    request: ModelRequest,
    model: ModelConfig,
    options: ProviderCallOptions,
  ): Promise<ProviderResult> {
    const baseUrl = model.baseUrl ?? defaultBaseUrl(model);
    const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const body = JSON.stringify(buildChatBody(request, model));
    const timeout = AbortSignal.timeout(model.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headers },
        body,
        signal,
      });
    } catch (error) {
      throw classifyNetworkError(error, request.modelId);
    }

    const text = await response.text();
    if (!response.ok) throw classifyHttpError(response.status, text, response.headers, request.modelId);

    let parsed: ChatResponse;
    try {
      parsed = JSON.parse(text) as ChatResponse;
    } catch (error) {
      throw new ModelError("invalid", `model ${request.modelId}: response is not JSON`, {
        cause: error,
        modelId: request.modelId,
      });
    }
    const choice = parsed.choices?.[0];
    if (!choice?.message) {
      throw new ModelError("invalid", `model ${request.modelId}: response has no choices`, {
        modelId: request.modelId,
      });
    }
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.function?.name ?? "",
      arguments: c.function?.arguments ?? "{}",
    }));
    const usage = parsed.usage ?? {};
    const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
    const rateLimit = rateLimitFromHeaders(response.headers);
    return {
      text: choice.message.content ?? "",
      toolCalls,
      usage: {
        promptTokens: usage.prompt_tokens ?? 0,
        cachedTokens: cached,
        outputTokens: usage.completion_tokens ?? 0,
      },
      finishReason: toFinishReason(choice.finish_reason),
      model: parsed.model ?? model.model,
      ...(rateLimit ? { rateLimit } : {}),
    };
  }
}

function defaultBaseUrl(model: ModelConfig): string {
  switch (model.provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "ollama":
      return "http://127.0.0.1:11434/v1";
    default:
      throw new ModelError("invalid", `model "${model.model}" has no baseUrl`, { modelId: model.model });
  }
}

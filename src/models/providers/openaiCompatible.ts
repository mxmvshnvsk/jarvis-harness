import type { ModelConfig } from "../../core/config/schema.ts";
import { classifyHttpError, classifyNetworkError, ModelError } from "../errors.ts";
import { dispatcherFor } from "../http.ts";
import { sseData } from "../sse.ts";
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
 * DeepSeek, Qwen and OpenAI itself. Deliberately a thin fetch client — no SDK — so the closed
 * contour has nothing extra to mirror. Answers are streamed (SSE) unless the model config says
 * `stream: false` or the server refused a stream before; a server that ignores `stream` and
 * answers with plain JSON is read as such.
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

export function buildChatBody(
  request: ModelRequest,
  model: ModelConfig,
  stream = false,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model.model,
    messages: request.messages.map(toChatMessage),
    stream,
  };
  // usage comes in the last chunk only when asked for
  if (stream) body.stream_options = { include_usage: true };
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

interface ChatChunk {
  model?: string;
  error?: { message?: string; code?: unknown; type?: string };
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: ChatResponse["usage"];
}

/** Servers (by url and model) that refused `stream: true`; asked without it from then on. */
const NO_STREAM = new Set<string>();

/** A 400/422 that names streaming: the server does not take `stream` or `stream_options`. */
function refusesStream(status: number, body: string): boolean {
  return (status === 400 || status === 422) && /stream/i.test(body);
}

/** Reads an SSE answer into the shape of a non-streamed one. */
async function readStream(
  body: AsyncIterable<Uint8Array>,
  modelId: string,
  started: number,
  onProgress: ProviderCallOptions["onProgress"],
): Promise<{ parsed: ChatResponse; firstTokenMs?: number }> {
  let content = "";
  let reasoning = 0;
  let model: string | undefined;
  let finish: string | undefined;
  let usage: ChatResponse["usage"];
  let done = false;
  let firstTokenMs: number | undefined;
  const calls: Array<{ id?: string; name: string; arguments: string }> = [];
  for await (const data of sseData(body)) {
    if (data.trim() === "[DONE]") {
      done = true;
      break;
    }
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(data) as ChatChunk;
    } catch (error) {
      throw new ModelError("invalid", `model ${modelId}: stream chunk is not JSON: ${data.slice(0, 200)}`, {
        cause: error,
        modelId,
      });
    }
    if (chunk.error) {
      // a gateway that fails after the headers reports it inside the stream
      throw new ModelError(
        "transient",
        `model ${modelId}: provider error in stream: ${chunk.error.message ?? JSON.stringify(chunk.error)}`.slice(
          0,
          600,
        ),
        { modelId },
      );
    }
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    let grew = false;
    if (delta?.content) {
      content += delta.content;
      grew = true;
    }
    if (delta?.reasoning_content) {
      reasoning += delta.reasoning_content.length;
      grew = true;
    }
    for (const call of delta?.tool_calls ?? []) {
      const index = call.index ?? calls.length;
      const slot = calls[index] ?? { name: "", arguments: "" };
      if (call.id) slot.id = call.id;
      if (call.function?.name) slot.name += call.function.name;
      if (call.function?.arguments) slot.arguments += call.function.arguments;
      calls[index] = slot;
      grew = true;
    }
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (grew) {
      firstTokenMs ??= Date.now() - started;
      onProgress?.({
        outputChars: content.length + calls.reduce((n, c) => n + c.arguments.length, 0),
        reasoningChars: reasoning,
        toolCalls: calls.filter(Boolean).length,
        firstTokenMs,
      });
    }
  }
  if (!done && finish === undefined) {
    // the connection closed mid-answer: a cut, not an answer
    throw new ModelError("transient", `model ${modelId}: the stream ended before the answer was complete`, {
      modelId,
    });
  }
  const toolCalls = calls.filter(Boolean).map((c, i) => ({
    id: c.id ?? `call_${i}`,
    type: "function" as const,
    function: { name: c.name, arguments: c.arguments || "{}" },
  }));
  const parsed: ChatResponse = {
    ...(model ? { model } : {}),
    choices: [
      {
        finish_reason: finish ?? "stop",
        message: { content, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) },
      },
    ],
    ...(usage ? { usage } : {}),
  };
  return { parsed, ...(firstTokenMs !== undefined ? { firstTokenMs } : {}) };
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
    const serverKey = `${url}|${model.model}`;
    const stream = model.stream !== false && !NO_STREAM.has(serverKey);
    const body = JSON.stringify(buildChatBody(request, model, stream));
    const timeout = AbortSignal.timeout(model.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    const dispatcher = await dispatcherFor(model.timeoutMs);
    const started = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headers },
        body,
        signal,
        // Node's fetch extension: header/body timeouts past undici's 300 s default (see http.ts)
        ...(dispatcher ? { dispatcher } : {}),
      } as unknown as RequestInit);
    } catch (error) {
      throw classifyNetworkError(error, request.modelId);
    }

    const sse = /text\/event-stream/i.test(response.headers.get("content-type") ?? "");
    let parsed: ChatResponse;
    let firstTokenMs: number | undefined;
    if (response.ok && sse && response.body) {
      try {
        const read = await readStream(
          response.body as unknown as AsyncIterable<Uint8Array>,
          request.modelId,
          started,
          options.onProgress,
        );
        parsed = read.parsed;
        firstTokenMs = read.firstTokenMs;
      } catch (error) {
        throw classifyNetworkError(error, request.modelId);
      }
    } else {
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw classifyNetworkError(error, request.modelId);
      }
      if (!response.ok) {
        if (stream && refusesStream(response.status, text)) {
          NO_STREAM.add(serverKey);
          return this.call(request, model, options);
        }
        throw classifyHttpError(response.status, text, response.headers, request.modelId);
      }
      try {
        parsed = JSON.parse(text) as ChatResponse;
      } catch (error) {
        throw new ModelError("invalid", `model ${request.modelId}: response is not JSON`, {
          cause: error,
          modelId: request.modelId,
        });
      }
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
      ...(sse ? { streamed: true } : {}),
      ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
    };
  }
}

/** For tests: forget which servers refused a stream. */
export function resetStreamSupport(): void {
  NO_STREAM.clear();
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

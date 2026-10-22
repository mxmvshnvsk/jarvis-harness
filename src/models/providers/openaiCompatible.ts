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

/**
 * Tool names on the wire: OpenAI's API (and DeepSeek's, which checks it) takes `^[a-zA-Z0-9_-]{1,64}$`,
 * while Jarvis names its tools `repo.read`, `mcp.jira.get`. Each name is sent in that alphabet, one to
 * one within a request, and a call comes back under the name Jarvis knows.
 */
export interface ToolNames {
  readonly toWire: (name: string) => string;
  readonly fromWire: (name: string) => string;
}

const WIRE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function toolNamesFor(request: ModelRequest): ToolNames {
  const names = new Set<string>();
  for (const t of request.tools ?? []) names.add(t.name);
  for (const m of request.messages) for (const c of m.toolCalls ?? []) names.add(c.name);
  const wire = new Map<string, string>();
  const back = new Map<string, string>();
  // names already valid keep themselves, so a mended one never takes theirs
  for (const name of names)
    if (WIRE_NAME.test(name)) {
      wire.set(name, name);
      back.set(name, name);
    }
  for (const name of names) {
    if (wire.has(name)) continue;
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
    let candidate = safe;
    for (let i = 2; back.has(candidate); i += 1) candidate = `${safe.slice(0, 60)}_${i}`;
    wire.set(name, candidate);
    back.set(candidate, name);
  }
  return {
    toWire: (name) => wire.get(name) ?? (WIRE_NAME.test(name) ? name : name.replace(/[^a-zA-Z0-9_-]/g, "_")),
    fromWire: (name) => back.get(name) ?? name,
  };
}

function toChatMessage(message: Message, names: ToolNames): ChatMessage {
  const out: ChatMessage = { role: message.role, content: message.content };
  if (message.toolCallId) out.tool_call_id = message.toolCallId;
  if (message.toolCalls && message.toolCalls.length > 0) {
    out.tool_calls = message.toolCalls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: names.toWire(c.name), arguments: c.arguments },
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

/**
 * The `reasoning_effort` a call carries: the request's (an agent's), else the model's own. A request's
 * goes only to a model that reasons (`supports.reasoning`) or has an effort of its own — a model that
 * does not know the field may refuse the call.
 */
export function effortFor(request: ModelRequest, model: ModelConfig): string | undefined {
  if (request.reasoningEffort && (model.supports.reasoning || model.reasoningEffort !== undefined))
    return request.reasoningEffort;
  return model.reasoningEffort;
}

export function buildChatBody(
  request: ModelRequest,
  model: ModelConfig,
  stream = false,
  names: ToolNames = toolNamesFor(request),
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: model.model,
    messages: request.messages.map((m) => toChatMessage(m, names)),
    stream,
  };
  // usage comes in the last chunk only when asked for
  if (stream) body.stream_options = { include_usage: true };
  const maxOutput = request.maxOutput ?? model.maxOutput;
  body.max_tokens = Math.min(maxOutput, model.maxOutput);
  const effort = effortFor(request, model);
  if (effort) body.reasoning_effort = effort;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((t) => ({
      type: "function",
      function: { name: names.toWire(t.name), description: t.description, parameters: t.parameters },
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
    const names = toolNamesFor(request);
    const body = JSON.stringify(buildChatBody(request, model, stream, names));
    // `timeoutMs` is how long the server may stay silent — before the answer starts and between its
    // chunks — not the whole answer's time: a long answer still streaming was cut at 120 s and asked
    // again from the start, twice (pilot). A cap of its own bounds the whole call.
    const idle = idleTimeout(model.timeoutMs);
    const cap = AbortSignal.timeout(Math.max(model.timeoutMs * 10, STREAM_CAP_MS));
    const signal = AbortSignal.any([idle.signal, cap, ...(options.signal ? [options.signal] : [])]);
    try {
      return await this.send(request, model, options, { url, serverKey, stream, names, body, signal, idle });
    } finally {
      idle.stop();
    }
  }

  private async send(
    request: ModelRequest,
    model: ModelConfig,
    options: ProviderCallOptions,
    call: {
      url: string;
      serverKey: string;
      stream: boolean;
      names: ReturnType<typeof toolNamesFor>;
      body: string;
      signal: AbortSignal;
      idle: ReturnType<typeof idleTimeout>;
    },
  ): Promise<ProviderResult> {
    const { url, serverKey, stream, names, body, signal, idle } = call;
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
          touching(response.body as unknown as AsyncIterable<Uint8Array>, idle.touch),
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
      name: names.fromWire(c.function?.name ?? ""),
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

/** The whole call's bound, however long the stream keeps going (`timeoutMs` × 10 when more). */
export const STREAM_CAP_MS = 30 * 60_000;

/** An abort after `ms` of silence: `touch` on every chunk starts the wait again. */
export function idleTimeout(ms: number): { signal: AbortSignal; touch: () => void; stop: () => void } {
  const controller = new AbortController();
  const fire = () =>
    controller.abort(new DOMException(`no data from the model for ${ms} ms`, "TimeoutError"));
  let timer = setTimeout(fire, ms);
  return {
    signal: controller.signal,
    touch: () => {
      clearTimeout(timer);
      timer = setTimeout(fire, ms);
    },
    stop: () => clearTimeout(timer),
  };
}

async function* touching(body: AsyncIterable<Uint8Array>, touch: () => void): AsyncIterable<Uint8Array> {
  for await (const chunk of body) {
    touch();
    yield chunk;
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

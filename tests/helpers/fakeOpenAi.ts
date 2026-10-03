import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeReply {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body: unknown;
}

export interface CapturedRequest {
  readonly url: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Record<string, unknown>;
}

export type Responder = (request: CapturedRequest, index: number) => FakeReply;

export interface FakeOpenAi {
  readonly baseUrl: string;
  readonly requests: CapturedRequest[];
  respond(responder: Responder): void;
  /** Queue replies in order; after the queue is drained the responder (if any) is used. */
  queue(...replies: FakeReply[]): void;
  close(): Promise<void>;
}

export function completion(text: string, extra: Record<string, unknown> = {}): FakeReply {
  return {
    body: {
      id: "chatcmpl-1",
      model: "fake-model",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
      usage: { prompt_tokens: 42, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 10 } },
      ...extra,
    },
  };
}

export function toolCallCompletion(name: string, args: Record<string, unknown>): FakeReply {
  return {
    body: {
      id: "chatcmpl-2",
      model: "fake-model",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 5 },
    },
  };
}

export async function startFakeOpenAi(): Promise<FakeOpenAi> {
  const requests: CapturedRequest[] = [];
  const queued: FakeReply[] = [];
  let responder: Responder | undefined;
  let index = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      const captured: CapturedRequest = {
        url: req.url ?? "",
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      requests.push(captured);
      const reply: FakeReply =
        queued.shift() ??
        responder?.(captured, index) ??
        ({ status: 500, body: { error: { message: "no reply configured" } } } satisfies FakeReply);
      index += 1;
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    respond(r) {
      responder = r;
    },
    queue(...replies) {
      queued.push(...replies);
    },
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

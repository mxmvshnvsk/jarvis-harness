import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryUsageStore } from "../../src/budget/usage.ts";
import { EnvSecretResolver } from "../../src/core/config/secrets.ts";
import { defaultAdapters, ModelError, ModelGateway } from "../../src/models/index.ts";
import { resetStreamSupport } from "../../src/models/providers/openaiCompatible.ts";
import { sseData } from "../../src/models/sse.ts";
import { MemoryEventStore } from "../../src/telemetry/events.ts";
import { completion, type FakeOpenAi, startFakeOpenAi, streamedChunks } from "../helpers/fakeOpenAi.ts";
import { testConfig } from "../helpers/modelConfig.ts";

let server: FakeOpenAi;
let events: MemoryEventStore;

beforeEach(async () => {
  server = await startFakeOpenAi();
  events = new MemoryEventStore();
  resetStreamSupport();
});
afterEach(async () => {
  await server.close();
});

function gateway(models: Record<string, unknown> = {}) {
  const config = testConfig(server.baseUrl);
  for (const [id, extra] of Object.entries(models)) Object.assign(config.models[id] ?? {}, extra);
  return new ModelGateway({
    config,
    adapters: defaultAdapters(),
    secrets: new EnvSecretResolver({ FAKE_TOKEN: "secret-token", CLOUD_TOKEN: "cloud-token" }),
    usage: new MemoryUsageStore(),
    events,
    sleep: async () => {},
  });
}

const ask = {
  modelId: "private",
  role: "research",
  runId: "run-1",
  stepId: "spec",
  messages: [{ role: "user" as const, content: "hello" }],
};

async function* bytes(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield new TextEncoder().encode(p);
}

describe("sseData", () => {
  it("joins payloads split across chunks, skips comments and other fields", async () => {
    const out: string[] = [];
    for await (const d of sseData(
      bytes(": keep-alive\n\n", 'data: {"a"', ":1}\r\n\r\nevent: x\ndata: [DO", "NE]\n\n"),
    ))
      out.push(d);
    expect(out).toEqual(['{"a":1}', "[DONE]"]);
  });

  it("yields a last payload without the closing blank line", async () => {
    const out: string[] = [];
    for await (const d of sseData(bytes("data: one\n\ndata: two"))) out.push(d);
    expect(out).toEqual(["one", "two"]);
  });
});

describe("streamed answers", () => {
  it("asks for a stream and assembles the answer, usage and the time to the first token", async () => {
    server.queue({ sse: { chunks: streamedChunks(["Hel", "lo ", "there"], ["thinking…"]) } });
    const response = await gateway().call(ask);
    expect(server.requests[0]?.body.stream).toBe(true);
    expect(server.requests[0]?.body.stream_options).toEqual({ include_usage: true });
    expect(response).toMatchObject({
      text: "Hello there",
      finishReason: "stop",
      model: "fake-model",
      usage: { promptTokens: 42, outputTokens: 7 },
      streamed: true,
    });
    expect(response.firstTokenMs).toBeGreaterThanOrEqual(0);
    const call = events.events.filter((e) => e.kind === "model.call")[0]?.payload as Record<string, unknown>;
    expect(call).toMatchObject({ streamed: true });
    // the first piece is reported at once, the rest is throttled
    const progress = events.events.filter((e) => e.kind === "model.progress");
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(progress[0]).toMatchObject({ runId: "run-1", stepId: "spec" });
    expect(progress[0]?.payload).toMatchObject({ modelId: "private", reasoningChars: "thinking…".length });
  });

  it("assembles tool calls sent in pieces", async () => {
    server.queue({
      sse: {
        chunks: [
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: "c1", function: { name: "repo.", arguments: '{"pa' } }],
                },
              },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { name: "read", arguments: 'th":"a.ts"}' } }] } },
            ],
          },
          { choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "repo.list" } }] } }] },
          { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        ],
      },
    });
    const response = await gateway().call(ask);
    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([
      { id: "c1", name: "repo.read", arguments: '{"path":"a.ts"}' },
      { id: "c2", name: "repo.list", arguments: "{}" },
    ]);
  });

  it("reads a plain JSON answer from a server that ignores `stream`", async () => {
    server.queue(completion("plain"));
    const response = await gateway().call(ask);
    expect(response.text).toBe("plain");
    expect(response.streamed).toBeUndefined();
  });

  it("asks again without a stream when the server refuses it, and remembers", async () => {
    server.queue(
      { status: 400, body: { error: { message: "unknown field: stream_options" } } },
      completion("no stream here"),
      completion("again"),
    );
    const g = gateway();
    expect((await g.call(ask)).text).toBe("no stream here");
    expect((await g.call(ask)).text).toBe("again");
    expect(server.requests.map((r) => r.body.stream)).toEqual([true, false, false]);
    expect(events.events.filter((e) => e.kind === "model.retry")).toHaveLength(0);
  });

  it("does not stream when the model says `stream: false`", async () => {
    server.queue(completion("off"));
    await gateway({ private: { stream: false } }).call(ask);
    expect(server.requests[0]?.body.stream).toBe(false);
    expect(server.requests[0]?.body.stream_options).toBeUndefined();
  });

  it("retries a stream cut mid-answer and an error sent inside the stream", async () => {
    server.queue(
      { sse: { chunks: [{ choices: [{ delta: { content: "half" } }] }], done: false } },
      { sse: { chunks: [{ error: { message: "upstream timeout" } }] } },
      { sse: { chunks: streamedChunks(["whole"]) } },
    );
    const response = await gateway().call(ask);
    expect(response.text).toBe("whole");
    expect(response.retries).toBe(2);
    const reasons = events.events
      .filter((e) => e.kind === "model.retry")
      .map((e) => (e.payload as { message: string }).message);
    expect(reasons[0]).toContain("the stream ended before the answer was complete");
    expect(reasons[1]).toContain("provider error in stream: upstream timeout");
  });

  it("names a broken chunk as an invalid answer", async () => {
    server.queue({ sse: { chunks: ["{not json"] } });
    const error = await gateway()
      .call(ask)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).kind).toBe("invalid");
  });
});

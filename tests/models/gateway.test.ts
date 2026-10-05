import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryUsageStore } from "../../src/budget/usage.ts";
import { EnvSecretResolver } from "../../src/core/config/secrets.ts";
import { classifyNetworkError } from "../../src/models/errors.ts";
import { defaultAdapters, MemoryCassetteStore, ModelError, ModelGateway } from "../../src/models/index.ts";
import { MemoryEventStore } from "../../src/telemetry/events.ts";
import { completion, type FakeOpenAi, startFakeOpenAi, toolCallCompletion } from "../helpers/fakeOpenAi.ts";
import { testConfig } from "../helpers/modelConfig.ts";

let server: FakeOpenAi;
let events: MemoryEventStore;
let usage: MemoryUsageStore;
const sleeps: number[] = [];

beforeEach(async () => {
  server = await startFakeOpenAi();
  events = new MemoryEventStore();
  usage = new MemoryUsageStore();
  sleeps.length = 0;
});

afterEach(async () => {
  await server.close();
});

function gateway(extra: Partial<ConstructorParameters<typeof ModelGateway>[0]> = {}) {
  return new ModelGateway({
    config: testConfig(server.baseUrl),
    adapters: defaultAdapters(),
    secrets: new EnvSecretResolver({ FAKE_TOKEN: "secret-token", CLOUD_TOKEN: "cloud-token" }),
    usage,
    events,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
}

const ask = {
  modelId: "private",
  role: "research",
  runId: "run-1",
  messages: [{ role: "user" as const, content: "hello" }],
};

describe("ModelGateway", () => {
  it("calls the provider with credentials at the transport and records usage and telemetry", async () => {
    server.queue(completion("hi there", { model: "deepseek-flash" }));
    const response = await gateway().call(ask);
    expect(response.text).toBe("hi there");
    expect(response.model).toBe("deepseek-flash");
    expect(response.usage).toEqual({ promptTokens: 42, cachedTokens: 10, outputTokens: 7 });
    expect(response.source).toBe("live");
    const req = server.requests[0];
    expect(req?.headers.authorization).toBe("Bearer secret-token");
    expect(req?.body.model).toBe("fake-model");
    expect(req?.body.max_tokens).toBe(500);
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({
      pool: "corp",
      model: "private",
      runId: "run-1",
      outputTokens: 7,
    });
    const call = events.events.find((e) => e.kind === "model.call");
    expect(call?.payload).toMatchObject({
      modelId: "private",
      role: "research",
      outputTokens: 7,
      retries: 0,
    });
    expect(JSON.stringify(events.events)).not.toContain("secret-token");
  });

  it("applies the role output reserve and never exceeds the model maximum", async () => {
    server.queue(completion("x"));
    await gateway().call({ ...ask, role: "review" });
    expect(server.requests[0]?.body.max_tokens).toBe(100);
    server.queue(completion("x"));
    await gateway().call({ ...ask, maxOutput: 99_999 });
    expect(server.requests[1]?.body.max_tokens).toBe(500);
  });

  it("returns tool calls", async () => {
    server.queue(toolCallCompletion("ping", { echo: "hi" }));
    const response = await gateway().call({
      ...ask,
      tools: [{ name: "ping", description: "p", parameters: { type: "object" } }],
    });
    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([{ id: "call_1", name: "ping", arguments: '{"echo":"hi"}' }]);
  });

  it("retries transient errors with backoff and reports retries", async () => {
    server.queue(
      { status: 503, body: { error: "down" } },
      { status: 502, body: "bad gateway" },
      completion("ok"),
    );
    const response = await gateway().call(ask);
    expect(response.text).toBe("ok");
    expect(response.retries).toBe(2);
    expect(sleeps).toEqual([500, 1000]);
    expect(events.events.filter((e) => e.kind === "model.retry")).toHaveLength(2);
  });

  it("gives up on transient errors after the bounded retries", async () => {
    server.queue({ status: 500, body: "a" }, { status: 500, body: "b" }, { status: 500, body: "c" });
    await expect(gateway().call(ask)).rejects.toMatchObject({ kind: "transient", status: 500 });
    expect(events.events.at(-1)?.kind).toBe("model.error");
  });

  it("honours a short Retry-After on rate limits", async () => {
    server.queue(
      { status: 429, headers: { "retry-after": "2" }, body: { error: { message: "Rate limit reached" } } },
      completion("after wait"),
    );
    const response = await gateway().call(ask);
    expect(response.text).toBe("after wait");
    expect(sleeps).toEqual([2000]);
  });

  it("does not retry quota exhaustion and surfaces it as quota_exhausted", async () => {
    server.queue({
      status: 429,
      body: { error: { type: "insufficient_quota", message: "You exceeded your current quota" } },
    });
    await expect(gateway().call(ask)).rejects.toMatchObject({ kind: "quota_exhausted", status: 429 });
    expect(server.requests).toHaveLength(1);
  });

  it("escalates a long Retry-After to quota_exhausted instead of sleeping", async () => {
    server.queue({
      status: 429,
      headers: { "retry-after": "120" },
      body: { error: { message: "rate limit" } },
    });
    await expect(gateway().call(ask)).rejects.toMatchObject({
      kind: "quota_exhausted",
      retryAfterMs: 120_000,
    });
    expect(sleeps).toEqual([]);
  });

  it("fails fast on auth errors", async () => {
    server.queue({ status: 401, body: "nope" });
    await expect(gateway().call(ask)).rejects.toMatchObject({ kind: "auth" });
  });

  it("fails before the call when the secret is missing", async () => {
    const g = gateway({ secrets: new EnvSecretResolver({}) });
    await expect(g.call(ask)).rejects.toMatchObject({ kind: "auth" });
    expect(server.requests).toHaveLength(0);
  });

  it("denies cloud models in a confidential project before any network call (ADR-0016)", async () => {
    await expect(gateway().call({ ...ask, modelId: "cloud" })).rejects.toMatchObject({ kind: "policy" });
    expect(server.requests).toHaveLength(0);
    expect(events.events.find((e) => e.kind === "model.error")?.payload).toMatchObject({ kind: "policy" });
  });

  it("denies admission when the pool window is exhausted", async () => {
    usage.record({ pool: "corp", model: "private", promptTokens: 1, cachedTokens: 0, outputTokens: 900 });
    await expect(gateway().call(ask)).rejects.toMatchObject({ kind: "quota_exhausted" });
    expect(server.requests).toHaveLength(0);
    const error = await gateway()
      .call(ask)
      .catch((e: unknown) => e as ModelError);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).retryAfterMs).toBeGreaterThan(0);
  });

  it("records and replays cassettes; replay touches neither network nor budget", async () => {
    const store = new MemoryCassetteStore();
    server.queue(completion("recorded"));
    const recorded = await gateway({ cassette: { mode: "record", store } }).call(ask);
    expect(recorded.source).toBe("record");
    expect(store.entries.size).toBe(1);

    const replayed = await gateway({ cassette: { mode: "replay", store } }).call(ask);
    expect(replayed.source).toBe("replay");
    expect(replayed.text).toBe("recorded");
    expect(server.requests).toHaveLength(1);
    expect(usage.records).toHaveLength(1);

    await expect(
      gateway({ cassette: { mode: "replay", store } }).call({
        ...ask,
        messages: [{ role: "user", content: "other" }],
      }),
    ).rejects.toMatchObject({ kind: "replay_miss" });
  });

  it("calibrates the token estimator from reported usage", async () => {
    const g = gateway();
    const before = g.estimator.estimateText("private", "deepseek", "x".repeat(360));
    server.queue(completion("ok", { usage: { prompt_tokens: 200, completion_tokens: 1 } }));
    await g.call({ ...ask, messages: [{ role: "user", content: "x".repeat(360) }] });
    const after = g.estimator.estimateText("private", "deepseek", "x".repeat(360));
    expect(after).toBeGreaterThan(before);
  });
});

describe("classifyNetworkError", () => {
  it("names the root cause of a bare `fetch failed` and says what to do about an untrusted CA", () => {
    const tls = Object.assign(new Error("self-signed certificate in certificate chain"), {
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    });
    const error = classifyNetworkError(new TypeError("fetch failed", { cause: tls }), "corp");
    expect(error.kind).toBe("transient");
    expect(error.message).toBe(
      "model corp: network error: fetch failed (SELF_SIGNED_CERT_IN_CHAIN: self-signed certificate in certificate chain)" +
        " — Node does not trust the endpoint's CA (a corporate CA?): set NODE_OPTIONS=--use-system-ca or NODE_EXTRA_CA_CERTS=<ca.pem>",
    );
  });

  it("keeps the plain message when there is no cause", () => {
    expect(classifyNetworkError(new Error("socket hang up"), "corp").message).toBe(
      "model corp: network error: socket hang up",
    );
  });
});

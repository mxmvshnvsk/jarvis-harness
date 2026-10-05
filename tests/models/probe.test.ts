import { createServer } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvSecretResolver } from "../../src/core/config/secrets.ts";
import {
  defaultAdapters,
  ModelGateway,
  ProbeStore,
  probeDrift,
  probeIsStale,
  probeModel,
} from "../../src/models/index.ts";
import { completion, type FakeOpenAi, startFakeOpenAi, toolCallCompletion } from "../helpers/fakeOpenAi.ts";
import { testConfig } from "../helpers/modelConfig.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let server: FakeOpenAi;
let sb: Sandbox;
beforeEach(async () => {
  server = await startFakeOpenAi();
  sb = sandbox();
});
afterEach(async () => {
  await server.close();
  sb.cleanup();
});

describe("probeModel", () => {
  it("detects what the endpoint really supports and records drift against the config", async () => {
    server.respond((req) => {
      const body = req.body as { response_format?: { type: string }; tools?: unknown[] };
      if (body.tools) return toolCallCompletion("ping", { echo: "hi" });
      if (body.response_format?.type === "json_schema")
        return { status: 400, body: { error: { message: "json_schema unsupported" } } };
      if (body.response_format?.type === "json_object") return completion('{"ok": true}');
      return completion("PONG");
    });
    const config = testConfig(server.baseUrl);
    const gateway = new ModelGateway({
      config,
      adapters: defaultAdapters(),
      secrets: new EnvSecretResolver({ FAKE_TOKEN: "t" }),
    });
    const result = await probeModel(gateway, "schema");
    expect(result.supports).toEqual({ tools: true, jsonMode: true, jsonSchema: false, systemRole: true });
    expect(result.errors.jsonSchema).toContain("json_schema unsupported");
    const drift = probeDrift(config.models.schema as NonNullable<typeof config.models.schema>, result);
    expect(drift).toEqual([{ capability: "jsonSchema", configured: true, probed: false }]);

    const store = new ProbeStore(sb.home);
    store.set(result);
    expect(store.get("schema")?.supports.tools).toBe(true);
    expect(probeIsStale(result)).toBe(false);
    expect(probeIsStale({ ...result, probedAt: "2020-01-01T00:00:00Z" })).toBe(true);
  });

  it("stops immediately on auth failures instead of recording them as unsupported", async () => {
    server.respond(() => ({ status: 401, body: "no" }));
    const gateway = new ModelGateway({
      config: testConfig(server.baseUrl),
      adapters: defaultAdapters(),
      secrets: new EnvSecretResolver({ FAKE_TOKEN: "t" }),
    });
    await expect(probeModel(gateway, "private")).rejects.toMatchObject({ kind: "auth" });
    expect(server.requests).toHaveLength(1);
  });

  it("fails on an unreachable endpoint instead of recording every capability as unsupported", async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const address = probe.address();
        probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
      });
    });
    const gateway = new ModelGateway({
      config: testConfig(`http://127.0.0.1:${port}/v1`),
      adapters: defaultAdapters(),
      secrets: new EnvSecretResolver({ FAKE_TOKEN: "t" }),
      sleep: async () => {},
    });
    const failure = probeModel(gateway, "private");
    await expect(failure).rejects.toMatchObject({ kind: "transient" });
    // the reason is named, not just "fetch failed"
    await expect(failure).rejects.toThrow(/ECONNREFUSED/);
  });

  it("gives a reasoning model room to think and never reads a cut-off answer as unsupported", async () => {
    // like DeepSeek-V4-Flash in the pilot: the thinking eats the budget, `content` stays empty
    const thinking = 200;
    const cutOff = (maxTokens: number) => ({
      body: {
        choices: [{ finish_reason: "length", message: { role: "assistant", content: "" } }],
        usage: { prompt_tokens: 80, completion_tokens: maxTokens },
      },
    });
    server.respond((req) => {
      const body = req.body as { max_tokens: number; response_format?: { type: string }; tools?: unknown[] };
      if (body.response_format?.type === "json_schema") return cutOff(body.max_tokens);
      if (body.max_tokens < thinking) return cutOff(body.max_tokens);
      if (body.tools) return toolCallCompletion("ping", { echo: "hi" });
      if (body.response_format?.type === "json_object") return completion('{"ok": true}');
      return completion("Sure: PING");
    });
    const config = testConfig(server.baseUrl, {
      models: {
        big: {
          provider: "openai-compatible",
          baseUrl: server.baseUrl,
          model: "thinker",
          egress: "private",
          contextWindow: 32000,
          maxOutput: 4000,
          supports: { tools: true, jsonMode: true, jsonSchema: true, systemRole: true },
        },
      },
      roles: {},
    });
    const gateway = new ModelGateway({
      config,
      adapters: defaultAdapters(),
      secrets: new EnvSecretResolver({}),
    });
    const result = await probeModel(gateway, "big");
    const first = server.requests[0]?.body as { max_tokens?: number } | undefined;
    expect(first?.max_tokens).toBeGreaterThanOrEqual(thinking);
    expect(result.supports).toEqual({ tools: true, jsonMode: true, jsonSchema: false, systemRole: false });
    expect(result.inconclusive).toEqual(["jsonSchema"]);
    expect(result.errors.jsonSchema).toContain("inconclusive");
    // a wrong answer is named, not a silent "no"
    expect(result.errors.systemRole).toBe('unexpected answer: "Sure: PING"');
    const drift = probeDrift(config.models.big as NonNullable<typeof config.models.big>, result);
    expect(drift).toEqual([{ capability: "systemRole", configured: true, probed: false }]);
  });
});

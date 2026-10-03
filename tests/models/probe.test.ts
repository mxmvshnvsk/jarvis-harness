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
});

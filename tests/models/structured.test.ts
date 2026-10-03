import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { EnvSecretResolver } from "../../src/core/config/secrets.ts";
import {
  defaultAdapters,
  extractJson,
  generateStructured,
  ModelGateway,
  StructuredOutputError,
} from "../../src/models/index.ts";
import { completion, type FakeOpenAi, startFakeOpenAi } from "../helpers/fakeOpenAi.ts";
import { testConfig } from "../helpers/modelConfig.ts";

let server: FakeOpenAi;
beforeEach(async () => {
  server = await startFakeOpenAi();
});
afterEach(async () => {
  await server.close();
});

const Spec = z.object({ title: z.string(), risks: z.array(z.string()).min(1) });

function gateway() {
  return new ModelGateway({
    config: testConfig(server.baseUrl),
    adapters: defaultAdapters(),
    secrets: new EnvSecretResolver({ FAKE_TOKEN: "t" }),
    sleep: async () => {},
  });
}

const messages = [{ role: "user" as const, content: "Write the spec." }];

describe("extractJson", () => {
  it("finds fenced and bare documents and ignores trailing prose", () => {
    expect(extractJson('Sure:\n```json\n{"a": 1}\n```\nDone.')).toBe('{"a": 1}');
    expect(extractJson('{"a": "}"} trailing')).toBe('{"a": "}"}');
    expect(extractJson("no json here")).toBeUndefined();
  });
});

describe("generateStructured", () => {
  it("schema mode sends response_format json_schema and validates", async () => {
    server.queue(completion(JSON.stringify({ title: "T", risks: ["r"] })));
    const r = await generateStructured(gateway(), {
      modelId: "schema",
      mode: "schema",
      name: "spec",
      schema: Spec,
      messages,
    });
    expect(r.value).toEqual({ title: "T", risks: ["r"] });
    expect(r.repairs).toBe(0);
    const body = server.requests[0]?.body as {
      response_format: { type: string; json_schema: { name: string } };
    };
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("spec");
    expect(server.requests[0]?.body.messages).toEqual(messages);
  });

  it("json mode puts the schema in the system prompt and repairs once on validation failure", async () => {
    server.queue(
      completion(JSON.stringify({ title: "T", risks: [] })),
      completion(JSON.stringify({ title: "T", risks: ["fixed"] })),
    );
    const r = await generateStructured(gateway(), {
      modelId: "private",
      mode: "json",
      name: "spec",
      schema: Spec,
      messages,
    });
    expect(r.value.risks).toEqual(["fixed"]);
    expect(r.repairs).toBe(1);
    expect(r.totalUsage.outputTokens).toBe(14);
    const first = server.requests[0]?.body as {
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(first.response_format.type).toBe("json_object");
    expect(first.messages[0]?.role).toBe("system");
    expect(first.messages[0]?.content).toContain("JSON Schema");
    const second = server.requests[1]?.body as { messages: Array<{ role: string; content: string }> };
    expect(second.messages.at(-1)?.content).toContain("risks");
  });

  it("text mode extracts fenced JSON", async () => {
    server.queue(completion('Here you go:\n```json\n{"title":"T","risks":["x"]}\n```'));
    const r = await generateStructured(gateway(), {
      modelId: "private",
      mode: "text",
      name: "spec",
      schema: Spec,
      messages,
    });
    expect(r.value.title).toBe("T");
    expect(server.requests[0]?.body.response_format).toBeUndefined();
  });

  it("gives up after the repair budget with the raw text preserved", async () => {
    server.queue(completion("not json"), completion("still not"), completion("nope"));
    const error = await generateStructured(gateway(), {
      modelId: "private",
      mode: "json",
      name: "spec",
      schema: Spec,
      messages,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StructuredOutputError);
    const soe = error as StructuredOutputError;
    expect(soe.repairs).toBe(2);
    expect(soe.rawText).toBe("nope");
    expect(server.requests).toHaveLength(3);
  });
});

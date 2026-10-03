import { type ResolvedConfig, ResolvedConfigSchema } from "../../src/core/config/schema.ts";

/** A resolved configuration with one private and one cloud model pointing at `baseUrl`. */
export function testConfig(baseUrl: string, overrides: Record<string, unknown> = {}): ResolvedConfig {
  return ResolvedConfigSchema.parse({
    version: 1,
    dataClass: "confidential",
    quotaPools: {
      corp: {
        window: { minutes: 20 },
        limits: { outputTokens: 1000, requests: 10, concurrency: 2 },
        soft: 0.8,
      },
    },
    models: {
      private: {
        provider: "openai-compatible",
        baseUrl,
        model: "fake-model",
        auth: { type: "bearer", token: "env:FAKE_TOKEN" },
        egress: "private",
        quotaPool: "corp",
        contextWindow: 8000,
        maxOutput: 500,
        supports: { tools: true, jsonMode: true },
        tokenizer: "deepseek",
        timeoutMs: 5000,
      },
      schema: {
        provider: "openai-compatible",
        baseUrl,
        model: "fake-schema-model",
        egress: "private",
        contextWindow: 32000,
        maxOutput: 500,
        supports: { tools: true, jsonMode: true, jsonSchema: true },
      },
      cloud: {
        provider: "openai",
        baseUrl,
        model: "cloud-model",
        auth: { type: "bearer", token: "env:CLOUD_TOKEN" },
        egress: "cloud",
        contextWindow: 200000,
        maxOutput: 4000,
        supports: { tools: true, jsonSchema: true },
      },
    },
    roles: {
      research: { models: ["private", "schema"] },
      review: { models: ["cloud", "private"], maxOutput: 100 },
      strict: { models: ["private"] },
    },
    ...overrides,
  });
}

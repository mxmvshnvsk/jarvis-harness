import type { ModelProvider } from "../../core/config/schema.ts";
import { ModelError } from "../errors.ts";
import type { ProviderAdapter } from "../types.ts";
import { OpenAiCompatibleAdapter } from "./openaiCompatible.ts";

export type AdapterRegistry = Readonly<Record<ModelProvider, ProviderAdapter | undefined>>;

/**
 * Adapters by provider (ADR-0017 §2). `openai`, `ollama` and corporate gateways all speak the
 * OpenAI chat-completions dialect; a native Anthropic adapter is a later addition.
 */
export function defaultAdapters(fetchImpl: typeof fetch = fetch): AdapterRegistry {
  const openai = new OpenAiCompatibleAdapter(fetchImpl);
  return {
    "openai-compatible": openai,
    openai,
    ollama: openai,
    anthropic: undefined,
  };
}

export function adapterFor(
  registry: AdapterRegistry,
  provider: ModelProvider,
  modelId: string,
): ProviderAdapter {
  const adapter = registry[provider];
  if (!adapter) {
    throw new ModelError("policy", `model ${modelId}: provider "${provider}" has no adapter yet`, {
      modelId,
    });
  }
  return adapter;
}

export { buildChatBody, OpenAiCompatibleAdapter, parseResetDuration } from "./openaiCompatible.ts";

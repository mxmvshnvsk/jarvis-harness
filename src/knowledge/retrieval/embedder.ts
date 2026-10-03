import type { ModelConfig } from "../../core/config/schema.ts";
import { isSecretRef, type SecretRef, type SecretResolver } from "../../core/config/secrets.ts";

/**
 * Embedder port (ADR-0015 §4): `openaiCompatible` talks to `/embeddings` of a configured model;
 * a local multilingual embedder is a second implementation of the same port. The id carries the
 * model so a different embedder never shares an index.
 */
export interface Embedder {
  readonly id: string;
  readonly dims?: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export class OpenAiCompatibleEmbedder implements Embedder {
  readonly id: string;
  private readonly config: ModelConfig;
  private readonly secrets: SecretResolver;
  private readonly fetchImpl: typeof fetch;

  constructor(
    modelId: string,
    config: ModelConfig,
    secrets: SecretResolver,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.id = `openai-compatible:${modelId}:${config.model}`;
    this.config = config;
    this.secrets = secrets;
    this.fetchImpl = fetchImpl;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const headers: Record<string, string> = { "content-type": "application/json", ...this.config.headers };
    const auth = this.config.auth;
    if (auth.type !== "none") {
      const token = isSecretRef(auth.token) ? await this.secrets.resolve(auth.token as SecretRef) : undefined;
      if (!token) throw new Error(`embeddings model ${this.id}: credential ${auth.token} is not set`);
      if (auth.type === "bearer") headers.authorization = `Bearer ${token}`;
      else headers[auth.header] = token;
    }
    const base = this.config.baseUrl?.replace(/\/$/, "") ?? "";
    const response = await this.fetchImpl(`${base}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.config.model, input: texts }),
    });
    if (!response.ok)
      throw new Error(
        `embeddings ${this.id}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`,
      );
    const body = (await response.json()) as { data?: Array<{ index?: number; embedding: number[] }> };
    const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return data.map((d) => d.embedding);
  }
}

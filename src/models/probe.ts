import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelConfig, ModelSupports } from "../core/config/schema.ts";
import { ModelError } from "./errors.ts";
import type { ModelGateway } from "./gateway.ts";

/**
 * `jarvis models probe` (ADR-0007 §1): canary requests that establish what a model actually
 * supports, recorded next to the configuration claims so `doctor` can flag drift.
 */
export interface ProbeResult {
  readonly modelId: string;
  readonly probedAt: string;
  readonly latencyMs: number;
  readonly supports: Pick<ModelSupports, "tools" | "jsonMode" | "jsonSchema" | "systemRole">;
  readonly errors: Record<string, string>;
  readonly outputTokens: number;
}

export interface ProbeDrift {
  readonly capability: keyof ProbeResult["supports"];
  readonly configured: boolean;
  readonly probed: boolean;
}

const PING_TOOL = {
  name: "ping",
  description: "Call this tool to acknowledge the request.",
  parameters: { type: "object", properties: { echo: { type: "string" } }, required: ["echo"] },
};

export async function probeModel(gateway: ModelGateway, modelId: string): Promise<ProbeResult> {
  const errors: Record<string, string> = {};
  const started = Date.now();
  let outputTokens = 0;
  const attempt = async (name: string, fn: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await fn();
    } catch (error) {
      if (
        error instanceof ModelError &&
        (error.kind === "auth" || error.kind === "quota_exhausted" || error.kind === "policy")
      ) {
        throw error;
      }
      errors[name] = error instanceof Error ? error.message : String(error);
      return false;
    }
  };

  const systemRole = await attempt("systemRole", async () => {
    const r = await gateway.call({
      modelId,
      role: "probe",
      maxOutput: 16,
      temperature: 0,
      messages: [
        { role: "system", content: "You answer with exactly the word PONG and nothing else." },
        { role: "user", content: "Say the word." },
      ],
    });
    outputTokens += r.usage.outputTokens;
    return /pong/i.test(r.text);
  });

  const jsonMode = await attempt("jsonMode", async () => {
    const r = await gateway.call({
      modelId,
      role: "probe",
      maxOutput: 32,
      temperature: 0,
      responseFormat: { kind: "json" },
      messages: [{ role: "user", content: 'Return a JSON object {"ok": true}.' }],
    });
    outputTokens += r.usage.outputTokens;
    return (JSON.parse(r.text) as { ok?: unknown }).ok === true;
  });

  const jsonSchema = await attempt("jsonSchema", async () => {
    const r = await gateway.call({
      modelId,
      role: "probe",
      maxOutput: 32,
      temperature: 0,
      responseFormat: {
        kind: "schema",
        name: "probe",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
      },
      messages: [{ role: "user", content: "Set ok to true." }],
    });
    outputTokens += r.usage.outputTokens;
    return (JSON.parse(r.text) as { ok?: unknown }).ok === true;
  });

  const tools = await attempt("tools", async () => {
    const r = await gateway.call({
      modelId,
      role: "probe",
      maxOutput: 64,
      temperature: 0,
      tools: [PING_TOOL],
      messages: [{ role: "user", content: 'Call the ping tool with echo "hi".' }],
    });
    outputTokens += r.usage.outputTokens;
    return r.toolCalls.some((c) => c.name === "ping");
  });

  return {
    modelId,
    probedAt: new Date().toISOString(),
    latencyMs: Date.now() - started,
    supports: { tools, jsonMode, jsonSchema, systemRole },
    errors,
    outputTokens,
  };
}

export function probeDrift(model: ModelConfig, probe: ProbeResult): ProbeDrift[] {
  const keys: Array<keyof ProbeResult["supports"]> = ["tools", "jsonMode", "jsonSchema", "systemRole"];
  return keys
    .filter((k) => model.supports[k] !== probe.supports[k])
    .map((k) => ({ capability: k, configured: model.supports[k], probed: probe.supports[k] }));
}

export class ProbeStore {
  private readonly dir: string;
  constructor(cacheDir: string) {
    this.dir = join(cacheDir, "models");
  }
  private path(modelId: string): string {
    return join(this.dir, `${encodeURIComponent(modelId)}.probe.json`);
  }
  get(modelId: string): ProbeResult | undefined {
    const path = this.path(modelId);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as ProbeResult;
    } catch {
      return undefined;
    }
  }
  set(result: ProbeResult): string {
    mkdirSync(this.dir, { recursive: true });
    const path = this.path(result.modelId);
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
    return path;
  }
}

export const PROBE_STALE_DAYS = 30;

export function probeIsStale(probe: ProbeResult, now: Date = new Date()): boolean {
  return now.getTime() - Date.parse(probe.probedAt) > PROBE_STALE_DAYS * 86_400_000;
}

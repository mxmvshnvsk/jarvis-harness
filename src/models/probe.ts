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
  /**
   * Capabilities the canary could not decide: the answer was cut off before any content (a reasoning
   * model spends its output budget on thinking first). Never reported as drift. Absent in old files.
   */
  readonly inconclusive?: ReadonlyArray<keyof ProbeResult["supports"]>;
  readonly outputTokens: number;
}

export interface ProbeDrift {
  readonly capability: keyof ProbeResult["supports"];
  readonly configured: boolean;
  readonly probed: boolean;
}

/**
 * Output budget of every canary. Reasoning models think before they answer, and the thinking counts
 * against `max_tokens`: a budget of 16 left DeepSeek-V4-Flash with an empty answer (pilot, 2026-10).
 */
export const PROBE_MAX_OUTPUT = 512;

const PING_TOOL = {
  name: "ping",
  description: "Call this tool to acknowledge the request.",
  parameters: { type: "object", properties: { echo: { type: "string" } }, required: ["echo"] },
};

/** One cheap request, one attempt: is the model answering right now? */
export async function modelAlive(
  gateway: ModelGateway,
  modelId: string,
): Promise<{ ok: true; latencyMs: number } | { ok: false; reason: string }> {
  const started = Date.now();
  try {
    await gateway.call({
      modelId,
      role: "probe",
      noRetry: true,
      maxOutput: PROBE_MAX_OUTPUT,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
    });
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function probeModel(gateway: ModelGateway, modelId: string): Promise<ProbeResult> {
  const errors: Record<string, string> = {};
  const inconclusive: Array<keyof ProbeResult["supports"]> = [];
  const started = Date.now();
  let outputTokens = 0;
  /** Whether any canary got an answer: until then a network failure means "unreachable", not "unsupported". */
  let reached = false;
  /** Judges one canary answer; an empty answer cut at the limit decides nothing. */
  const judge = (
    name: keyof ProbeResult["supports"],
    r: { text: string; toolCalls: readonly unknown[]; finishReason: string; usage: { outputTokens: number } },
    ok: () => boolean,
  ): boolean => {
    outputTokens += r.usage.outputTokens;
    if (r.finishReason === "length" && r.text.trim() === "" && r.toolCalls.length === 0) {
      inconclusive.push(name);
      errors[name] =
        `inconclusive: the answer was cut at ${r.usage.outputTokens} output tokens before any content (a reasoning model?)`;
      return false;
    }
    if (ok()) return true;
    errors[name] = `unexpected answer: ${JSON.stringify(r.text.slice(0, 120))}`;
    return false;
  };

  const attempt = async (name: string, fn: () => Promise<boolean>): Promise<boolean> => {
    try {
      const supported = await fn();
      reached = true;
      return supported;
    } catch (error) {
      if (
        error instanceof ModelError &&
        (error.kind === "auth" ||
          error.kind === "quota_exhausted" ||
          error.kind === "policy" ||
          (error.kind === "transient" && !reached))
      ) {
        throw error;
      }
      // an HTTP status or an unparsable answer still means the endpoint answered
      if (!(error instanceof ModelError) || error.status !== undefined) reached = true;
      errors[name] = error instanceof Error ? error.message : String(error);
      return false;
    }
  };

  const systemRole = await attempt("systemRole", async () => {
    const r = await gateway.call({
      modelId,
      role: "probe",
      maxOutput: PROBE_MAX_OUTPUT,
      temperature: 0,
      messages: [
        { role: "system", content: "You answer with exactly the word PONG and nothing else." },
        { role: "user", content: "Say the word." },
      ],
    });
    return judge("systemRole", r, () => /pong/i.test(r.text));
  });

  const jsonMode = await attempt("jsonMode", async () => {
    const r = await gateway.call({
      modelId,
      role: "probe",
      maxOutput: PROBE_MAX_OUTPUT,
      temperature: 0,
      responseFormat: { kind: "json" },
      messages: [{ role: "user", content: 'Return a JSON object {"ok": true}.' }],
    });
    return judge("jsonMode", r, () => parsesOk(r.text));
  });

  const jsonSchema = await attempt("jsonSchema", async () => {
    const r = await gateway.call({
      modelId,
      role: "probe",
      maxOutput: PROBE_MAX_OUTPUT,
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
    return judge("jsonSchema", r, () => parsesOk(r.text));
  });

  const tools = await attempt("tools", async () => {
    const r = await gateway.call({
      modelId,
      role: "probe",
      maxOutput: PROBE_MAX_OUTPUT,
      temperature: 0,
      tools: [PING_TOOL],
      messages: [{ role: "user", content: 'Call the ping tool with echo "hi".' }],
    });
    return judge("tools", r, () => r.toolCalls.some((c) => c.name === "ping"));
  });

  return {
    modelId,
    probedAt: new Date().toISOString(),
    latencyMs: Date.now() - started,
    supports: { tools, jsonMode, jsonSchema, systemRole },
    errors,
    ...(inconclusive.length > 0 ? { inconclusive } : {}),
    outputTokens,
  };
}

function parsesOk(text: string): boolean {
  try {
    return (JSON.parse(text) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

export function probeDrift(model: ModelConfig, probe: ProbeResult): ProbeDrift[] {
  const keys: Array<keyof ProbeResult["supports"]> = ["tools", "jsonMode", "jsonSchema", "systemRole"];
  const undecided = new Set(probe.inconclusive ?? []);
  return keys
    .filter((k) => !undecided.has(k) && model.supports[k] !== probe.supports[k])
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

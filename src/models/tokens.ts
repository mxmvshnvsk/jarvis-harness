import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, ToolDefinition } from "./types.ts";

/**
 * Token estimation with self-calibration (ADR-0013 §3). No external tokenizers: an initial
 * chars-per-token guess per tokenizer family is corrected from the provider's reported usage
 * with exponential smoothing, and estimates always carry a 5 % safety margin.
 */
const FAMILY_CHARS_PER_TOKEN: Record<string, number> = {
  default: 4,
  deepseek: 3.6,
  qwen: 3.5,
  llama: 3.8,
  gpt: 4,
  cl100k: 4,
  o200k: 4.2,
  claude: 3.8,
};

export const SAFETY_MARGIN = 1.05;
const ALPHA = 0.2;
/** Per-message framing overhead (role tokens, separators). */
const MESSAGE_OVERHEAD = 4;

export interface Calibration {
  readonly charsPerToken: number;
  readonly samples: number;
  readonly updatedAt: string;
}

export interface CalibrationStore {
  get(modelId: string): Calibration | undefined;
  set(modelId: string, calibration: Calibration): void;
}

export class MemoryCalibrationStore implements CalibrationStore {
  private readonly map = new Map<string, Calibration>();
  get(modelId: string): Calibration | undefined {
    return this.map.get(modelId);
  }
  set(modelId: string, calibration: Calibration): void {
    this.map.set(modelId, calibration);
  }
}

/** `~/.jarvis/cache/models/<id>.calib.json` */
export class FileCalibrationStore implements CalibrationStore {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private path(modelId: string): string {
    return join(this.dir, `${encodeURIComponent(modelId)}.calib.json`);
  }
  get(modelId: string): Calibration | undefined {
    const path = this.path(modelId);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Calibration;
    } catch {
      return undefined;
    }
  }
  set(modelId: string, calibration: Calibration): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(modelId), `${JSON.stringify(calibration, null, 2)}\n`);
  }
}

export function charsOfMessages(messages: readonly Message[], tools: readonly ToolDefinition[] = []): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length;
    for (const c of m.toolCalls ?? []) chars += c.name.length + c.arguments.length;
  }
  for (const t of tools) chars += t.name.length + t.description.length + JSON.stringify(t.parameters).length;
  return chars;
}

export class TokenEstimator {
  private readonly store: CalibrationStore;

  constructor(store: CalibrationStore = new MemoryCalibrationStore()) {
    this.store = store;
  }

  charsPerToken(modelId: string, family: string | undefined): number {
    const calibrated = this.store.get(modelId);
    if (calibrated) return calibrated.charsPerToken;
    return FAMILY_CHARS_PER_TOKEN[family ?? "default"] ?? FAMILY_CHARS_PER_TOKEN.default ?? 4;
  }

  estimateText(modelId: string, family: string | undefined, text: string): number {
    return Math.ceil((text.length / this.charsPerToken(modelId, family)) * SAFETY_MARGIN);
  }

  estimateMessages(
    modelId: string,
    family: string | undefined,
    messages: readonly Message[],
    tools: readonly ToolDefinition[] = [],
  ): number {
    const chars = charsOfMessages(messages, tools);
    const base = chars / this.charsPerToken(modelId, family) + messages.length * MESSAGE_OVERHEAD;
    return Math.ceil(base * SAFETY_MARGIN);
  }

  /** Learns from `usage.prompt_tokens` reported by the provider for a prompt of `chars` characters. */
  calibrate(
    modelId: string,
    chars: number,
    actualPromptTokens: number,
    messageCount: number,
  ): Calibration | undefined {
    if (actualPromptTokens <= 0 || chars <= 0) return undefined;
    const effectiveTokens = Math.max(1, actualPromptTokens - messageCount * MESSAGE_OVERHEAD);
    const observed = chars / effectiveTokens;
    const previous = this.store.get(modelId);
    const next: Calibration = previous
      ? {
          charsPerToken: previous.charsPerToken * (1 - ALPHA) + observed * ALPHA,
          samples: previous.samples + 1,
          updatedAt: new Date().toISOString(),
        }
      : { charsPerToken: observed, samples: 1, updatedAt: new Date().toISOString() };
    this.store.set(modelId, next);
    return next;
  }
}

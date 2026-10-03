import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRequest, ProviderResult } from "./types.ts";

/**
 * Record/replay of model calls (ADR-0012 §4). The key covers everything that influences the
 * answer — model, messages, tools, response format, limits — and nothing else, so tests of
 * runtime logic replay deterministically and a prompt change shows up as a miss.
 */
export type CassetteMode = "live" | "record" | "replay";

export interface CassetteEntry {
  readonly key: string;
  readonly modelId: string;
  readonly request: Record<string, unknown>;
  readonly response: ProviderResult;
  readonly recordedAt: string;
  readonly cassetteVersion: 1;
}

export interface CassetteStore {
  get(key: string): CassetteEntry | undefined;
  put(entry: CassetteEntry): void;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

export function cassetteRequest(request: ModelRequest): Record<string, unknown> {
  return canonical({
    modelId: request.modelId,
    messages: request.messages,
    tools: request.tools,
    responseFormat: request.responseFormat,
    maxOutput: request.maxOutput,
    temperature: request.temperature,
  }) as Record<string, unknown>;
}

export function cassetteKey(request: ModelRequest): string {
  return createHash("sha256")
    .update(JSON.stringify(cassetteRequest(request)))
    .digest("hex");
}

export class MemoryCassetteStore implements CassetteStore {
  readonly entries = new Map<string, CassetteEntry>();
  get(key: string): CassetteEntry | undefined {
    return this.entries.get(key);
  }
  put(entry: CassetteEntry): void {
    this.entries.set(entry.key, entry);
  }
}

/** One JSON file per key in a directory (e.g. `tests/cassettes/<suite>/`). */
export class FileCassetteStore implements CassetteStore {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private path(key: string): string {
    return join(this.dir, `${key}.json`);
  }
  get(key: string): CassetteEntry | undefined {
    const path = this.path(key);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as CassetteEntry;
  }
  put(entry: CassetteEntry): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path(entry.key), `${JSON.stringify(entry, null, 2)}\n`);
  }
}

import YAML from "yaml";
import type { z } from "zod";
import type { ConfigLayer, PlainObject } from "./merge.ts";
import { isPlainObject, setPath } from "./merge.ts";
import { ResolvedConfigSchema } from "./schema.ts";

/**
 * Environment overrides (ADR-0014 §1): `JARVIS_<PATH>` with `__` as the path separator, e.g.
 * `JARVIS_MODELS__DEEPSEEK_FLASH__BASEURL`. Segments match configuration keys case-insensitively,
 * ignoring `_` and `-`, against the keys that already exist in the merged configuration and,
 * failing that, against the keys known from the schema.
 */

export const ENV_PREFIX = "JARVIS_";

/** Variables with a meaning of their own, not configuration paths. */
export const RESERVED_ENV = new Set([
  "JARVIS_HOME",
  "JARVIS_PROFILE",
  "JARVIS_ACTOR",
  "JARVIS_CONFIG",
  "JARVIS_KEYCHAIN_BACKEND",
  // technical log (src/telemetry/log.ts)
  "JARVIS_LOG",
  "JARVIS_LOG_DIR",
  "JARVIS_LOG_KEEP_DAYS",
  "JARVIS_LOG_MAX_FIELD",
  // live progress line of foreground commands (src/cli/progress.ts): off disables it
  "JARVIS_PROGRESS",
  // questions at a human gate inside a foreground run (src/cli/prompt.ts): on forces, off disables
  "JARVIS_INTERACTIVE",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

type ZodDef = {
  type?: string;
  shape?: Record<string, unknown>;
  innerType?: unknown;
  options?: unknown[];
  valueType?: unknown;
  element?: unknown;
};

function defOf(schema: unknown): ZodDef | undefined {
  if (schema && typeof schema === "object" && "_zod" in schema) {
    return (schema as { _zod: { def: ZodDef } })._zod.def;
  }
  return undefined;
}

/** Collects every object key that appears anywhere in a schema. */
export function collectSchemaKeys(
  schema: z.ZodType,
  into = new Set<string>(),
  seen = new Set<unknown>(),
): Set<string> {
  if (seen.has(schema)) return into;
  seen.add(schema);
  const def = defOf(schema);
  if (!def) return into;
  if (def.shape) {
    for (const [key, child] of Object.entries(def.shape)) {
      into.add(key);
      collectSchemaKeys(child as z.ZodType, into, seen);
    }
  }
  if (def.innerType) collectSchemaKeys(def.innerType as z.ZodType, into, seen);
  if (def.valueType) collectSchemaKeys(def.valueType as z.ZodType, into, seen);
  if (def.element) collectSchemaKeys(def.element as z.ZodType, into, seen);
  if (def.options) for (const option of def.options) collectSchemaKeys(option as z.ZodType, into, seen);
  return into;
}

let knownKeysCache: Map<string, string> | undefined;

function knownKeys(): Map<string, string> {
  if (!knownKeysCache) {
    knownKeysCache = new Map();
    for (const key of collectSchemaKeys(ResolvedConfigSchema)) {
      if (!knownKeysCache.has(normalizeKey(key))) knownKeysCache.set(normalizeKey(key), key);
    }
  }
  return knownKeysCache;
}

function resolveSegment(segment: string, level: unknown): string {
  const normalized = normalizeKey(segment);
  if (isPlainObject(level)) {
    for (const key of Object.keys(level)) {
      if (normalizeKey(key) === normalized) return key;
    }
  }
  const known = knownKeys().get(normalized);
  if (known) return known;
  // Unknown key: most likely a map entry such as a model id. Keep it lowercase with hyphens,
  // which is the convention for ids in this configuration.
  return segment.toLowerCase().replace(/_/g, "-");
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  try {
    const parsed: unknown = YAML.parse(trimmed);
    // Only accept scalars and arrays; objects from env are too error-prone.
    if (isPlainObject(parsed)) return raw;
    return parsed;
  } catch {
    return raw;
  }
}

export interface EnvOverride {
  readonly variable: string;
  readonly path: readonly string[];
  readonly value: unknown;
}

/** Extracts configuration overrides from the environment, resolving paths against `current`. */
export function envOverrides(env: NodeJS.ProcessEnv, current: unknown): EnvOverride[] {
  const result: EnvOverride[] = [];
  const names = Object.keys(env)
    .filter((name) => name.startsWith(ENV_PREFIX) && !RESERVED_ENV.has(name))
    .sort();
  for (const name of names) {
    const raw = env[name];
    if (raw === undefined) continue;
    const segments = name
      .slice(ENV_PREFIX.length)
      .split("__")
      .filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    const path: string[] = [];
    let level: unknown = current;
    for (const segment of segments) {
      const key = resolveSegment(segment, level);
      path.push(key);
      level = isPlainObject(level) ? level[key] : undefined;
    }
    result.push({ variable: name, path, value: parseScalar(raw) });
  }
  if (env.JARVIS_ACTOR) {
    result.push({ variable: "JARVIS_ACTOR", path: ["actor", "id"], value: env.JARVIS_ACTOR });
  }
  return result;
}

export function envLayers(overrides: readonly EnvOverride[]): ConfigLayer[] {
  return overrides.map((o) => {
    const value: PlainObject = {};
    setPath(value, o.path, o.value);
    return { name: `env:${o.variable}`, value };
  });
}

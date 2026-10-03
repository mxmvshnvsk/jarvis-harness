/**
 * Deep merge of configuration layers with per-leaf source tracking (ADR-0014 §1–2).
 *
 * Objects merge recursively; arrays and scalars replace. Every leaf remembers which layer
 * set it, so `jarvis config show --sources` can explain any value.
 */

export type PlainObject = { [key: string]: unknown };

export interface ConfigLayer {
  /** Human-readable origin, e.g. `user:~/.jarvis/config.yaml` or `env:JARVIS_DATACLASS`. */
  readonly name: string;
  readonly value: unknown;
}

export interface MergeResult {
  readonly value: unknown;
  /** Leaf path → layer name. */
  readonly sources: Record<string, string>;
}

export function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function formatPath(segments: readonly string[]): string {
  return segments
    .map((s, i) => {
      const needsQuotes = /[.\s"[\]]/.test(s) || s === "";
      if (needsQuotes) return `${i === 0 ? "" : ""}["${s.replace(/"/g, '\\"')}"]`;
      return i === 0 ? s : `.${s}`;
    })
    .join("");
}

export function mergeLayers(layers: readonly ConfigLayer[]): MergeResult {
  const sources: Record<string, string> = {};
  let acc: unknown;
  for (const layer of layers) {
    if (layer.value === undefined) continue;
    acc = mergeInto(acc, layer.value, layer.name, [], sources);
  }
  return { value: acc ?? {}, sources };
}

function mergeInto(
  base: unknown,
  patch: unknown,
  source: string,
  path: readonly string[],
  sources: Record<string, string>,
): unknown {
  if (isPlainObject(patch)) {
    const out: PlainObject = isPlainObject(base) ? { ...base } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      out[key] = mergeInto(out[key], value, source, [...path, key], sources);
    }
    return out;
  }
  // Arrays and scalars replace the base value entirely.
  if (isPlainObject(base)) {
    // A scalar replacing an object: forget the sources of the object's leaves.
    const prefix = formatPath(path);
    for (const key of Object.keys(sources)) {
      if (key === prefix || key.startsWith(`${prefix}.`) || key.startsWith(`${prefix}[`)) {
        delete sources[key];
      }
    }
  }
  sources[formatPath(path)] = source;
  return patch;
}

/** Sets a value at a dotted path inside a plain object, creating intermediate objects. */
export function setPath(target: PlainObject, segments: readonly string[], value: unknown): void {
  let cursor: PlainObject = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i] as string;
    const next = cursor[key];
    if (!isPlainObject(next)) {
      const created: PlainObject = {};
      cursor[key] = created;
      cursor = created;
    } else {
      cursor = next;
    }
  }
  cursor[segments[segments.length - 1] as string] = value;
}

/** Flattens an object into leaf paths, in the same format as merge sources. */
export function flattenLeaves(value: unknown, path: readonly string[] = []): Array<[string, unknown]> {
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [[formatPath(path), {}]];
    return entries.flatMap(([k, v]) => flattenLeaves(v, [...path, k]));
  }
  return [[formatPath(path), value]];
}

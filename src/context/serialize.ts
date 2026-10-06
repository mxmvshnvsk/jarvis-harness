import type { Message } from "../models/types.ts";

/**
 * Byte-stable serialisation for the prompt's stable layers (ADR-0013 §4): object keys sorted, so the
 * same value always renders the same text and a prefix cache can reuse it.
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return v;
  });
}

/** How much of `next` repeats `previous` from the start, in characters, and where it first differs. */
export interface PrefixReuse {
  /** Characters of `next` (content of all messages) identical to `previous` from the start. */
  readonly reusedChars: number;
  readonly totalChars: number;
  /** Index of the first message that differs; undefined when `next` only appends. */
  readonly changedMessage?: number;
}

const sameMeta = (a: Message, b: Message) =>
  a.role === b.role &&
  a.toolCallId === b.toolCallId &&
  JSON.stringify(a.toolCalls ?? []) === JSON.stringify(b.toolCalls ?? []);

export function prefixReuse(previous: readonly Message[], next: readonly Message[]): PrefixReuse {
  const totalChars = next.reduce((n, m) => n + m.content.length, 0);
  let reusedChars = 0;
  for (let i = 0; i < next.length; i += 1) {
    const a = previous[i];
    const b = next[i] as Message;
    if (!a) return { reusedChars, totalChars };
    if (a.content === b.content && sameMeta(a, b)) {
      reusedChars += b.content.length;
      continue;
    }
    let k = 0;
    if (a.role === b.role) {
      const max = Math.min(a.content.length, b.content.length);
      while (k < max && a.content.charCodeAt(k) === b.content.charCodeAt(k)) k += 1;
    }
    return { reusedChars: reusedChars + k, totalChars, changedMessage: i };
  }
  return { reusedChars, totalChars };
}

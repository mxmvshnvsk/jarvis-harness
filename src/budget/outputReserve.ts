/**
 * How much output a model call reserves in its quota pool before it is admitted (ADR-0018 §5).
 * Reserving the model's whole `maxOutput` made a pool with a modest output limit useless: pilot —
 * a 30k-per-20-minutes pool and a 16k `maxOutput` let nothing through once 14k were spent, while
 * the agents' answers were about 250 tokens (an agent's turn) to 8k (its result document).
 *
 * The reserve is the typical answer of the same kind of call instead: the 95th percentile of the
 * recent answers of the same agent (or role), its tool turns apart from its final answer, kept
 * between `min` and `maxOutput`. A call that answers longer overshoots the window by at most that
 * one answer — as the run budget already does — and the provider's own limit still applies.
 */
export const RESERVE = {
  /** Never reserve less than this. */
  min: 2000,
  /** Without enough history: this, or `maxOutput` when it is lower. */
  unknown: 8000,
  /** Answers needed before the history decides. */
  samples: 5,
  /** Answers kept per kind of call. */
  keep: 200,
} as const;

export interface ReserveKey {
  readonly agentId?: string | undefined;
  readonly role?: string | undefined;
  /** A turn with tools to call, or the final answer (no tools). */
  readonly tools: boolean;
}

export function reserveKey(k: ReserveKey): string {
  return `${k.agentId ?? k.role ?? "-"}|${k.tools ? "turn" : "final"}`;
}

export class OutputReserve {
  private readonly seen = new Map<string, number[]>();

  constructor(history: Iterable<ReserveKey & { readonly outputTokens: number }> = []) {
    for (const h of history) this.observe(h, h.outputTokens);
  }

  observe(key: ReserveKey, outputTokens: number): void {
    if (!Number.isFinite(outputTokens) || outputTokens < 0) return;
    const k = reserveKey(key);
    const list = this.seen.get(k) ?? [];
    list.push(outputTokens);
    if (list.length > RESERVE.keep) list.splice(0, list.length - RESERVE.keep);
    this.seen.set(k, list);
  }

  /** What a call of this kind reserves, never above its `maxOutput`. */
  reserve(key: ReserveKey, maxOutput: number): number {
    const list = this.seen.get(reserveKey(key)) ?? [];
    if (list.length < RESERVE.samples) return Math.min(maxOutput, RESERVE.unknown);
    const sorted = [...list].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] as number;
    return Math.min(maxOutput, Math.max(RESERVE.min, p95));
  }
}

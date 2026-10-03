import type { ContextConfig } from "./types.ts";

/**
 * Context pressure (ADR-0013 §1–2, ADR-0001 §7): the denominator is the window the call can really
 * use — the smaller of the model window and `context.maxContext`, minus the output reserve and a 5 %
 * safety margin — and the thresholds are a profile resolved `byPhase` over `byModel` over `default`.
 */
export interface Thresholds {
  readonly watch: number;
  readonly compact: number;
  readonly aggressive: number;
  readonly reset: number;
}

/** The starting hypothesis of ADR-0013 §2; configurable per model and phase, measured by evals. */
export const DEFAULT_THRESHOLDS: Thresholds = { watch: 0.4, compact: 0.6, aggressive: 0.75, reset: 0.85 };

export type PressureLevel = "healthy" | "watch" | "compact" | "aggressive" | "reset";

export function resolveThresholds(
  config: ContextConfig | undefined,
  modelId: string,
  phase?: string,
): Thresholds {
  const layers = [
    config?.thresholds.default,
    config?.thresholds.byModel[modelId],
    phase ? config?.thresholds.byPhase[phase] : undefined,
  ];
  const merged: { -readonly [K in keyof Thresholds]: number } = { ...DEFAULT_THRESHOLDS };
  for (const layer of layers) {
    if (!layer) continue;
    for (const key of ["watch", "compact", "aggressive", "reset"] as const) {
      const value = layer[key];
      if (value !== undefined) merged[key] = value;
    }
  }
  // The levels must be ordered; a profile that overrides one value must not invert the ladder.
  merged.compact = Math.max(merged.compact, merged.watch);
  merged.aggressive = Math.max(merged.aggressive, merged.compact);
  merged.reset = Math.max(merged.reset, merged.aggressive);
  return merged;
}

export interface WindowInput {
  readonly contextWindow: number;
  readonly maxOutput: number;
  /** `context.maxContext` — an artificial cap for cheap/fast work. */
  readonly maxContext?: number;
  /** `roles.<role>.maxOutput`, when set. */
  readonly roleMaxOutput?: number;
}

export const SAFETY_SHARE = 0.05;
const MIN_EFFECTIVE = 1024;

export function effectiveWindow(input: WindowInput): number {
  const window = Math.min(input.contextWindow, input.maxContext ?? input.contextWindow);
  const reserve = Math.min(input.maxOutput, input.roleMaxOutput ?? input.maxOutput);
  return Math.max(MIN_EFFECTIVE, Math.floor(window - reserve - window * SAFETY_SHARE));
}

export function pressureOf(promptTokens: number, effective: number): number {
  return effective > 0 ? promptTokens / effective : 0;
}

export function levelOf(pressure: number, t: Thresholds): PressureLevel {
  if (pressure >= t.reset) return "reset";
  if (pressure >= t.aggressive) return "aggressive";
  if (pressure >= t.compact) return "compact";
  if (pressure >= t.watch) return "watch";
  return "healthy";
}

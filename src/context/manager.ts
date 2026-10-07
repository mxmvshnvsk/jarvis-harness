import { ModelError } from "../models/errors.ts";
import type { Message } from "../models/types.ts";
import { levelOf, type PressureLevel, pressureOf, type Thresholds } from "./pressure.ts";
import {
  CHEAP_TO_REDO,
  compactTranscript,
  isSourceResult,
  type Summary,
  toolNamesOf,
  trimmable,
  trimToolResults,
} from "./transcript.ts";

/** At `watch`: keep the 3 newest tool results, and trim only once 4 older ones are untrimmed. */
const WATCH_KEEP = 3;
const WATCH_BATCH = 4;
/**
 * At `watch`, trim only down to this share of the `watch` threshold (0.4 → 0.3), searches and listings
 * first, then the oldest results. Pilot: at 184k of a 459k window every old result went (66, 305k chars)
 * and the agent read 19 of its files again at once.
 */
const WATCH_TARGET = 0.75;

/**
 * Acts on context pressure before every model call (ADR-0013 §6, ADR-0001 §7):
 *   watch      → trim old tool results
 *   compact    → trim, then compact older blocks into a handoff until the prompt is near the target
 *   aggressive → harder trim, smaller tail, and a tighter L3/L4 (stricter retrieval)
 *   reset      → structured handoff and a clean tail (a new agent session)
 * L0–L2 are never touched; the originals of everything removed stay in the blob store.
 */
export interface ContextManagerOptions {
  readonly effective: number;
  readonly thresholds: Thresholds;
  /** Share of the effective window the prompt should shrink to (`context.compactTarget`). */
  readonly compactTarget: number;
  /** Estimated tokens of messages (tool definitions included by the caller). */
  readonly estimate: (messages: readonly Message[]) => number;
  readonly store: (text: string) => string;
  readonly summarize: (rendered: string, previousHandoff?: string) => Promise<Summary>;
  /** A smaller base (L3/L4 rebuilt with a tighter budget); called at most once per step. */
  readonly tighten?: () => Message[];
  readonly emit: (kind: string, payload: Record<string, unknown>) => void;
  readonly maxResets?: number;
  /**
   * Tool results not to trim under light pressure (watch, compact): a file the agent had to read again
   * because its first read was trimmed (src/agents/rereads.ts). Pilot: one file read 62 times in a step.
   */
  readonly pinned?: (toolCallId: string) => boolean;
}

export interface ContextStats {
  peakPressure: number;
  trims: number;
  compactions: number;
  resets: number;
}

export interface ManageResult {
  readonly base: Message[];
  readonly transcript: Message[];
  readonly level: PressureLevel;
  readonly pressure: number;
  readonly changed: boolean;
}

const charsOf = (messages: readonly Message[]): number =>
  messages.reduce(
    (n, m) => n + m.content.length + (m.toolCalls ?? []).reduce((k, c) => k + c.arguments.length, 0),
    0,
  );

/** Errors that must reach the run (quota, auth), not be absorbed by a fallback. */
function mustPropagate(error: unknown): boolean {
  return error instanceof ModelError && (error.kind === "quota_exhausted" || error.kind === "auth");
}

export class ContextManager {
  readonly stats: ContextStats;
  private readonly o: ContextManagerOptions;
  private tightened = false;
  private lastLevel: PressureLevel = "healthy";

  constructor(options: ContextManagerOptions, initial?: Partial<ContextStats>) {
    this.o = options;
    this.stats = { peakPressure: 0, trims: 0, compactions: 0, resets: 0, ...initial };
  }

  measure(base: readonly Message[], transcript: readonly Message[]): { tokens: number; pressure: number } {
    const tokens = this.o.estimate([...base, ...transcript]);
    return { tokens, pressure: pressureOf(tokens, this.o.effective) };
  }

  /** Brings the prompt below the level it is at; never loops (one pass per call). */
  async manage(baseIn: Message[], transcriptIn: Message[]): Promise<ManageResult> {
    let base = baseIn;
    let transcript = transcriptIn;
    let { tokens, pressure } = this.measure(base, transcript);
    this.stats.peakPressure = Math.max(this.stats.peakPressure, pressure);
    const level = levelOf(pressure, this.o.thresholds);
    const previousLevel = this.lastLevel;
    this.lastLevel = level;
    if (level === "healthy") return { base, transcript, level, pressure, changed: false };
    if (level !== previousLevel)
      this.o.emit("context.pressure", {
        level,
        tokens,
        effective: this.o.effective,
        pressure: Number(pressure.toFixed(3)),
      });

    const before = tokens;
    const remeasure = () => {
      ({ tokens, pressure } = this.measure(base, transcript));
    };
    /** `light`: the task's own sources (issue, pages, frames) and files read again stay. */
    const keepLight = (content: string, m: Message) =>
      isSourceResult(content) || (m.toolCallId !== undefined && this.o.pinned?.(m.toolCallId) === true);
    const trim = (keepRecent: number, minChars?: number, light = false, saveChars?: number) => {
      const names = saveChars === undefined ? undefined : toolNamesOf(transcript);
      const r = trimToolResults(transcript, {
        keepRecent,
        ...(minChars ? { minChars } : {}),
        ...(light ? { keep: keepLight } : {}),
        ...(names && saveChars !== undefined
          ? {
              saveChars,
              first: (m: Message) => CHEAP_TO_REDO.test(names.get(m.toolCallId ?? "") ?? ""),
            }
          : {}),
        store: this.o.store,
      });
      if (r.trimmed > 0) {
        transcript = r.transcript;
        this.stats.trims += 1;
        this.o.emit("context.trimmed", {
          messages: r.trimmed,
          savedChars: r.savedChars,
          // the page names a re-read original by the call it answered, not by its hash
          originals: r.originals.slice(0, 60),
        });
        remeasure();
      }
    };
    const compact = async (kind: "compact" | "reset", keepBlocks: number, targetShare: number) => {
      const baseTokens = this.o.estimate(base);
      const tailBudget = Math.max(
        Math.floor(targetShare * this.o.effective - baseTokens),
        Math.floor(0.1 * this.o.effective),
      );
      try {
        const r = await compactTranscript(transcript, {
          keepBlocks,
          ...(keepBlocks > 0 ? { tailBudgetTokens: tailBudget } : {}),
          estimate: this.o.estimate,
          store: this.o.store,
          summarize: this.o.summarize,
          kind,
          // the summary is a model call of its own (pilot: 49 s that looked like the agent thinking)
          onSummarize: (blocks) => this.o.emit("context.compacting", { kind, tokens: before, blocks }),
        });
        if (!r) return;
        transcript = r.transcript;
        if (kind === "reset") this.stats.resets += 1;
        else this.stats.compactions += 1;
        remeasure();
        this.o.emit(kind === "reset" ? "context.reset" : "context.compacted", {
          before,
          after: tokens,
          blocks: r.compactedBlocks,
          originals: r.originals,
          ...(r.fallback ? { fallback: r.fallback } : {}),
        });
      } catch (error) {
        if (mustPropagate(error)) throw error;
        // A summary that cannot be produced must not stall the agent: fall back to hard trimming.
        this.o.emit("context.compaction_failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
        trim(1, 200);
      }
    };
    const tighten = () => {
      if (this.tightened || !this.o.tighten) return;
      this.tightened = true;
      base = this.o.tighten();
      remeasure();
      this.o.emit("context.tightened", { tokens });
    };

    const t = this.o.thresholds;
    if (level === "watch") {
      // in batches: trimming one more result on every call would change the prompt's prefix on
      // every call and a prefix cache would never reuse past it (ADR-0013 §4)
      if (trimmable(transcript, WATCH_KEEP, 600, keepLight) >= WATCH_BATCH) {
        // tokens to shed, in characters at this prompt's own ratio
        const target = t.watch * WATCH_TARGET * this.o.effective;
        const chars = charsOf(base) + charsOf(transcript);
        const saveChars = Math.ceil(((tokens - target) * chars) / Math.max(1, tokens));
        trim(WATCH_KEEP, undefined, true, saveChars);
      }
    } else if (level === "compact") {
      trim(4, undefined, true);
      if (pressure >= t.compact) await compact("compact", 3, this.o.compactTarget);
    } else if (level === "aggressive") {
      trim(2, 300);
      tighten();
      if (pressure >= t.aggressive) await compact("compact", 2, this.o.compactTarget * 0.7);
    } else {
      tighten();
      if (this.stats.resets < (this.o.maxResets ?? 2)) await compact("reset", 0, this.o.compactTarget);
      else trim(1, 200);
      if (pressure >= t.reset)
        this.o.emit("context.overflow", {
          tokens,
          effective: this.o.effective,
          note: "the prompt stays above the reset threshold; the task, knowledge or tool list alone are too large",
        });
    }
    return { base, transcript, level, pressure, changed: transcript !== transcriptIn || base !== baseIn };
  }
}

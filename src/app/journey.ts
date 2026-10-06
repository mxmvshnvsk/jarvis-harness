import type { StoredEvent } from "../telemetry/events.ts";

/**
 * The course of a run as lines that stay in the terminal: one report per finished step and one
 * per loop back, derived from the event journal (ADR-0018 §2, same source as the live line).
 * Pilot: the live line showed only the current step, so after a 20-minute `spec` nobody could say
 * which step took the time or produced what, without `jarvis status`.
 */
export interface StepReport {
  readonly stepId: string;
  readonly iteration: number;
  /** Position in the workflow's step list (1-based) and its length, when the plan is known. */
  readonly index?: number;
  readonly total?: number;
  readonly kind?: string;
  /** success | failure | error (an exception) */
  readonly status: string;
  readonly outcome?: string;
  readonly reason?: string;
  readonly durationMs: number;
  readonly agent?: string;
  readonly modelCalls: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly retries: number;
  readonly toolCalls: number;
  readonly maxToolCalls?: number;
  /** The agent stopped on a limit, not because it was done: its document may be incomplete. */
  readonly budgetExhausted?: string;
}

export interface LoopReport {
  /** `from->to#outcome` */
  readonly edge: string;
  readonly from: string;
  readonly to: string;
  readonly outcome: string;
  readonly iteration: number;
  readonly max?: number;
  readonly reasons?: string;
}

export type JourneyLine =
  | { readonly kind: "step"; readonly report: StepReport }
  | { readonly kind: "loop"; readonly report: LoopReport };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

interface Open {
  stepId: string;
  iteration: number;
  kind?: string;
  startedAt: string;
  agent?: string;
  modelCalls: number;
  promptTokens: number;
  outputTokens: number;
  retries: number;
  toolCalls: number;
  maxToolCalls?: number;
  budgetExhausted?: string;
}

/** Feeds events in journal order; returns the lines each event completes. */
export class Journey {
  private open: Open | undefined;
  private readonly plan: readonly string[];

  constructor(plan: readonly string[] = []) {
    this.plan = plan;
  }

  push(e: StoredEvent): JourneyLine[] {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    switch (e.kind) {
      case "step.start": {
        const kind = str(p.kind);
        this.open = {
          stepId: str(p.stepId) ?? e.stepId ?? "?",
          iteration: num(p.iteration) || (e.iteration ?? 1),
          startedAt: e.ts,
          modelCalls: 0,
          promptTokens: 0,
          outputTokens: 0,
          retries: 0,
          toolCalls: 0,
          ...(kind ? { kind } : {}),
        };
        return [];
      }
      case "agent.start": {
        const agent = str(p.agent);
        if (this.open && agent) this.open.agent = agent;
        // a resumed step goes on from its checkpoint: count the tool calls made before (pilot: "5/20 tools ·
        // tool limit reached" after a Ctrl-C at 15)
        if (this.open) this.open.toolCalls = Math.max(this.open.toolCalls, num(p.restoredToolCalls));
        if (this.open && num(p.maxToolCalls) > 0) this.open.maxToolCalls = num(p.maxToolCalls);
        return [];
      }
      case "agent.finish": {
        const exhausted = str(p.budgetExhausted);
        if (this.open && exhausted) this.open.budgetExhausted = exhausted;
        return [];
      }
      case "model.call":
        if (this.open) {
          this.open.modelCalls += 1;
          this.open.promptTokens += num(p.promptTokens);
          this.open.outputTokens += num(p.outputTokens);
          this.open.retries += num(p.retries);
        }
        return [];
      case "tool.call":
        if (this.open) this.open.toolCalls += 1;
        return [];
      case "step.finish":
        return this.close(e, str(p.status) ?? "success", str(p.outcome), str(p.reason));
      case "step.error":
        return this.close(e, "error", undefined, str(p.message) ?? str(p.error));
      case "workflow.loop": {
        const reasons = str(p.reasons);
        const edge = str(p.edge) ?? "?";
        const m = /^(.+)->(.+)#(.+)$/.exec(edge);
        return [
          {
            kind: "loop",
            report: {
              edge,
              from: m?.[1] ?? edge,
              to: m?.[2] ?? "?",
              outcome: m?.[3] ?? "?",
              iteration: num(p.iteration),
              ...(num(p.max) > 0 ? { max: num(p.max) } : {}),
              ...(reasons ? { reasons } : {}),
            },
          },
        ];
      }
      default:
        return [];
    }
  }

  private close(e: StoredEvent, status: string, outcome?: string, reason?: string): JourneyLine[] {
    const o = this.open;
    if (!o) return [];
    this.open = undefined;
    const at = this.plan.indexOf(o.stepId);
    const report: StepReport = {
      stepId: o.stepId,
      iteration: o.iteration,
      ...(at >= 0 ? { index: at + 1, total: this.plan.length } : {}),
      ...(o.kind ? { kind: o.kind } : {}),
      status,
      ...(outcome ? { outcome } : {}),
      ...(reason ? { reason } : {}),
      durationMs: Math.max(0, Date.parse(e.ts) - Date.parse(o.startedAt)),
      ...(o.agent ? { agent: o.agent } : {}),
      modelCalls: o.modelCalls,
      promptTokens: o.promptTokens,
      outputTokens: o.outputTokens,
      retries: o.retries,
      toolCalls: o.toolCalls,
      ...(o.maxToolCalls ? { maxToolCalls: o.maxToolCalls } : {}),
      ...(o.budgetExhausted ? { budgetExhausted: o.budgetExhausted } : {}),
    };
    return [{ kind: "step", report }];
  }
}

/** `0.4s`, `42s`, `3m 12s`, `1h 04m`. */
export function duration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

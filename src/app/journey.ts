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
  /** A `quick:` tool answered for the agent (no model call), or why it could not. */
  readonly quick?: { readonly tool: string; readonly used: boolean; readonly reason?: string };
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
  quick?: { tool: string; used: boolean; reason?: string };
  maxToolCalls?: number;
  budgetExhausted?: string;
}

/** Feeds events in journal order; returns the lines each event completes. */
export class Journey {
  /** Steps in flight by id: the children of a composite step run side by side (verify). */
  private readonly open = new Map<string, Open>();
  private last: string | undefined;
  private readonly plan: readonly string[];

  constructor(plan: readonly string[] = []) {
    this.plan = plan;
  }

  /** The step an event belongs to: by its stepId, else the one step in flight, else the latest. */
  private at(e: StoredEvent, p: Record<string, unknown>): Open | undefined {
    // the payload names the step exactly (step.finish of a composite child); the event field may be the parent
    const id = str(p.stepId) ?? e.stepId;
    if (id && this.open.has(id)) return this.open.get(id);
    if (this.open.size === 1) return [...this.open.values()][0];
    return this.last ? this.open.get(this.last) : undefined;
  }

  push(e: StoredEvent): JourneyLine[] {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const o = e.kind === "step.start" ? undefined : this.at(e, p);
    switch (e.kind) {
      case "step.start": {
        const kind = str(p.kind);
        const stepId = str(p.stepId) ?? e.stepId ?? "?";
        this.last = stepId;
        this.open.set(stepId, {
          stepId,
          iteration: num(p.iteration) || (e.iteration ?? 1),
          startedAt: e.ts,
          modelCalls: 0,
          promptTokens: 0,
          outputTokens: 0,
          retries: 0,
          toolCalls: 0,
          ...(kind ? { kind } : {}),
        });
        return [];
      }
      case "agent.start": {
        const agent = str(p.agent);
        if (o && agent) o.agent = agent;
        // a resumed step goes on from its checkpoint: count the tool calls made before (pilot: "5/20 tools ·
        // tool limit reached" after a Ctrl-C at 15)
        if (o) o.toolCalls = Math.max(o.toolCalls, num(p.restoredToolCalls));
        if (o && num(p.maxToolCalls) > 0) o.maxToolCalls = num(p.maxToolCalls);
        return [];
      }
      case "step.quick": {
        const tool = str(p.tool);
        const reason = str(p.reason);
        if (o && tool) o.quick = { tool, used: p.used === true, ...(reason ? { reason } : {}) };
        return [];
      }
      case "agent.finish": {
        const exhausted = str(p.budgetExhausted);
        if (o && exhausted) o.budgetExhausted = exhausted;
        return [];
      }
      case "model.call":
        if (o) {
          o.modelCalls += 1;
          o.promptTokens += num(p.promptTokens);
          o.outputTokens += num(p.outputTokens);
          o.retries += num(p.retries);
        }
        return [];
      case "tool.call":
        if (o) o.toolCalls += 1;
        return [];
      case "step.finish":
        return this.close(o, e, str(p.status) ?? "success", str(p.outcome), str(p.reason));
      case "step.error":
        return this.close(o, e, "error", undefined, str(p.message) ?? str(p.error));
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

  private close(
    o: Open | undefined,
    e: StoredEvent,
    status: string,
    outcome?: string,
    reason?: string,
  ): JourneyLine[] {
    if (!o) return [];
    this.open.delete(o.stepId);
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
      ...(o.quick ? { quick: o.quick } : {}),
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

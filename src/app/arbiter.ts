import { z } from "zod";
import type { Run } from "../core/domain/run.ts";
import { resolveModel } from "../models/router.ts";
import { generateStructured } from "../models/structured.ts";
import { AUTONOMOUS_ACTOR } from "./autonomy.ts";
import { type BudgetStop, unitOf } from "./budgetStop.ts";
import type { Runtime } from "./runtime.ts";
import { type StallSignals, stallSignalsOf } from "./stall.ts";

/**
 * The judge of a budget stop in an autonomous run: nobody grants more, so it decides whether the agent
 * gets more — a task bigger than the limit — or not — the model going round. The journal answers the
 * clear cases (src/app/stall.ts): a loop is a no, steady new work a yes; the judge model weighs the
 * rest, in one structured call. Hard bounds it cannot pass: what it grants in a run stays within
 * `human.arbiter.ceiling` times the cap, at most `maxGrantsPerStep` grants a step, half the cap a grant.
 */
export const ARBITER_ACTOR = { ...AUTONOMOUS_ACTOR, id: "arbiter", display: "the budget judge" } as const;

export type Diagnosis = "needs-more" | "loop" | "stuck" | "unclear";

export interface ArbiterDecision {
  readonly grant: boolean;
  /** In the stop's unit. */
  readonly amount?: number;
  readonly diagnosis: Diagnosis;
  /** For people, one or two sentences. */
  readonly why: string;
  /** What decided: the journal's signals, the judge model, or a bound. */
  readonly by: "signals" | "model" | "ceiling";
  readonly signals: StallSignals;
}

/** Analysis agents: denied more, the run ends (a gap in the analysis must not reach the code). */
export const ANALYSIS_AGENTS: ReadonlySet<string> = new Set([
  "research",
  "requirements",
  "specification",
  "impact",
  "plan",
  "split",
]);

/** The role the judge runs on, and whether it is a model of its own (not the worker's). */
export function arbiterRole(runtime: Runtime): { readonly role: string; readonly own: boolean } {
  const roles = runtime.loaded.config.roles;
  if (roles.arbiter) return { role: "arbiter", own: true };
  for (const role of ["review", "research", "implementation"]) if (roles[role]) return { role, own: false };
  return { role: "research", own: false };
}

/** The judge's grants so far: on the run (perRun) or on this step and round. */
function grantedBefore(runtime: Runtime, run: Run, stop: BudgetStop): { amount: number; times: number } {
  let amount = 0;
  let times = 0;
  for (const e of runtime.events.list({ runId: run.id, kind: "budget.grant", limit: 100_000 })) {
    if (e.actor !== `${ARBITER_ACTOR.kind}:${ARBITER_ACTOR.id}`) continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (p.scope !== stop.scope || p.dimension !== stop.dimension || p.finish === true) continue;
    const sameStep = e.stepId === stop.stepId && (e.iteration ?? 1) === stop.iteration;
    if (stop.scope !== "perRun" && stop.scope !== "master" && !sameStep) continue;
    const n = Number(p[stop.dimension]);
    if (Number.isFinite(n) && n > 0) amount += n;
    if (sameStep) times += 1;
  }
  return { amount, times };
}

/** The cap before any grant: what the stop shows less what was granted on top of it. */
const baseCap = (stop: BudgetStop, granted: number) => Math.max(1, stop.cap - granted);

const Verdict = z.object({
  grant: z.boolean().describe("true: more calls; false: stop"),
  diagnosis: z.enum(["needs-more", "loop", "stuck", "unclear"]),
  why: z.string().min(1).describe("one or two sentences for a person: what the work shows"),
});

/** Decides a budget stop of an autonomous run. Never throws: a judge that fails says no. */
export async function arbitrate(runtime: Runtime, run: Run, stop: BudgetStop): Promise<ArbiterDecision> {
  const cfg = runtime.loaded.config.human.arbiter;
  const signals = stallSignalsOf(runtime, run.id, stop.stepId, stop.iteration);
  const before = grantedBefore(runtime, run, stop);
  const base = baseCap(stop, before.amount);
  const room = Math.floor(base * (cfg.ceiling - 1)) - before.amount;
  const chunk = Math.max(1, Math.min(room, Math.round(base / 2)));
  const unit = unitOf(stop.dimension);
  if (room <= 0 || before.times >= cfg.maxGrantsPerStep)
    return {
      grant: false,
      diagnosis: signals.verdict === "loop" ? "loop" : "unclear",
      why:
        room <= 0
          ? `the run already had ${before.amount} more ${unit} — ${cfg.ceiling}× its budget is the ceiling (human.arbiter.ceiling)`
          : `the step already had ${before.times} grants (human.arbiter.maxGrantsPerStep)`,
      by: "ceiling",
      signals,
    };
  if (signals.verdict === "loop")
    return { grant: false, diagnosis: "loop", why: signals.summary, by: "signals", signals };
  if (signals.verdict === "progress" && before.times === 0)
    return {
      grant: true,
      amount: chunk,
      diagnosis: "needs-more",
      why: signals.summary,
      by: "signals",
      signals,
    };
  try {
    const { role } = arbiterRole(runtime);
    const route = resolveModel(
      runtime.loaded.config,
      role,
      { structuredOutput: "json" },
      { probes: runtime.probes },
    );
    const result = await generateStructured(runtime.gateway, {
      modelId: route.modelId,
      mode: route.structuredMode,
      name: "budget-verdict",
      schema: Verdict,
      messages: [
        {
          role: "system",
          content: [
            "# Jarvis: the judge of a budget stop",
            "An agent of an autonomous run used up a limit of its step. Nobody else can decide: say whether it gets more.",
            "- grant when the work is moving: each call finds or changes something new, and the task is simply bigger than the limit;",
            "- do not grant when it goes round: the same searches and reads again, errors repeated, nothing new for many calls;",
            "- do not grant when it is stuck: it cannot find what it needs, and more of the same will not change that.",
            `More is ${chunk} ${unit}; this is grant ${before.times + 1} of at most ${cfg.maxGrantsPerStep} for the step.`,
            'Answer in the language of the task. Quote with «» and never with ".',
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `# Task\n${run.task.split("\n")[0]}`,
            `# Stop\n${stop.agent ?? stop.stepId}, step ${stop.stepId} round ${stop.iteration}: ${stop.used} of ${stop.cap} ${unit} (${stop.scope}).`,
            stop.gaps && stop.gaps.length > 0
              ? `# Not the limit: its document leaves these uncovered — more calls are to cover them\n${stop.gaps.map((g) => `- ${g}`).join("\n")}`
              : "",
            `# The journal\n${signals.summary}. ${signals.calls} calls in the step, ${signals.repeats} repeats, ${signals.rereads} re-reads, ${signals.errors} failed.`,
            signals.top.length > 0
              ? `# Made most often\n${signals.top.map((t) => `- ${t.call} ×${t.times}`).join("\n")}`
              : "",
            `# The last calls, newest last\n${signals.recent.map((c) => `- ${c.capability} ${c.args}${c.ok ? "" : " — failed"}${c.repeat ? " — again" : ""}`).join("\n")}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
        { role: "user", content: "Answer with the JSON document now." },
      ],
      request: { role, agentId: "arbiter", temperature: 0, runId: run.id, reasoningEffort: "low" },
    });
    const v = result.value;
    return v.grant
      ? { grant: true, amount: chunk, diagnosis: v.diagnosis, why: v.why, by: "model", signals }
      : { grant: false, diagnosis: v.diagnosis, why: v.why, by: "model", signals };
  } catch (error) {
    return {
      grant: false,
      diagnosis: "unclear",
      why: `the judge could not answer (${error instanceof Error ? error.message.slice(0, 160) : String(error)}) — no more without it`,
      by: "model",
      signals,
    };
  }
}

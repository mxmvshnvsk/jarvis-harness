import { z } from "zod";
import { TaskKindSchema } from "./run.ts";

/**
 * Workflow definition (ADR-0004 §1): a directed graph of steps with declared transitions.
 * Agents fill `outcome` in their artifacts; the runtime applies transitions deterministically.
 */
export const StepKindSchema = z.enum(["deterministic", "agentic", "approval", "composite"]);
export type StepKind = z.infer<typeof StepKindSchema>;

export const STEP_DONE = "DONE" as const;
export const STEP_FAIL = "FAIL" as const;

const TargetSchema = z.string().min(1);

export const OutcomeTransitionSchema = z.strictObject({
  to: TargetSchema,
  maxIterations: z.int().positive().default(2),
});
export type OutcomeTransition = z.infer<typeof OutcomeTransitionSchema>;

export const StepTransitionsSchema = z.strictObject({
  onSuccess: TargetSchema.default(STEP_DONE),
  onFailure: TargetSchema.default(STEP_FAIL),
  onOutcome: z.record(z.string(), OutcomeTransitionSchema).default({}),
});

export const StepDefinitionSchema = z.strictObject({
  id: z.string().min(1),
  kind: StepKindSchema,
  agent: z.string().min(1).optional(),
  tool: z.string().min(1).optional(),
  /** For approval steps: the artifact type that must be approved (ADR-0005 §4). */
  artifactType: z.string().min(1).optional(),
  /** Static arguments for deterministic tools. */
  args: z.record(z.string(), z.unknown()).default({}),
  phase: z.string().min(1).optional(),
  inputs: z.array(z.string().min(1)).default([]),
  outputs: z.array(z.string().min(1)).default([]),
  transitions: StepTransitionsSchema.prefault({}),
  /**
   * Agentic steps: the skills its agent gets, by id, in full and in this order — no picking by kind,
   * stack or paths and no `maxSkills` cut (ADR-0020 §3). For weak models, what a step must follow is
   * not left to ranking or to a request the model might not make. Absent: the skills are picked.
   */
  skills: z.array(z.string().min(1)).optional(),
  /** Only for composite steps: independent children run in parallel with a shared budget. */
  children: z.array(z.string().min(1)).default([]),
  /**
   * Run only when it has something to do: `affects: docs` — the run's impact analysis names an
   * affected item of that kind (no impact analysis: the step runs). Pilot: docs and telemetry agents
   * ran on a one-line UI fix and found nothing.
   */
  when: z.strictObject({ affects: z.enum(["code", "test", "docs", "telemetry", "config"]) }).optional(),
  /**
   * Agentic steps: a deterministic tool tried first (`impact.quick`). When it produces the result,
   * the agent is not asked; when it answers `needs_agent`, the agent does the step as usual.
   */
  quick: z.string().min(1).optional(),
  /**
   * Agentic steps, when the agent uses up its tool or model calls: `finish` (default) — the result
   * from what it has, marked incomplete for the steps after it; `ask` — the run waits for a person:
   * more calls and on, or finish. For steps whose half-done result costs more than a question.
   */
  onLimit: z.enum(["finish", "ask"]).optional(),
  /**
   * Agentic steps: the agent's tool and model calls in this step, over its own (a project's
   * `agents.<id>.limits` still wins). The same agent has more to read in one workflow than in another:
   * a task across services' spec reads several services' documents.
   */
  limits: z
    .strictObject({
      maxToolCalls: z.int().positive().optional(),
      maxModelCalls: z.int().positive().optional(),
    })
    .optional(),
});
export type StepDefinition = z.infer<typeof StepDefinitionSchema>;

export const WorkflowDefinitionSchema = z
  .strictObject({
    name: z.string().min(1),
    version: z.int().positive().default(1),
    description: z.string().optional(),
    entry: z.string().min(1),
    /** The kind of task this workflow does when the run does not say (`fix` → fix; run.ts TASK_KINDS). */
    kind: TaskKindSchema.optional(),
    /** The longer workflow a finished run of this one may go on as (`spec` → `sdd`, src/app/handoff.ts). */
    next: z.string().min(1).optional(),
    /** A run of this workflow delivers itself when done (ADR-0003 §4): `pr` — a push and a pull request. */
    deliver: z.enum(["pr"]).optional(),
    steps: z.array(StepDefinitionSchema).min(1),
  })
  .superRefine((workflow, ctx) => {
    const ids = new Set<string>();
    workflow.steps.forEach((step, i) => {
      if (ids.has(step.id)) {
        ctx.addIssue({ code: "custom", path: ["steps", i, "id"], message: `duplicate step id "${step.id}"` });
      }
      ids.add(step.id);
    });
    const known = (target: string) => target === STEP_DONE || target === STEP_FAIL || ids.has(target);
    if (!ids.has(workflow.entry)) {
      ctx.addIssue({ code: "custom", path: ["entry"], message: `unknown entry step "${workflow.entry}"` });
    }
    workflow.steps.forEach((step, i) => {
      if (step.kind === "agentic" && !step.agent) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "agent"],
          message: "agentic step requires an agent",
        });
      }
      if (!known(step.transitions.onSuccess)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "transitions", "onSuccess"],
          message: `unknown target "${step.transitions.onSuccess}"`,
        });
      }
      if (!known(step.transitions.onFailure)) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "transitions", "onFailure"],
          message: `unknown target "${step.transitions.onFailure}"`,
        });
      }
      for (const [outcome, t] of Object.entries(step.transitions.onOutcome)) {
        if (!known(t.to)) {
          ctx.addIssue({
            code: "custom",
            path: ["steps", i, "transitions", "onOutcome", outcome, "to"],
            message: `unknown target "${t.to}"`,
          });
        }
      }
      for (const child of step.children) {
        if (!ids.has(child)) {
          ctx.addIssue({
            code: "custom",
            path: ["steps", i, "children"],
            message: `unknown child step "${child}"`,
          });
        }
      }
    });
  });
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export function edgeId(from: string, to: string, outcome: string): string {
  return `${from}->${to}#${outcome}`;
}

export interface Transition {
  readonly to: string;
  readonly edgeId?: string;
  readonly maxIterations?: number;
}

export interface StepResult {
  readonly status: "success" | "failure";
  readonly outcome?: string;
}

/**
 * Pure transition selection (ADR-0004 §1, §3). Returns the target and, for outcome edges,
 * the edge id and its iteration cap so the runtime can enforce counters.
 */
export function selectTransition(step: StepDefinition, result: StepResult): Transition {
  if (result.status === "failure") return { to: step.transitions.onFailure };
  if (result.outcome !== undefined && result.outcome !== "ok") {
    const edge = step.transitions.onOutcome[result.outcome];
    if (!edge) {
      throw new Error(`step "${step.id}" produced undeclared outcome "${result.outcome}"`);
    }
    return {
      to: edge.to,
      edgeId: edgeId(step.id, edge.to, result.outcome),
      maxIterations: edge.maxIterations,
    };
  }
  return { to: step.transitions.onSuccess };
}

export function findStep(workflow: WorkflowDefinition, id: string): StepDefinition {
  const step = workflow.steps.find((s) => s.id === id);
  if (!step) throw new Error(`unknown step "${id}" in workflow "${workflow.name}"`);
  return step;
}

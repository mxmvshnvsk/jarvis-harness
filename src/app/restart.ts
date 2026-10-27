import { BUILTIN_AGENTS } from "../agents/builtin/index.ts";
import type { Run } from "../core/domain/run.ts";
import type { StepDefinition, WorkflowDefinition } from "../core/domain/workflow.ts";
import type { Runtime } from "./runtime.ts";

/**
 * A stopped run started again from one of its steps (`jarvis restart`): a new run of the same workflow
 * and task, in a fresh checkout, with the artifacts and approvals of the steps before that step.
 * Pilot: an sdd cancelled at the implementation left its approved spec and impact behind, and the
 * only way on was a new run from the research.
 *
 * Only the course up to the first step that writes code can be taken on: what the run wrote stays in
 * its checkout, the new one starts from the current HEAD.
 */
export interface RestartStep {
  readonly id: string;
  readonly kind: StepDefinition["kind"];
  /** Its last round ended well: its result can be taken on. */
  readonly done: boolean;
  /** An approval step passed, or the step's result approved by a person. */
  readonly approved: boolean;
  /** The new run may start here: every step before it is done, and none of them wrote code. */
  readonly startable: boolean;
}

export interface RestartPlan {
  readonly workflow: string;
  /** The main course of the workflow, in order, as this run went through it. */
  readonly steps: readonly RestartStep[];
  /** Where it starts unless told: right after the last approval, else where the run stopped. */
  readonly startAt: string;
}

/** States a run may be started again from: it does not run any more. */
export const RESTARTABLE = new Set<Run["state"]>(["CANCELLED", "FAILED", "COMPLETED"]);

/** The main course: from the entry along `onSuccess` (back edges and parallel children aside). */
export function mainCourse(workflow: WorkflowDefinition): StepDefinition[] {
  const byId = new Map(workflow.steps.map((s) => [s.id, s]));
  const out: StepDefinition[] = [];
  const seen = new Set<string>();
  let at: string | undefined = workflow.entry;
  while (at && byId.has(at) && !seen.has(at)) {
    seen.add(at);
    const step = byId.get(at) as StepDefinition;
    out.push(step);
    at = step.transitions.onSuccess;
  }
  return out;
}

const writers = new Set(
  BUILTIN_AGENTS.filter((a) =>
    a.capabilities.some((c) => c === "repo.write" || c === "repo.edit" || c === "repo.delete"),
  ).map((a) => a.id),
);

/** Whether a step changes the code of its checkout: an agent that writes, or a composite holding one. */
export function writesCode(step: StepDefinition, workflow: WorkflowDefinition): boolean {
  if (step.kind === "agentic") return step.agent !== undefined && writers.has(step.agent);
  if (step.kind === "composite")
    return step.children.some((id) => {
      const child = workflow.steps.find((s) => s.id === id);
      return child ? writesCode(child, workflow) : false;
    });
  return false;
}

/** What of `run` can be taken on, and where a new run starts by default; undefined when nothing can. */
export function restartPlanOf(
  runtime: Runtime,
  run: Run,
  workflow: WorkflowDefinition,
): RestartPlan | undefined {
  const history = runtime.history.list(run.id);
  const latest = runtime.artifacts.listLatest(run.id);
  const course = mainCourse(workflow);
  // a run started again from a step (or gone on from another): what it took on is done, though it never
  // ran those steps itself (pilot: a restart from spec offered nothing to start again from)
  const created = runtime.events.list({ runId: run.id, kind: "run.created", limit: 1 })[0];
  const tookOnUpTo = (created?.payload as { startAt?: unknown } | undefined)?.startAt;
  const carriedUntil = typeof tookOnUpTo === "string" ? course.findIndex((s) => s.id === tookOnUpTo) : -1;
  const steps: RestartStep[] = [];
  let open = true;
  for (const [i, step] of course.entries()) {
    const last = history.filter((h) => h.stepId === step.id).at(-1);
    // a round that went back (`needs_research`, `request_changes`) is no result to go on from
    const back = last?.outcome !== undefined && last.outcome in step.transitions.onOutcome;
    const done = (last?.status === "success" && !back) || (last === undefined && i < carriedUntil);
    const approved =
      done &&
      (step.kind === "approval" ||
        latest.some(
          (a) =>
            a.stepId === step.id &&
            runtime.artifacts.approvalsFor(a.artifactId, a.version)[0]?.decision === "approve",
        ));
    steps.push({ id: step.id, kind: step.kind, done, approved, startable: open });
    // past a step that wrote code, or one not done, nothing more can be taken on
    if (!done || writesCode(step, workflow)) open = false;
  }
  const startable = steps.filter((s) => s.startable);
  if (startable.length <= 1) return undefined;
  const lastApproved = steps.reduce((at, s, i) => (s.approved && s.startable ? i : at), -1);
  const after = lastApproved >= 0 ? steps[lastApproved + 1] : undefined;
  const firstOpen = steps.find((s) => s.startable && !s.done) ?? startable.at(-1);
  const startAt = after?.startable ? after.id : (firstOpen?.id ?? startable.at(-1)?.id);
  if (!startAt || startAt === course[0]?.id) return undefined;
  return { workflow: workflow.name, steps, startAt };
}

/** The steps whose artifacts go with a new run starting at `startAt`. */
export function carriedSteps(plan: RestartPlan, startAt: string): Set<string> {
  const at = plan.steps.findIndex((s) => s.id === startAt);
  return new Set(plan.steps.slice(0, Math.max(at, 0)).map((s) => s.id));
}

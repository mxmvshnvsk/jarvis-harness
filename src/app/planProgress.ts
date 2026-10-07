import type { Run } from "../core/domain/run.ts";
import type { StoredEvent } from "../telemetry/events.ts";
import type { Runtime } from "./runtime.ts";

/**
 * Where an implementation is in its plan, for the page: the plan's steps with what is done, the one
 * worked on now and how many of its files are touched. Two signals, the second when the first is
 * missing: the agent's own marks (`plan.step` start/done) and the files it wrote, matched to the files
 * each plan step names.
 */
export interface PlanStepView {
  readonly id: string;
  readonly description: string;
  readonly files: readonly string[];
  readonly verification: string;
  readonly status: "done" | "on" | "todo";
  /** How many of the step's files are written so far. */
  readonly touched: number;
}

export interface PlanProgress {
  readonly steps: readonly PlanStepView[];
  /** Index of the step worked on now, if any is left. */
  readonly current?: number;
  readonly done: number;
  /** The agent works on a step while an earlier one is not done. */
  readonly outOfOrder: boolean;
  readonly lastFile?: string;
}

const WRITES = new Set(["repo.write", "repo.edit"]);
const norm = (p: string) => p.replace(/^\.\//, "").trim();
const digits = (s: string) => /\d+/.exec(s)?.[0];

function argsOf(e: StoredEvent): Record<string, unknown> {
  const raw = (e.payload as { args?: unknown } | undefined)?.args;
  if (typeof raw !== "string") return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The plan of the run, as the planner wrote it. */
function planSteps(runtime: Runtime, run: Run): Array<Omit<PlanStepView, "status" | "touched">> {
  const plan = runtime.artifacts.listLatest(run.id, "plan")[0];
  if (!plan) return [];
  try {
    const doc = JSON.parse(runtime.artifacts.text(plan)) as { steps?: unknown };
    if (!Array.isArray(doc.steps)) return [];
    return doc.steps.flatMap((s, i) => {
      if (!s || typeof s !== "object") return [];
      const o = s as Record<string, unknown>;
      const description = typeof o.description === "string" ? o.description : "";
      if (!description) return [];
      return [
        {
          id: typeof o.id === "string" && o.id ? o.id : String(i + 1),
          description,
          files: Array.isArray(o.files)
            ? o.files.filter((f): f is string => typeof f === "string").map(norm)
            : [],
          verification: typeof o.verification === "string" ? o.verification : "",
        },
      ];
    });
  } catch {
    return [];
  }
}

/** `events`: the run's journal; only what the current step of the run did since it started counts. */
export function planProgressOf(
  runtime: Runtime,
  run: Run,
  events: readonly StoredEvent[],
): PlanProgress | undefined {
  const plan = planSteps(runtime, run);
  const stepId = run.currentStep;
  if (plan.length === 0 || !stepId) return undefined;
  let from = -1;
  events.forEach((e, i) => {
    if (
      e.kind === "step.start" &&
      ((e.payload as { stepId?: string } | undefined)?.stepId ?? e.stepId) === stepId
    )
      from = i;
  });
  const indexOf = (ref: string): number => {
    const exact = plan.findIndex((s) => s.id === ref);
    if (exact >= 0) return exact;
    const n = digits(ref);
    return n === undefined
      ? -1
      : plan.findIndex((s, i) => digits(s.id) === n || (digits(s.id) === undefined && String(i + 1) === n));
  };
  const marked = new Set<number>();
  let started: number | undefined;
  const written = new Set<string>();
  let lastFile: string | undefined;
  for (const e of events.slice(from + 1)) {
    if (e.kind !== "tool.call" || e.stepId !== stepId) continue;
    const p = (e.payload ?? {}) as { capability?: string; ok?: boolean };
    if (p.ok === false) continue;
    const args = argsOf(e);
    if (p.capability === "plan.step" && typeof args.step === "string") {
      const i = indexOf(args.step);
      if (i < 0) continue;
      if (args.status === "done") marked.add(i);
      else started = i;
    } else if (p.capability && WRITES.has(p.capability) && typeof args.path === "string") {
      lastFile = norm(args.path);
      written.add(lastFile);
    }
  }
  const touchedOf = (files: readonly string[]) => files.filter((f) => written.has(f)).length;
  const done = new Set(marked);
  plan.forEach((s, i) => {
    if (s.files.length > 0 && touchedOf(s.files) === s.files.length) done.add(i);
  });
  const firstOpen = plan.findIndex((_s, i) => !done.has(i));
  const current =
    started !== undefined && !done.has(started) ? started : firstOpen >= 0 ? firstOpen : undefined;
  return {
    steps: plan.map((s, i) => ({
      ...s,
      status: done.has(i) ? "done" : i === current ? "on" : "todo",
      touched: touchedOf(s.files),
    })),
    ...(current !== undefined ? { current } : {}),
    done: done.size,
    outOfOrder: current !== undefined && firstOpen >= 0 && current > firstOpen,
    ...(lastFile ? { lastFile } : {}),
  };
}

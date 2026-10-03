import { z } from "zod";

/**
 * Result schemas of the built-in agents (ADR-0001 §6 "schema результата"). Every result carries
 * `outcome` (ADR-0004 §2) and `reasons` for any outcome other than `ok`, plus `sources` so
 * provenance reaches the artifact (ADR-0005).
 */
const Source = z.string().min(1).describe("file path, `path:line`, artifact ref, Jira key or URL");

const Base = {
  summary: z.string().min(1).describe("2–5 sentences for a human reader"),
  sources: z.array(Source).default([]).describe("everything this result is based on"),
  reasons: z
    .array(
      z.object({
        kind: z.string().min(1),
        summary: z.string().min(1),
        sourceRefs: z.array(Source).default([]),
      }),
    )
    .default([])
    .describe("required when outcome is not ok"),
};

export const ResearchResult = z.object({
  ...Base,
  findings: z.array(
    z.object({ topic: z.string(), detail: z.string(), sources: z.array(Source).default([]) }),
  ),
  affectedAreas: z.array(z.string()).default([]).describe("directories, modules, services"),
  existingImplementations: z.array(z.string()).default([]).describe("where similar behaviour already exists"),
  unknowns: z.array(z.string()).default([]).describe("what could not be established from the sources"),
  outcome: z.enum(["ok"]).default("ok"),
});

export const SpecResult = z.object({
  ...Base,
  title: z.string().min(1),
  goals: z.array(z.string()).min(1),
  nonGoals: z.array(z.string()).default([]),
  requirements: z
    .array(
      z.object({ id: z.string().min(1), text: z.string().min(1), acceptance: z.array(z.string()).min(1) }),
    )
    .min(1),
  risks: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  outcome: z.enum(["ok"]).default("ok"),
});

export const ImpactResult = z.object({
  ...Base,
  affected: z.array(
    z.object({
      path: z.string().min(1),
      kind: z.enum(["code", "test", "docs", "telemetry", "config"]),
      reason: z.string().min(1),
    }),
  ),
  dependencies: z.array(z.string()).default([]).describe("modules/services that depend on the affected code"),
  risks: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([]),
  outcome: z.enum(["ok", "needs_research"]).default("ok"),
});

export const PlanResult = z.object({
  ...Base,
  steps: z.array(
    z.object({
      id: z.string().min(1),
      description: z.string().min(1),
      files: z.array(z.string()).default([]),
      verification: z.string().min(1),
    }),
  ),
  outcome: z.enum(["ok", "spec_infeasible"]).default("ok"),
});

export const ImplementationResult = z.object({
  ...Base,
  changedFiles: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]).describe("decisions, deviations from the plan, follow-ups"),
  outcome: z.enum(["ok"]).default("ok"),
});

export const TestResult = z.object({
  ...Base,
  commandsRun: z.array(z.string()).default([]),
  passed: z.boolean(),
  failures: z.array(z.object({ test: z.string(), detail: z.string() })).default([]),
  outcome: z.enum(["ok", "defects_found"]).default("ok"),
});

const Candidate = z.object({
  kind: z.enum(["knowledge", "standard", "skill-improvement"]),
  title: z.string().min(1),
  rationale: z.string().min(1),
  evidence: z.array(Source).default([]),
  proposal: z.string().optional().describe("the rule or text as it should be written"),
});

export const ReviewResult = z.object({
  ...Base,
  standardsChecked: z.array(z.string()).default([]).describe("standard refs you verified semantically"),
  candidates: z
    .array(Candidate)
    .default([])
    .describe("repeated findings worth becoming a standard or knowledge (ADR-0020 §6)"),
  findings: z.array(
    z.object({
      severity: z.enum(["blocker", "major", "minor", "nit"]),
      file: z.string().optional(),
      line: z.number().int().positive().optional(),
      issue: z.string().min(1),
      suggestion: z.string().optional(),
    }),
  ),
  verdict: z.enum(["approve", "fix_required", "plan_wrong"]),
  outcome: z.enum(["ok", "fix_required", "plan_wrong"]).default("ok"),
});

export type ResearchResultT = z.infer<typeof ResearchResult>;
export type ReviewResultT = z.infer<typeof ReviewResult>;

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

/**
 * Requirements that contradict each other, the design or the code, never resolved silently. Pilot: the
 * issue and its page both gave «flag = true» to both branches of one rule, and the research copied it.
 */
const Contradiction = z.object({
  statement: z.string().min(1).describe("what one source says, quoted or close to it"),
  conflictsWith: z
    .string()
    .min(1)
    .describe("what contradicts it: another source, another branch of the same rule, the design or the code"),
  sources: z.array(Source).default([]),
  question: z.string().min(1).describe("the one question for the analyst that settles it"),
});

export const ResearchResult = z.object({
  ...Base,
  findings: z.array(
    z.object({ topic: z.string(), detail: z.string(), sources: z.array(Source).default([]) }),
  ),
  affectedAreas: z.array(z.string()).default([]).describe("directories, modules, services"),
  existingImplementations: z.array(z.string()).default([]).describe("where similar behaviour already exists"),
  unknowns: z.array(z.string()).default([]).describe("what could not be established from the sources"),
  contradictions: z
    .array(Contradiction)
    .default([])
    .describe("requirements that contradict each other, the design or the code — never resolved silently"),
  outcome: z.enum(["ok"]).default("ok"),
});

/** ADR-0019 §3: are the requirements consistent, complete and verifiable? */
export const RequirementsResult = z.object({
  ...Base,
  requirements: z
    .array(
      z.object({
        id: z.string().min(1),
        text: z.string().min(1),
        verifiable: z.boolean(),
        sources: z.array(Source).default([]),
      }),
    )
    .default([]),
  businessRules: z.array(z.string()).default([]),
  invariants: z.array(z.string()).default([]),
  ambiguities: z.array(z.string()).default([]),
  contradictions: z.array(z.string()).default([]),
  missingCases: z
    .array(z.string())
    .default([])
    .describe("states, transitions, retries, duplicates, races, partial completion"),
  assumptions: z
    .array(z.string())
    .default([])
    .describe("what you had to assume; each becomes explicit in the spec"),
  terminology: z.array(z.object({ term: z.string(), meaning: z.string() })).default([]),
  openQuestions: z.array(z.string()).default([]),
  verdict: z.enum(["READY", "READY_WITH_ASSUMPTIONS", "NEEDS_CLARIFICATION"]),
  clarification: z
    .object({
      question: z.string().min(1).describe("the one blocking question for the human"),
      context: z.string().optional().describe("why it blocks, with the interpretations you considered"),
    })
    .optional()
    .describe("required when verdict is NEEDS_CLARIFICATION"),
  outcome: z.enum(["ok", "needs_clarification"]).default("ok"),
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
  paths: z.array(z.string()).optional().describe("globs the text applies to (front matter `paths`)"),
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
  verdict: z.enum(["approve", "fix_required", "plan_wrong", "requirements_wrong"]),
  outcome: z.enum(["ok", "fix_required", "plan_wrong", "requirements_wrong"]).default("ok"),
});

/**
 * `jarvis onboard --module` (agent mode): what one module is for. Every claim carries evidence — a
 * file and a verbatim excerpt — so a deterministic pass can drop whatever the code does not support.
 */
const Evidence = z.object({
  file: z.string().min(1).describe("repository-relative path"),
  line: z.number().int().positive().optional().describe("line where the excerpt starts, if known"),
  quote: z.string().min(3).describe("a short verbatim excerpt (one line) copied from the file"),
});

const Claim = z.object({
  statement: z.string().min(1),
  evidence: z.array(Evidence).min(1),
});

export const ModuleMapResult = z.object({
  ...Base,
  module: z.string().min(1).describe("the module path you were asked to map"),
  purpose: z.string().min(1).describe("what the module is for, in one or two sentences"),
  publicApi: z
    .array(
      z.object({
        symbol: z.string().min(1),
        file: z.string().min(1),
        description: z.string().min(1),
      }),
    )
    .default([])
    .describe("what other modules are meant to call; each symbol must appear in the file"),
  responsibilities: z.array(Claim).default([]),
  rules: z
    .array(Claim)
    .default([])
    .describe("invariants, business rules and conventions that hold in this module and are easy to break"),
  terms: z
    .array(
      z.object({
        term: z.string().min(1),
        synonyms: z.array(z.string()).default([]),
        symbols: z.array(z.string()).default([]),
      }),
    )
    .default([])
    .describe("domain vocabulary used here, with the code symbols that carry it"),
  unknowns: z.array(z.string()).default([]).describe("what you could not establish from the code"),
  outcome: z.enum(["ok"]).default("ok"),
});

/** `jarvis ask`: an answer from the knowledge base; citations are checked against the cited text. */
export const AnswerResult = z.object({
  ...Base,
  found: z.boolean().describe("false when the knowledge base does not answer the question"),
  answer: z
    .string()
    .default("")
    .describe("markdown answer built ONLY from the knowledge base; empty when found is false"),
  citations: z
    .array(
      z.object({
        ref: z.string().min(1).describe("knowledge:name, standard:ID@v or skill:id@v"),
        quote: z
          .string()
          .min(3)
          .describe("a short verbatim excerpt of the cited text that supports the answer"),
      }),
    )
    .default([]),
  gaps: z.array(z.string()).default([]).describe("what the question asks that the base does not cover"),
  general: z
    .string()
    .optional()
    .describe("general knowledge outside the base — only when the task explicitly allows it"),
  outcome: z.enum(["ok"]).default("ok"),
});

/** ADR-0019 §5: what each human review comment means for the workflow. */
export const ReviewAnalysisResult = z.object({
  ...Base,
  comments: z.array(
    z.object({
      id: z.string().min(1).describe("R-n from the review package"),
      class: z.enum([
        "CODE",
        "SPEC_CORRECTION",
        "REQUIREMENT_CORRECTION",
        "QUESTION",
        "KNOWLEDGE_CANDIDATE",
        "SUGGESTION",
      ]),
      action: z
        .string()
        .min(1)
        .describe("what has to change, or the question to ask, or the knowledge to record"),
      file: z.string().optional(),
      line: z.number().int().positive().optional(),
    }),
  ),
  verdict: z.enum(["fix_code", "spec_wrong", "requirements_wrong", "nothing_to_do"]),
  candidates: z
    .array(Candidate)
    .default([])
    .describe("KNOWLEDGE_CANDIDATE comments become candidates (ADR-0020 §6)"),
  clarification: z.object({ question: z.string().min(1), context: z.string().optional() }).optional(),
  outcome: z
    .enum(["ok", "fix_required", "spec_wrong", "requirements_wrong", "needs_clarification"])
    .default("ok"),
});

/** ADR-0001 §6 specialised agents: documentation, telemetry, release notes. */
export const DocsResult = z.object({
  ...Base,
  updatedFiles: z.array(z.string()).default([]).describe("documentation files changed in the workspace"),
  sections: z
    .array(
      z.object({ file: z.string(), heading: z.string(), change: z.enum(["added", "updated", "removed"]) }),
    )
    .default([]),
  gaps: z.array(z.string()).default([]).describe("behaviour that has no documentation home yet"),
  outcome: z.enum(["ok"]).default("ok"),
});

export const TelemetryResult = z.object({
  ...Base,
  events: z
    .array(
      z.object({
        name: z.string().min(1),
        when: z.string().min(1).describe("the user/system moment that emits it"),
        properties: z.array(z.string()).default([]),
        status: z.enum(["existing", "added", "proposed"]),
        file: z.string().optional(),
      }),
    )
    .default([]),
  metrics: z
    .array(z.object({ name: z.string(), question: z.string().describe("what the metric answers") }))
    .default([]),
  privacy: z.array(z.string()).default([]).describe("PII or sensitive fields and how they are handled"),
  outcome: z.enum(["ok", "spec_gap"]).default("ok"),
});

export const ReleaseNotesResult = z.object({
  ...Base,
  title: z.string().min(1),
  audience: z.enum(["users", "developers", "both"]).default("both"),
  highlights: z.array(z.string()).min(1),
  changes: z
    .array(
      z.object({
        kind: z.enum(["feature", "fix", "change", "deprecation", "internal"]),
        text: z.string().min(1),
        refs: z.array(Source).default([]),
      }),
    )
    .default([]),
  breaking: z.array(z.string()).default([]),
  migration: z.array(z.string()).default([]),
  markdown: z.string().min(1).describe("the notes as they will be published"),
  outcome: z.enum(["ok"]).default("ok"),
});

export type ResearchResultT = z.infer<typeof ResearchResult>;
export type ReviewResultT = z.infer<typeof ReviewResult>;

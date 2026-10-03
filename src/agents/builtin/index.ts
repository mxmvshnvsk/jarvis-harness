import { type AgentDefinition, DEFAULT_LIMITS } from "../definition.ts";
import {
  ImpactResult,
  ImplementationResult,
  PlanResult,
  ResearchResult,
  ReviewResult,
  SpecResult,
  TestResult,
} from "./schemas.ts";

/**
 * Built-in agents (ADR-0001 §6). Capability sets follow least privilege (§9, §13): research
 * never gets `repo.write`; implementation never gets effects on external systems.
 */
const READ_REPO = ["repo.read", "repo.list", "repo.search", "git.log", "git.diff", "git.status"];
const WRITE_REPO = ["repo.write", "repo.edit"];

export const RESEARCH_AGENT: AgentDefinition = {
  id: "research",
  role: "research",
  description: "Collects requirements, sources, affected areas, unknowns and existing implementations.",
  instructions: `You are the research agent of Jarvis, working on an engineering task in a repository.
Goal: establish what the task is about and what in the repository is relevant — before anyone designs or codes.
Method:
- Read the project knowledge and the task. Search the repository for the concepts, identifiers, routes, events and tests involved. Open the files that matter; quote paths and line numbers.
- Record where similar behaviour already exists and how it is implemented.
- Separate facts you verified in files from assumptions. Anything you could not verify goes to "unknowns" — never invent.
- Keep findings specific: a finding names a topic, what the code does, and the sources.
Stop when further reading would not change the findings. Then produce the result document.`,
  capabilities: READ_REPO,
  requires: { tools: true, structuredOutput: "json" },
  output: { type: "research", schema: ResearchResult, outcomes: ["ok"] },
  limits: DEFAULT_LIMITS,
};

export const SPEC_AGENT: AgentDefinition = {
  id: "specification",
  role: "research",
  description: "Turns research into a verifiable specification with acceptance criteria.",
  instructions: `You are the specification agent of Jarvis.
Goal: turn the task and the research artifact into a specification a reviewer can verify.
Method:
- Each requirement has an id (R1, R2, …), a precise statement, and acceptance criteria that can be checked by a test or an inspection.
- State non-goals explicitly. List risks and open questions instead of guessing.
- Consult the repository only to make requirements concrete (names of modules, existing behaviour); do not design the implementation.
Produce the result document when every requirement has acceptance criteria.`,
  capabilities: ["repo.read", "repo.list", "repo.search"],
  requires: { tools: true, structuredOutput: "json" },
  output: { type: "spec", schema: SpecResult, outcomes: ["ok"] },
  limits: { ...DEFAULT_LIMITS, maxToolCalls: 20 },
  contextInputs: ["research"],
};

export const IMPACT_AGENT: AgentDefinition = {
  id: "impact",
  role: "research",
  description: "Finds code, test, docs, telemetry and config dependencies and risks.",
  instructions: `You are the impact-analysis agent of Jarvis.
Goal: determine exactly what the specification touches — code, tests, docs, telemetry, config — and what depends on it.
Method:
- Start from the research findings and the specification. Search for every symbol, route, event and module named there; follow imports and callers.
- For each affected path say why it is affected and what kind of change it needs.
- If the specification refers to areas the research did not cover and you cannot establish them yourself within your budget, set outcome "needs_research" with reasons naming the missing areas.
Produce the result document when the affected set is complete.`,
  capabilities: READ_REPO,
  requires: { tools: true, structuredOutput: "json" },
  output: { type: "impact", schema: ImpactResult, outcomes: ["ok", "needs_research"] },
  limits: DEFAULT_LIMITS,
  contextInputs: ["research", "spec"],
};

export const PLAN_AGENT: AgentDefinition = {
  id: "plan",
  role: "research",
  description: "Orders the implementation into small verifiable steps.",
  instructions: `You are the planning agent of Jarvis.
Goal: an ordered list of small implementation steps, each naming the files it changes and how it is verified.
Method:
- Derive steps from the specification and the impact analysis. Every requirement must be covered by at least one step; every step must have a verification (a test to run or add, a typecheck, an inspection).
- Prefer the smallest change that satisfies the specification; do not add scope.
- If the specification cannot be implemented as written (contradiction with the code or with itself), set outcome "spec_infeasible" with reasons.
Produce the result document.`,
  capabilities: ["repo.read", "repo.list", "repo.search"],
  requires: { tools: true, structuredOutput: "json" },
  output: { type: "plan", schema: PlanResult, outcomes: ["ok", "spec_infeasible"] },
  limits: { ...DEFAULT_LIMITS, maxToolCalls: 15 },
  contextInputs: ["spec", "impact"],
};

export const IMPLEMENTATION_AGENT: AgentDefinition = {
  id: "implementation",
  role: "implementation",
  description: "Makes the minimal sufficient code changes according to the plan.",
  instructions: `You are the implementation agent of Jarvis.
Goal: implement the plan with the minimal sufficient changes to the workspace.
Method:
- Work step by step through the plan. Read a file before editing it; use repo.edit for precise changes and repo.write only for new files.
- Follow the project's conventions (see the knowledge documents). Do not refactor beyond the plan. Do not touch files the plan does not name unless a step requires it — and then say so in notes.
- Run the project's commands (typecheck, tests) when available and fix what you broke.
- Record every changed file and every deviation from the plan.
Produce the result document when the plan is implemented or when you are blocked (explain in notes).`,
  capabilities: [...READ_REPO, ...WRITE_REPO, "project.*"],
  requires: { tools: true, structuredOutput: "json" },
  output: { type: "implementation", schema: ImplementationResult, outcomes: ["ok"] },
  limits: { maxToolCalls: 80, maxModelCalls: 100, checkpointEvery: 5 },
  contextInputs: ["spec", "plan"],
};

export const TEST_AGENT: AgentDefinition = {
  id: "test",
  role: "implementation",
  description: "Builds and runs the verification strategy.",
  instructions: `You are the test agent of Jarvis.
Goal: verify the implementation against the specification's acceptance criteria.
Method:
- Run the project's test and typecheck commands. Read failures carefully; distinguish failures caused by the change from pre-existing ones.
- Where acceptance criteria have no test, add focused tests next to existing ones following the project's conventions, then run them.
- Report commands run, whether everything passed, and each failure with detail. If defects remain, set outcome "defects_found" with reasons that name the failing criteria.
Produce the result document.`,
  capabilities: [...READ_REPO, ...WRITE_REPO, "project.*"],
  requires: { tools: true, structuredOutput: "json" },
  output: { type: "tests", schema: TestResult, outcomes: ["ok", "defects_found"] },
  limits: { maxToolCalls: 40, maxModelCalls: 60, checkpointEvery: 5 },
  contextInputs: ["spec", "implementation"],
};

export const REVIEW_AGENT: AgentDefinition = {
  id: "review",
  role: "review",
  description: "Checks the diff against the specification, conventions and evidence.",
  instructions: `You are the review agent of Jarvis.
Goal: decide whether the change satisfies the specification and the project's conventions.
Method:
- Read the diff of the workspace against its base (git.diff). Check every requirement's acceptance criteria against the code and the test results.
- Look for correctness, missing cases, convention violations, and scope creep. Each finding has a severity, a location and a concrete suggestion.
- Verdict: "approve" when no blocker or major findings remain; "fix_required" when the code needs changes (outcome fix_required); "plan_wrong" when the approach itself does not fit the specification (outcome plan_wrong).
Produce the result document.`,
  capabilities: [...READ_REPO, "project.*"],
  requires: { tools: true, structuredOutput: "json" },
  output: { type: "review", schema: ReviewResult, outcomes: ["ok", "fix_required", "plan_wrong"] },
  limits: DEFAULT_LIMITS,
  contextInputs: ["spec", "plan", "implementation", "tests"],
};

export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  RESEARCH_AGENT,
  SPEC_AGENT,
  IMPACT_AGENT,
  PLAN_AGENT,
  IMPLEMENTATION_AGENT,
  TEST_AGENT,
  REVIEW_AGENT,
];

/**
 * Built-in workflow definitions (ADR-0004 §6). Agentic steps need the AgentRuntime (stage 5);
 * until then `sdd` is a declaration of the target graph, and `smoke` exercises the engine itself.
 */
export const SDD_WORKFLOW = `
name: sdd
version: 1
description: Specification-driven development (ADR-0001 §5, ADR-0004 §6)
entry: discover
steps:
  - id: discover
    kind: deterministic
    tool: project.discover
    outputs: [project-capabilities]
    transitions: { onSuccess: research }
  - id: research
    kind: agentic
    agent: research
    phase: research
    outputs: [research]
    transitions: { onSuccess: requirements }
  - id: requirements
    kind: agentic
    agent: requirements
    phase: requirements
    inputs: [research]
    outputs: [requirements]
    transitions: { onSuccess: spec }
  - id: spec
    kind: agentic
    agent: specification
    phase: spec
    inputs: [research, requirements]
    outputs: [spec]
    transitions: { onSuccess: approve-spec }
  - id: approve-spec
    kind: approval
    artifactType: spec
    transitions:
      onSuccess: impact
      onOutcome:
        request_changes: { to: spec, maxIterations: 3 }
  - id: impact
    kind: agentic
    agent: impact
    phase: impact
    inputs: [research, spec]
    outputs: [impact]
    transitions:
      onSuccess: plan
      onOutcome:
        needs_research: { to: research, maxIterations: 2 }
  - id: plan
    kind: agentic
    agent: plan
    phase: plan
    inputs: [spec, impact]
    outputs: [plan]
    transitions:
      onSuccess: implementation
      onOutcome:
        spec_infeasible: { to: spec, maxIterations: 1 }
  - id: implementation
    kind: agentic
    agent: implementation
    phase: implementation
    inputs: [spec, plan]
    outputs: [implementation]
    transitions: { onSuccess: verify }
  # ADR-0019 §8 DAG: implementation → {tests, docs, telemetry} → review; children run in parallel.
  - id: verify
    kind: composite
    children: [tests, standards, docs, telemetry]
    transitions:
      onSuccess: review
      onOutcome:
        defects_found: { to: implementation, maxIterations: 2 }
        standards_violation: { to: implementation, maxIterations: 2 }
        spec_gap: { to: spec, maxIterations: 1 }
  - id: docs
    kind: agentic
    agent: docs
    inputs: [spec, implementation]
    outputs: [docs]
  - id: telemetry
    kind: agentic
    agent: telemetry
    inputs: [spec, impact, implementation]
    outputs: [telemetry]
  - id: standards
    kind: deterministic
    tool: standards.check
    outputs: [standards-check]
  - id: tests
    kind: agentic
    agent: test
    inputs: [spec, implementation]
    outputs: [tests]
  - id: review
    kind: agentic
    agent: review
    phase: review
    inputs: [spec, plan, implementation, tests, docs, telemetry]
    outputs: [review]
    transitions:
      onSuccess: approve-impl
      onOutcome:
        fix_required: { to: implementation, maxIterations: 3 }
        plan_wrong: { to: plan, maxIterations: 1 }
        requirements_wrong: { to: requirements, maxIterations: 1 }
  # ADR-0019 §1, §5: the final human gate; jarvis review submit turns REVIEW markers into a
  # review package and routes the gate to review-analysis step.
  - id: approve-impl
    kind: approval
    artifactType: implementation
    transitions:
      onSuccess: release-notes
      onOutcome:
        request_changes: { to: implementation, maxIterations: 3 }
        review_submitted: { to: review-analysis, maxIterations: 5 }
  - id: review-analysis
    kind: agentic
    agent: review-analysis
    phase: review
    inputs: [review-package, spec, requirements, implementation]
    outputs: [review-analysis]
    transitions:
      onSuccess: approve-impl
      onOutcome:
        fix_required: { to: implementation, maxIterations: 3 }
        spec_wrong: { to: spec, maxIterations: 1 }
        requirements_wrong: { to: requirements, maxIterations: 1 }
  - id: release-notes
    kind: agentic
    agent: release-notes
    phase: release
    inputs: [spec, implementation, review]
    outputs: [release-notes]
    transitions: { onSuccess: DONE }
`;

export const SMOKE_WORKFLOW = `
name: smoke
version: 1
description: Exercises the engine with deterministic steps only
entry: hello
steps:
  - id: hello
    kind: deterministic
    tool: artifact.write
    args: { type: note, name: hello.md, content: "# hello from jarvis" }
    outputs: [note]
    transitions: { onSuccess: done-check }
  - id: done-check
    kind: deterministic
    tool: noop
    inputs: [note]
    transitions: { onSuccess: DONE }
`;

export const RESEARCH_WORKFLOW = `
name: research
version: 1
description: Research only — what the task touches and what is unknown (jarvis research)
entry: discover
steps:
  - id: discover
    kind: deterministic
    tool: project.discover
    outputs: [project-capabilities]
    transitions: { onSuccess: research }
  - id: research
    kind: agentic
    agent: research
    phase: research
    outputs: [research]
    transitions: { onSuccess: DONE }
`;

export const SPEC_WORKFLOW = `
name: spec
version: 1
description: Research, requirements analysis and a specification up to its approval (jarvis spec)
entry: discover
steps:
  - id: discover
    kind: deterministic
    tool: project.discover
    outputs: [project-capabilities]
    transitions: { onSuccess: research }
  - id: research
    kind: agentic
    agent: research
    phase: research
    outputs: [research]
    transitions: { onSuccess: requirements }
  - id: requirements
    kind: agentic
    agent: requirements
    phase: requirements
    inputs: [research]
    outputs: [requirements]
    transitions: { onSuccess: spec }
  - id: spec
    kind: agentic
    agent: specification
    phase: spec
    inputs: [research, requirements]
    outputs: [spec]
    transitions: { onSuccess: approve-spec }
  - id: approve-spec
    kind: approval
    artifactType: spec
    transitions:
      onSuccess: DONE
      onOutcome:
        request_changes: { to: spec, maxIterations: 3 }
`;

export const REVIEW_DIFF_WORKFLOW = `
name: review-diff
version: 1
description: Semantic review of a git range without a specification (jarvis prepush, ADR-0001 §16)
entry: review
steps:
  - id: review
    kind: agentic
    agent: review
    phase: review
    outputs: [review]
    transitions:
      onSuccess: DONE
      onOutcome:
        fix_required: { to: DONE }
        plan_wrong: { to: DONE }
        requirements_wrong: { to: DONE }
`;

export const BUILTIN_WORKFLOWS: Readonly<Record<string, string>> = {
  sdd: SDD_WORKFLOW,
  smoke: SMOKE_WORKFLOW,
  research: RESEARCH_WORKFLOW,
  spec: SPEC_WORKFLOW,
  "review-diff": REVIEW_DIFF_WORKFLOW,
};

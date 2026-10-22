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
    transitions: { onSuccess: gather }
  # the task's inputs and its related work read side by side: neither needs the other (pilot: related
  # work waited for the design frames, a minute and more)
  - id: gather
    kind: composite
    children: [sources, related-work]
    transitions: { onSuccess: research }
  # the task's inputs, by code, no model: its issue and pages as read, the API methods they name checked
  # against the contract maps, their design frames described
  - id: sources
    kind: deterministic
    tool: sources.collect
    outputs: [sources, design]
  # ADR-0026: the branches and PRs of related tasks and the contract they change, by code; off for a run
  # that does not want it (--no-related, relatedWork.enabled)
  - id: related-work
    kind: deterministic
    tool: related.collect
    outputs: [related-work]
  - id: research
    kind: agentic
    agent: research
    phase: research
    inputs: [sources, design, related-work]
    outputs: [research]
    transitions: { onSuccess: requirements }
  - id: requirements
    kind: agentic
    agent: requirements
    phase: requirements
    inputs: [sources, research, design, requirement-correction, related-work]
    outputs: [requirements]
    transitions: { onSuccess: spec }
  - id: spec
    kind: agentic
    agent: specification
    # research and requirements read the code: the spec writes, and at its limit it finishes with what
    # it has (marked incomplete) rather than stop the run for a person
    phase: spec
    inputs: [research, requirements, design, requirement-correction, related-work]
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
    # a small change whose files the spec names: the graph answers, no model call
    quick: impact.quick
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
      onSuccess: related-check
      onOutcome:
        spec_infeasible: { to: spec, maxIterations: 1 }
  # ADR-0026 §6: a branch the spec built on — moved on or merged since — said before the code is written
  - id: related-check
    kind: deterministic
    tool: related.check
    outputs: [related-work]
    transitions: { onSuccess: implementation }
  - id: implementation
    kind: agentic
    agent: implementation
    onLimit: ask
    phase: implementation
    inputs: [spec, plan, design, related-work, review]
    outputs: [implementation]
    transitions: { onSuccess: verify }
  # ADR-0019 §8 DAG: implementation → {tests, docs, telemetry} → review; children run in parallel,
  # but tests, docs and telemetry wait for checks and do not run when they failed: the code goes
  # back to implementation, and docs written for it would be written again
  - id: verify
    kind: composite
    children: [checks, standards, tests, docs, telemetry]
    transitions:
      onSuccess: review
      onOutcome:
        defects_found: { to: implementation, maxIterations: 2 }
        standards_violation: { to: implementation, maxIterations: 2 }
        spec_gap: { to: spec, maxIterations: 1 }
  - id: docs
    kind: agentic
    agent: docs
    when: { affects: docs }
    inputs: [spec, implementation, checks]
    outputs: [docs]
  - id: telemetry
    kind: agentic
    agent: telemetry
    when: { affects: telemetry }
    inputs: [spec, impact, implementation, checks]
    outputs: [telemetry]
  - id: checks
    kind: deterministic
    tool: project.checks
    outputs: [checks]
  - id: standards
    kind: deterministic
    tool: standards.check
    outputs: [standards-check]
  - id: tests
    kind: agentic
    agent: test
    inputs: [spec, implementation, checks]
    outputs: [tests]
  - id: review
    kind: agentic
    agent: review
    phase: review
    # its own previous version (a later round) and the checks: what to check first, what already ran
    inputs: [spec, plan, implementation, tests, checks, standards-check, docs, telemetry, review]
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
next: sdd
steps:
  - id: discover
    kind: deterministic
    tool: project.discover
    outputs: [project-capabilities]
    transitions: { onSuccess: gather }
  # the task's inputs and its related work read side by side: neither needs the other (pilot: related
  # work waited for the design frames, a minute and more)
  - id: gather
    kind: composite
    children: [sources, related-work]
    transitions: { onSuccess: research }
  # the task's inputs, by code, no model: its issue and pages as read, the API methods they name checked
  # against the contract maps, their design frames described
  - id: sources
    kind: deterministic
    tool: sources.collect
    outputs: [sources, design]
  # ADR-0026: the branches and PRs of related tasks and the contract they change, by code; off for a run
  # that does not want it (--no-related, relatedWork.enabled)
  - id: related-work
    kind: deterministic
    tool: related.collect
    outputs: [related-work]
  - id: research
    kind: agentic
    agent: research
    phase: research
    inputs: [sources, design, related-work]
    outputs: [research]
    transitions: { onSuccess: DONE }
`;

export const SPEC_WORKFLOW = `
name: spec
version: 1
description: Research, requirements analysis and a specification up to its approval (jarvis spec)
entry: discover
next: sdd
steps:
  - id: discover
    kind: deterministic
    tool: project.discover
    outputs: [project-capabilities]
    transitions: { onSuccess: gather }
  # the task's inputs and its related work read side by side: neither needs the other (pilot: related
  # work waited for the design frames, a minute and more)
  - id: gather
    kind: composite
    children: [sources, related-work]
    transitions: { onSuccess: research }
  # the task's inputs, by code, no model: its issue and pages as read, the API methods they name checked
  # against the contract maps, their design frames described
  - id: sources
    kind: deterministic
    tool: sources.collect
    outputs: [sources, design]
  # ADR-0026: the branches and PRs of related tasks and the contract they change, by code; off for a run
  # that does not want it (--no-related, relatedWork.enabled)
  - id: related-work
    kind: deterministic
    tool: related.collect
    outputs: [related-work]
  - id: research
    kind: agentic
    agent: research
    phase: research
    inputs: [sources, design, related-work]
    outputs: [research]
    transitions: { onSuccess: requirements }
  - id: requirements
    kind: agentic
    agent: requirements
    phase: requirements
    inputs: [sources, research, design, requirement-correction, related-work]
    outputs: [requirements]
    transitions: { onSuccess: spec }
  - id: spec
    kind: agentic
    agent: specification
    phase: spec
    inputs: [research, requirements, design, requirement-correction, related-work]
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

export const ONBOARD_MODULE_WORKFLOW = `
name: onboard-module
version: 2
description: Map one module of an existing repository (jarvis onboard --module, Modules in jarvis ui)
entry: map
steps:
  - id: map
    kind: agentic
    agent: onboard-mapper
    phase: research
    outputs: [module-map]
    transitions:
      onSuccess: verify
  # every claim against the files it cites, no model; what survives waits as a candidate
  - id: verify
    kind: deterministic
    tool: onboard.verify
    inputs: [module-map]
    outputs: [candidate]
    transitions:
      onSuccess: DONE
`;

export const ASK_WORKFLOW = `
name: ask
version: 1
description: Answer a question from the project knowledge base (jarvis ask)
entry: answer
steps:
  - id: answer
    kind: agentic
    agent: knowledge-answerer
    phase: research
    outputs: [answer]
    transitions:
      onSuccess: DONE
`;

/**
 * `jarvis fix`: the short way for a bug. Pilot: `sdd` ran eleven agent steps for a one-line fix —
 * requirements, impact, plan, docs, telemetry and release notes re-read the same files and added
 * nothing. Kept: research, a specification a person approves, the change with its test, the
 * project's own checks without a model, review, and the final approval.
 */
export const FIX_WORKFLOW = `
name: fix
version: 1
kind: fix
description: A bug fix — research, a specification to approve, the change with its test, the project's checks, review (jarvis fix)
entry: discover
steps:
  - id: discover
    kind: deterministic
    tool: project.discover
    outputs: [project-capabilities]
    transitions: { onSuccess: gather }
  # the task's inputs and its related work read side by side: neither needs the other (pilot: related
  # work waited for the design frames, a minute and more)
  - id: gather
    kind: composite
    children: [sources, related-work]
    transitions: { onSuccess: research }
  # the task's inputs, by code, no model: its issue and pages as read, the API methods they name checked
  # against the contract maps, their design frames described
  - id: sources
    kind: deterministic
    tool: sources.collect
    outputs: [sources, design]
  # ADR-0026: the branches and PRs of related tasks and the contract they change, by code; off for a run
  # that does not want it (--no-related, relatedWork.enabled)
  - id: related-work
    kind: deterministic
    tool: related.collect
    outputs: [related-work]
  - id: research
    kind: agentic
    agent: research
    phase: research
    inputs: [sources, design, related-work]
    outputs: [research]
    transitions: { onSuccess: spec }
  - id: spec
    kind: agentic
    agent: specification
    onLimit: ask
    phase: spec
    inputs: [research, design, related-work]
    outputs: [spec]
    transitions: { onSuccess: approve-spec }
  - id: approve-spec
    kind: approval
    artifactType: spec
    transitions:
      onSuccess: related-check
      onOutcome:
        request_changes: { to: spec, maxIterations: 3 }
  - id: related-check
    kind: deterministic
    tool: related.check
    outputs: [related-work]
    transitions: { onSuccess: implementation }
  - id: implementation
    kind: agentic
    agent: implementation
    onLimit: ask
    phase: implementation
    inputs: [research, spec, design, review]
    outputs: [implementation]
    transitions: { onSuccess: verify }
  - id: verify
    kind: composite
    children: [standards, checks]
    transitions:
      onSuccess: review
      onOutcome:
        defects_found: { to: implementation, maxIterations: 2 }
        standards_violation: { to: implementation, maxIterations: 2 }
  - id: standards
    kind: deterministic
    tool: standards.check
    outputs: [standards-check]
  - id: checks
    kind: deterministic
    tool: project.checks
    outputs: [checks]
  - id: review
    kind: agentic
    agent: review
    phase: review
    inputs: [spec, implementation, checks, standards-check]
    outputs: [review]
    transitions:
      onSuccess: approve-impl
      onOutcome:
        fix_required: { to: implementation, maxIterations: 3 }
        plan_wrong: { to: implementation, maxIterations: 1 }
        requirements_wrong: { to: spec, maxIterations: 1 }
  - id: approve-impl
    kind: approval
    artifactType: implementation
    transitions:
      onSuccess: DONE
      onOutcome:
        request_changes: { to: implementation, maxIterations: 3 }
        review_submitted: { to: review-analysis, maxIterations: 5 }
  - id: review-analysis
    kind: agentic
    agent: review-analysis
    phase: review
    inputs: [review-package, spec, implementation]
    outputs: [review-analysis]
    transitions:
      onSuccess: approve-impl
      onOutcome:
        fix_required: { to: implementation, maxIterations: 3 }
        spec_wrong: { to: spec, maxIterations: 1 }
        requirements_wrong: { to: spec, maxIterations: 1 }
`;

/**
 * ADR-0025 §6: a task across services, run in the knowledge repository. One spec for the task, then
 * the split into a subtask per service and the contract between them; each subtask is a plain sdd
 * run in its service's repository (`jarvis subtask`). The master never changes code: it waits for the
 * subtasks, checks each side of the contract in their checkouts and delivers them in order.
 */
export const SDD_CROSS_WORKFLOW = `
name: sdd-cross
version: 1
description: A task across services (ADR-0025 §6) — one spec, a subtask per service, the contract between them
entry: sources
steps:
  - id: sources
    kind: deterministic
    tool: sources.collect
    outputs: [sources, design]
    transitions: { onSuccess: catalog }
  # the services, their links, the libraries and what the task names: from the map and the contract
  # catalog, no model — the research starts from it, the split builds on it
  - id: catalog
    kind: deterministic
    tool: cross.catalog
    outputs: [catalog]
    transitions: { onSuccess: research }
  - id: research
    kind: agentic
    agent: research
    phase: research
    inputs: [sources, design, catalog]
    outputs: [research]
    transitions: { onSuccess: spec }
  - id: spec
    kind: agentic
    agent: specification
    onLimit: ask
    phase: spec
    inputs: [research, design, related-work]
    outputs: [spec]
    transitions: { onSuccess: approve-spec }
  - id: approve-spec
    kind: approval
    artifactType: spec
    transitions:
      onSuccess: split
      onOutcome:
        request_changes: { to: spec, maxIterations: 3 }
  - id: split
    kind: agentic
    agent: split
    phase: spec
    inputs: [spec, catalog, research]
    outputs: [split]
    transitions:
      onSuccess: approve-split
      onOutcome:
        spec_gap: { to: spec, maxIterations: 1 }
  - id: approve-split
    kind: approval
    artifactType: split
    transitions:
      onSuccess: spawn
      onOutcome:
        request_changes: { to: split, maxIterations: 3 }
  - id: spawn
    kind: deterministic
    tool: cross.spawn
    transitions: { onSuccess: wait }
  # parks (waiting for its subtasks) until every subtask is completed or dropped
  - id: wait
    kind: deterministic
    tool: cross.wait
    transitions: { onSuccess: contract-check }
  - id: contract-check
    kind: deterministic
    tool: cross.check
    outputs: [contract-check]
    transitions: { onSuccess: approve-delivery }
  - id: approve-delivery
    kind: approval
    artifactType: contract-check
    transitions:
      onSuccess: deliver
      onOutcome:
        request_changes: { to: wait, maxIterations: 3 }
  - id: deliver
    kind: deterministic
    tool: cross.deliver
    transitions: { onSuccess: DONE }
`;

/**
 * In a knowledge repository there is no code to research: `jarvis research` there researches a task
 * across services — the map, the links, the services' knowledge — and goes on as sdd-cross.
 */
export const RESEARCH_CROSS_WORKFLOW = `
name: research-cross
version: 1
description: Research across services, in the knowledge repository — what the task touches in which service, nothing changed
entry: sources
next: sdd-cross
steps:
  - id: sources
    kind: deterministic
    tool: sources.collect
    outputs: [sources, design]
    transitions: { onSuccess: catalog }
  - id: catalog
    kind: deterministic
    tool: cross.catalog
    outputs: [catalog]
    transitions: { onSuccess: research }
  - id: research
    kind: agentic
    agent: research
    phase: research
    inputs: [sources, design, catalog]
    outputs: [research]
    transitions: { onSuccess: DONE }
`;

/** `jarvis spec` in a knowledge repository: up to the approved spec of a task across services. */
export const SPEC_CROSS_WORKFLOW = `
name: spec-cross
version: 1
description: Up to the approved spec of a task across services, in the knowledge repository
entry: sources
next: sdd-cross
steps:
  - id: sources
    kind: deterministic
    tool: sources.collect
    outputs: [sources, design]
    transitions: { onSuccess: catalog }
  - id: catalog
    kind: deterministic
    tool: cross.catalog
    outputs: [catalog]
    transitions: { onSuccess: research }
  - id: research
    kind: agentic
    agent: research
    phase: research
    inputs: [sources, design, catalog]
    outputs: [research]
    transitions: { onSuccess: spec }
  - id: spec
    kind: agentic
    agent: specification
    onLimit: ask
    phase: spec
    inputs: [research, design, related-work]
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

export const BUILTIN_WORKFLOWS: Readonly<Record<string, string>> = {
  "research-cross": RESEARCH_CROSS_WORKFLOW,
  "spec-cross": SPEC_CROSS_WORKFLOW,
  "sdd-cross": SDD_CROSS_WORKFLOW,
  sdd: SDD_WORKFLOW,
  fix: FIX_WORKFLOW,
  smoke: SMOKE_WORKFLOW,
  research: RESEARCH_WORKFLOW,
  spec: SPEC_WORKFLOW,
  "review-diff": REVIEW_DIFF_WORKFLOW,
  "onboard-module": ONBOARD_MODULE_WORKFLOW,
  ask: ASK_WORKFLOW,
};

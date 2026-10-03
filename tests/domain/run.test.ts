import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  isResumable,
  isTerminal,
  type RunState,
} from "../../src/core/domain/run.ts";
import { findStep, selectTransition, WorkflowDefinitionSchema } from "../../src/core/domain/workflow.ts";

describe("run state machine", () => {
  it("follows ADR-0001 §4 with CANCELLED from ADR-0002 §6", () => {
    expect(canTransition("CREATED", "RUNNING")).toBe(true);
    expect(canTransition("RUNNING", "WAITING_BUDGET")).toBe(true);
    expect(canTransition("WAITING_BUDGET", "RUNNING")).toBe(true);
    expect(canTransition("WAITING_HUMAN", "FAILED")).toBe(true);
    expect(canTransition("FAILED", "RUNNING")).toBe(true);
    expect(canTransition("COMPLETED", "RUNNING")).toBe(false);
    expect(canTransition("CANCELLED", "RUNNING")).toBe(false);
    for (const state of [
      "CREATED",
      "RUNNING",
      "WAITING_BUDGET",
      "WAITING_HUMAN",
      "SUSPENDED",
      "FAILED",
    ] as RunState[]) {
      expect(canTransition(state, "CANCELLED")).toBe(true);
    }
  });

  it("knows terminal and resumable states", () => {
    expect(isTerminal("COMPLETED")).toBe(true);
    expect(isTerminal("CANCELLED")).toBe(true);
    expect(isTerminal("FAILED")).toBe(false);
    expect(isResumable("WAITING_BUDGET")).toBe(true);
    expect(isResumable("FAILED")).toBe(true);
    expect(isResumable("RUNNING")).toBe(false);
  });

  it("throws a typed error on invalid transitions", () => {
    expect(() => assertTransition("COMPLETED", "RUNNING")).toThrow(InvalidTransitionError);
  });
});

const workflow = WorkflowDefinitionSchema.parse({
  name: "sdd",
  entry: "research",
  steps: [
    { id: "research", kind: "agentic", agent: "research", transitions: { onSuccess: "impact" } },
    {
      id: "impact",
      kind: "agentic",
      agent: "impact",
      transitions: { onSuccess: "DONE", onOutcome: { needs_research: { to: "research", maxIterations: 2 } } },
    },
  ],
});

describe("workflow transitions", () => {
  it("selects success, failure and outcome edges deterministically", () => {
    const impact = findStep(workflow, "impact");
    expect(selectTransition(impact, { status: "success" })).toEqual({ to: "DONE" });
    expect(selectTransition(impact, { status: "failure" })).toEqual({ to: "FAIL" });
    expect(selectTransition(impact, { status: "success", outcome: "ok" })).toEqual({ to: "DONE" });
    expect(selectTransition(impact, { status: "success", outcome: "needs_research" })).toEqual({
      to: "research",
      edgeId: "impact->research#needs_research",
      maxIterations: 2,
    });
  });

  it("rejects undeclared outcomes — agents cannot invent transitions", () => {
    const impact = findStep(workflow, "impact");
    expect(() => selectTransition(impact, { status: "success", outcome: "go_wild" })).toThrow(
      /undeclared outcome/,
    );
  });

  it("validates the graph: unknown targets, duplicate ids, agentic without agent", () => {
    const bad = WorkflowDefinitionSchema.safeParse({
      name: "bad",
      entry: "a",
      steps: [
        { id: "a", kind: "agentic", transitions: { onSuccess: "nope" } },
        { id: "a", kind: "deterministic" },
      ],
    });
    expect(bad.success).toBe(false);
    const messages = bad.success ? [] : bad.error.issues.map((i) => i.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("duplicate step id"),
        expect.stringContaining("requires an agent"),
        expect.stringContaining('unknown target "nope"'),
      ]),
    );
  });
});

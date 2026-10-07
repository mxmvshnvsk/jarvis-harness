import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prepareSuggestions } from "../interaction/answers.ts";
import { afterApproval, afterGateReached } from "../interaction/review/lifecycle.ts";
import type { StepContext, StepExecutor, StepOutcome } from "./types.ts";
import { SuspendRun } from "./types.ts";

/* ------------------------------------------------------------------------------------------------
 * Deterministic steps: registered tool functions (AST, tests, typecheck, impact by graph, …).
 * ---------------------------------------------------------------------------------------------- */

export type DeterministicTool = (
  ctx: StepContext,
  args: Readonly<Record<string, unknown>>,
) => Promise<StepOutcome>;

export class DeterministicExecutor implements StepExecutor {
  readonly kind = "deterministic" as const;
  private readonly tools: ReadonlyMap<string, DeterministicTool>;

  constructor(tools: ReadonlyMap<string, DeterministicTool> | Record<string, DeterministicTool>) {
    this.tools = tools instanceof Map ? tools : new Map(Object.entries(tools));
  }

  async execute(ctx: StepContext): Promise<StepOutcome> {
    const name = ctx.step.tool as string;
    const tool = this.tools.get(name);
    if (tool) return tool(ctx, ctx.step.args);
    // Otherwise a registered capability (project.tests, repo.search, …) run through the router.
    if (ctx.tools.has(name)) {
      const result = await ctx.tools.invoke(name, ctx.step.args);
      if (result.denied) return { status: "failure", reason: `capability ${name} denied: ${result.denied}` };
      const artifact = ctx.runtime.artifacts.put({
        runId: ctx.run.id,
        type: "tool-output",
        name: `${ctx.step.id}.txt`,
        content: result.text,
        provenance: { kind: "tool", capability: name },
        stepId: ctx.step.id,
        iteration: ctx.iteration,
      });
      return result.ok
        ? { status: "success", outputs: [`${artifact.artifactId}@${artifact.version}`] }
        : {
            status: "failure",
            reason: result.error ?? `${name} failed`,
            outputs: [`${artifact.artifactId}@${artifact.version}`],
          };
    }
    return { status: "failure", reason: `unknown deterministic tool "${name}"` };
  }
}

/* ------------------------------------------------------------------------------------------------
 * Agentic steps: a port the AgentRuntime implements (stage 5). Until then, an honest failure.
 * ---------------------------------------------------------------------------------------------- */

export interface AgentRunner {
  run(ctx: StepContext): Promise<StepOutcome>;
}

/** What a `quick:` tool answers when the step needs its agent after all. */
export const NEEDS_AGENT = "needs_agent";

export class AgenticExecutor implements StepExecutor {
  readonly kind = "agentic" as const;
  private readonly runner: AgentRunner | undefined;
  private readonly quickTools: ReadonlyMap<string, DeterministicTool>;

  constructor(runner?: AgentRunner, quickTools: Record<string, DeterministicTool> = {}) {
    this.runner = runner;
    this.quickTools = new Map(Object.entries(quickTools));
  }

  async execute(ctx: StepContext): Promise<StepOutcome> {
    const quick = ctx.step.quick ? this.quickTools.get(ctx.step.quick) : undefined;
    if (quick && ctx.step.quick) {
      const tried = await quick(ctx, ctx.step.args);
      ctx.runtime.events.emit({
        kind: "step.quick",
        runId: ctx.run.id,
        stepId: ctx.step.id,
        iteration: ctx.iteration,
        payload: {
          tool: ctx.step.quick,
          used: tried.status === "success" && tried.outcome !== NEEDS_AGENT,
          ...(tried.reason ? { reason: tried.reason } : {}),
        },
      });
      if (tried.status === "success" && tried.outcome !== NEEDS_AGENT) return tried;
    }
    if (!this.runner)
      return { status: "failure", reason: `no agent runner registered for agent "${ctx.step.agent}"` };
    const outcome = await this.runner.run(ctx);
    if (outcome.status === "success" && outcome.outcome === CLARIFICATION_OUTCOME) {
      // ADR-0019 §4: the agent cannot continue without a human answer — open a thread and park.
      // The step runs again, with the resolution in its context, once the thread is resolved.
      const rt = ctx.runtime;
      const ref = outcome.outputs?.[0];
      const question = ref ? questionOf(rt, ref) : undefined;
      const thread = rt.interactions.open({
        runId: ctx.run.id,
        kind: "clarification",
        stepId: ctx.step.id,
        iteration: ctx.iteration,
        ...(ref ? { contentRef: ref } : {}),
        origin: `agent:${ctx.step.agent}`,
        openedBy: `agent:${ctx.step.agent}`,
        meta: { agent: ctx.step.agent },
        message: {
          role: "jarvis",
          actor: `agent:${ctx.step.agent}`,
          text: question ?? outcome.reason ?? "clarification needed",
        },
      });
      rt.events.emit({
        kind: "interaction.opened",
        runId: ctx.run.id,
        stepId: ctx.step.id,
        iteration: ctx.iteration,
        payload: { kind: "clarification", interactionId: thread.id, agent: ctx.step.agent },
      });
      throw new SuspendRun("WAITING_HUMAN", `clarification needed by ${ctx.step.agent}: ${thread.id}`, {
        checkpointState: { clarification: thread.id },
        waitingFor: { kind: "clarification", interactionId: thread.id },
      });
    }
    return outcome;
  }
}

export const CLARIFICATION_OUTCOME = "needs_clarification";

/** The blocking question of a result document (`clarification.question`, else the open questions). */
function questionOf(rt: StepContext["runtime"], ref: string): string | undefined {
  const [id, version] = ref.split("@");
  const artifact = rt.artifacts.get(id as string, Number(version));
  if (!artifact) return undefined;
  try {
    const doc = JSON.parse(rt.artifacts.text(artifact)) as {
      clarification?: { question?: string; context?: string };
      openQuestions?: string[];
    };
    if (doc.clarification?.question) {
      return doc.clarification.context
        ? `${doc.clarification.question}\n\nContext: ${doc.clarification.context}`
        : doc.clarification.question;
    }
    if (doc.openQuestions && doc.openQuestions.length > 0) return doc.openQuestions.join("\n");
  } catch {
    // not JSON
  }
  return undefined;
}

/* ------------------------------------------------------------------------------------------------
 * Approval steps: the human gate (ADR-0005 §4, ADR-0009 §2, §4).
 * ---------------------------------------------------------------------------------------------- */

interface CommittedApproval {
  artifactId: string;
  version: number;
  contentRef: string;
  decision: string;
}

/** `.jarvis/approvals/<task>/<artifactType>.json` committed to the repository (ADR-0009 §4). */
export function committedApproval(
  projectRoot: string,
  task: string,
  artifactType: string,
): CommittedApproval | undefined {
  const path = join(projectRoot, ".jarvis", "approvals", task, `${artifactType}.json`);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CommittedApproval;
  } catch {
    return undefined;
  }
}

export class ApprovalExecutor implements StepExecutor {
  readonly kind = "approval" as const;

  async execute(ctx: StepContext): Promise<StepOutcome> {
    const type = ctx.step.artifactType as string;
    const latest = ctx.runtime.artifacts.listLatest(ctx.run.id, type)[0];
    if (!latest)
      return {
        status: "failure",
        reason: `approval step "${ctx.step.id}": no artifact of type "${type}" to approve`,
      };
    const gate = ctx.runtime.artifacts.isApproved(latest.artifactId);
    if (gate.approved) {
      closeApprovalThread(ctx, latest.artifactId);
      if (type === "implementation") afterApproval(ctx.runtime, ctx.run, gate.approval?.actor.id ?? "human");
      return { status: "success", outputs: [`${latest.artifactId}@${latest.version}`] };
    }

    const config = ctx.runtime.loaded.config;
    if (config.human.gates[type]?.required === false) {
      // ADR-0019 §9: the project switched this gate off.
      ctx.runtime.events.emit({
        kind: "approval.skipped",
        runId: ctx.run.id,
        stepId: ctx.step.id,
        payload: {
          artifactId: latest.artifactId,
          version: latest.version,
          type,
          reason: "gate not required",
        },
      });
      return { status: "success", outputs: [`${latest.artifactId}@${latest.version}`] };
    }
    const latestApproval = ctx.runtime.artifacts.approvalsFor(latest.artifactId, latest.version)[0];
    if (latestApproval?.decision === "reject") {
      return {
        status: "failure",
        reason: `${type} rejected by ${latestApproval.actor.id}${latestApproval.comment ? `: ${latestApproval.comment}` : ""}`,
      };
    }
    if (latestApproval?.decision === "request_changes") {
      // ADR-0005 §4: request_changes is an outcome for a declared back edge; ADR-0019 §5 lets the
      // reviewer choose a more specific one (review_submitted, spec_wrong, …).
      closeApprovalThread(ctx, latest.artifactId);
      return {
        status: "success",
        outcome: latestApproval.outcome ?? "request_changes",
        outputs: [`${latest.artifactId}@${latest.version}`],
      };
    }

    if (!config.interactive) {
      if (config.humanGate === "fail") {
        return {
          status: "failure",
          reason: `policy: human_gate_in_ci — gate "${ctx.step.id}" reached in non-interactive mode (humanGate: fail)`,
        };
      }
      if (config.humanGate === "skip-if-approved" && ctx.runtime.loaded.project) {
        const committed = committedApproval(ctx.runtime.loaded.project.root, ctx.run.task, type);
        if (committed && committed.decision === "approve" && committed.contentRef === latest.contentRef) {
          ctx.runtime.events.emit({
            kind: "approval.committed",
            runId: ctx.run.id,
            stepId: ctx.step.id,
            payload: { artifactId: latest.artifactId, version: latest.version },
          });
          return { status: "success", outputs: [`${latest.artifactId}@${latest.version}`] };
        }
      }
    }

    const contentRef = `${latest.artifactId}@${latest.version}`;
    const thread =
      ctx.runtime.interactions.openFor(ctx.run.id, "approval") ??
      ctx.runtime.interactions.open({
        runId: ctx.run.id,
        kind: "approval",
        stepId: ctx.step.id,
        iteration: ctx.iteration,
        contentRef,
        openedBy: "runtime",
        meta: { artifactType: type },
      });
    if (type === "implementation") afterGateReached(ctx.runtime, ctx.run);
    // the document's open questions with answers from what the run collected, ready on the page
    await prepareSuggestions(ctx.runtime, ctx.run, latest, ctx.step.id);
    throw new SuspendRun("WAITING_HUMAN", `approve ${type} (${latest.name}@${latest.version})`, {
      checkpointState: { awaitingApproval: { artifactId: latest.artifactId, version: latest.version, type } },
      waitingFor: { kind: "approval", interactionId: thread.id, detail: type },
    });
  }
}

function closeApprovalThread(ctx: StepContext, artifactId: string): void {
  const open = ctx.runtime.interactions.openFor(ctx.run.id, "approval");
  if (open?.contentRef?.startsWith(`${artifactId}@`)) {
    const approval = ctx.runtime.artifacts.approvalsFor(artifactId)[0];
    ctx.runtime.interactions.close(open.id, "resolved", approval?.actor.id ?? "human", open.contentRef);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Composite steps: independent children in parallel with a shared budget (ADR-0011 §1).
 * ---------------------------------------------------------------------------------------------- */

export type ChildRunner = (ctx: StepContext, childId: string) => Promise<StepOutcome>;

export class CompositeExecutor implements StepExecutor {
  readonly kind = "composite" as const;
  private readonly runChild: ChildRunner;

  constructor(runChild: ChildRunner) {
    this.runChild = runChild;
  }

  async execute(ctx: StepContext): Promise<StepOutcome> {
    const results = await Promise.allSettled(ctx.step.children.map((child) => this.runChild(ctx, child)));
    const suspended = results.find((r) => r.status === "rejected" && r.reason instanceof SuspendRun);
    if (suspended && suspended.status === "rejected") throw suspended.reason;
    const rejected = results.find((r) => r.status === "rejected");
    if (rejected && rejected.status === "rejected") throw rejected.reason;
    const outcomes = results.map((r) =>
      r.status === "fulfilled" ? r.value : { status: "failure" as const },
    );
    const failed = outcomes.find((o) => o.status === "failure");
    if (failed) return { status: "failure", reason: failed.reason ?? "a child step failed" };
    const nonOk = outcomes.find((o) => o.outcome !== undefined && o.outcome !== "ok");
    return {
      status: "success",
      ...(nonOk?.outcome ? { outcome: nonOk.outcome } : {}),
      outputs: outcomes.flatMap((o) => o.outputs ?? []),
    };
  }
}

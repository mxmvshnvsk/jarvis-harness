import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
    if (!tool) return { status: "failure", reason: `unknown deterministic tool "${name}"` };
    return tool(ctx, ctx.step.args);
  }
}

/* ------------------------------------------------------------------------------------------------
 * Agentic steps: a port the AgentRuntime implements (stage 5). Until then, an honest failure.
 * ---------------------------------------------------------------------------------------------- */

export interface AgentRunner {
  run(ctx: StepContext): Promise<StepOutcome>;
}

export class AgenticExecutor implements StepExecutor {
  readonly kind = "agentic" as const;
  private readonly runner: AgentRunner | undefined;

  constructor(runner?: AgentRunner) {
    this.runner = runner;
  }

  async execute(ctx: StepContext): Promise<StepOutcome> {
    if (!this.runner)
      return { status: "failure", reason: `no agent runner registered for agent "${ctx.step.agent}"` };
    return this.runner.run(ctx);
  }
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
    if (gate.approved) return { status: "success", outputs: [`${latest.artifactId}@${latest.version}`] };

    const config = ctx.runtime.loaded.config;
    const latestApproval = ctx.runtime.artifacts.approvalsFor(latest.artifactId, latest.version)[0];
    if (latestApproval?.decision === "reject") {
      return {
        status: "failure",
        reason: `${type} rejected by ${latestApproval.actor.id}${latestApproval.comment ? `: ${latestApproval.comment}` : ""}`,
      };
    }
    if (latestApproval?.decision === "request_changes") {
      // ADR-0005 §4: request_changes is an outcome for a declared back edge.
      return {
        status: "success",
        outcome: "request_changes",
        outputs: [`${latest.artifactId}@${latest.version}`],
      };
    }

    if (!config.interactive) {
      if (config.humanGate === "fail") {
        return {
          status: "failure",
          reason: `human gate "${ctx.step.id}" reached in non-interactive mode (humanGate: fail)`,
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

    throw new SuspendRun("WAITING_HUMAN", `approve ${type} (${latest.name}@${latest.version})`, {
      checkpointState: { awaitingApproval: { artifactId: latest.artifactId, version: latest.version, type } },
    });
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

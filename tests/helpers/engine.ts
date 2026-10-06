import { createRuntime, type Runtime } from "../../src/app/runtime.ts";
import { loadConfig } from "../../src/core/config/load.ts";
import type { Actor } from "../../src/core/domain/actor.ts";
import { type WorkflowDefinition, WorkflowDefinitionSchema } from "../../src/core/domain/workflow.ts";
import {
  AgenticExecutor,
  type AgentRunner,
  DeterministicExecutor,
} from "../../src/orchestration/executors.ts";
import { LocalWorkflowEngine } from "../../src/orchestration/runtime.ts";
import { BUILTIN_TOOLS } from "../../src/orchestration/tools/builtin.ts";
import type { StepContext, StepOutcome } from "../../src/orchestration/types.ts";
import type { WorkspaceFactory } from "../../src/orchestration/workspace.ts";
import type { Sandbox } from "./tmp.ts";

export const ACTOR: Actor = { kind: "user", id: "me@corp", verified: false };

export async function testRuntime(sb: Sandbox, env: NodeJS.ProcessEnv = {}): Promise<Runtime> {
  const loaded = await loadConfig({ cwd: sb.project, homeDir: sb.home, env });
  return createRuntime(loaded, { env });
}

export function workflowOf(yamlLike: Record<string, unknown>): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse(yamlLike);
}

export interface FakeAgents {
  readonly handlers: Record<string, (ctx: StepContext) => Promise<StepOutcome>>;
}

export function fakeAgentRunner(handlers: FakeAgents["handlers"]): AgentRunner {
  return {
    async run(ctx) {
      const handler = handlers[ctx.step.agent as string];
      if (!handler) return { status: "failure", reason: `no fake for agent ${ctx.step.agent}` };
      return handler(ctx);
    },
  };
}

export function engineFor(
  runtime: Runtime,
  workflows: WorkflowDefinition[],
  agents: FakeAgents["handlers"] = {},
  clock?: () => Date,
  workspaces?: WorkspaceFactory,
) {
  return new LocalWorkflowEngine({
    runtime,
    workflows: new Map(workflows.map((w) => [w.name, w])),
    executors: {
      deterministic: new DeterministicExecutor(BUILTIN_TOOLS),
      agentic: new AgenticExecutor(fakeAgentRunner(agents), BUILTIN_TOOLS),
    },
    leaseOptions: { heartbeatMs: 0 },
    ...(clock ? { clock } : {}),
    ...(workspaces ? { workspaces } : {}),
  });
}

export function createRun(runtime: Runtime, workflow: string, task = "ABC-1") {
  return runtime.runs.create({
    task,
    workflow,
    owner: ACTOR,
    workspace: { mode: "cwd", repoRoot: "/r", path: "/r", baseRef: "HEAD" },
    dataClass: runtime.loaded.config.dataClass,
  });
}

/** Writes an artifact from inside a fake agent. */
export function writeArtifact(
  ctx: StepContext,
  type: string,
  content: string,
  outcome?: string,
): StepOutcome {
  const a = ctx.runtime.artifacts.put({
    runId: ctx.run.id,
    type,
    name: `${type}.md`,
    content,
    provenance: { kind: "agent", agentId: ctx.step.agent ?? "fake" },
    stepId: ctx.step.id,
    iteration: ctx.iteration,
  });
  return { status: "success", outputs: [`${a.artifactId}@${a.version}`], ...(outcome ? { outcome } : {}) };
}

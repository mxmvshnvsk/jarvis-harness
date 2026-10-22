import { BUILTIN_AGENTS } from "../agents/builtin/index.ts";
import { AgentRegistry } from "../agents/definition.ts";
import type { WorkflowDefinition } from "../core/domain/workflow.ts";
import { serversNeeded } from "../mcp/provider.ts";
import { validateRoles } from "../models/router.ts";
import type { Runtime } from "./runtime.ts";

export interface McpPreflight {
  readonly servers: Array<{ id: string; ok: boolean; tools?: number; error?: string }>;
  readonly ok: boolean;
}

/** Capability patterns of every agent a workflow may run. */
export function workflowCapabilities(runtime: Runtime, workflow: WorkflowDefinition): string[] {
  const agents = new AgentRegistry(BUILTIN_AGENTS, runtime.loaded.project?.root);
  const patterns = new Set<string>();
  for (const step of workflow.steps) {
    if (step.kind === "agentic" && step.agent) {
      for (const c of agents.get(step.agent)?.capabilities ?? []) patterns.add(c);
    }
  }
  return [...patterns].sort();
}

/** What the workflow's steps without a model read through MCP servers (related work, sources). */
function workflowToolReads(workflow: WorkflowDefinition): string[] {
  const out = new Set<string>();
  for (const step of workflow.steps)
    if (step.kind === "deterministic" && step.tool) for (const c of TOOL_READS[step.tool] ?? []) out.add(c);
  return [...out].sort();
}

/** What the deterministic tools read through MCP servers. */
const TOOL_READS: Readonly<Record<string, readonly string[]>> = {
  "sources.collect": ["jira.get", "confluence.get", "figma.get"],
  "related.collect": ["jira.get", "jira.search", "jira.devInfo", "bitbucket.*"],
  "related.check": ["jira.devInfo", "bitbucket.*"],
};

/**
 * Whether a run of the workflow runs the project's commands (builds, tests, typecheck): only then does
 * its checkout need `workspace.setup` (pilot: spec runs waited minutes for an install nothing used).
 */
export function workflowRunsProjectCommands(runtime: Runtime, workflow: WorkflowDefinition): boolean {
  const agents = new AgentRegistry(BUILTIN_AGENTS, runtime.loaded.project?.root);
  return workflow.steps.some((step) =>
    step.kind === "deterministic"
      ? !!step.tool && step.tool.startsWith("project.") && step.tool !== "project.discover"
      : step.kind === "agentic" && step.agent
        ? (agents.get(step.agent)?.capabilities ?? []).some((c) =>
            /^(project\.|code\.diagnostics|shell\.)/.test(c),
          )
        : false,
  );
}

/**
 * ADR-0017 §6: before a run is created, every MCP server its agents may reach must answer
 * `tools/list`; discovery refreshes the cache and the registry so unprofiled tools are exposed.
 */
export async function preflightMcp(runtime: Runtime, workflow: WorkflowDefinition): Promise<McpPreflight> {
  const needed = serversNeeded(runtime.loaded.config, workflowCapabilities(runtime, workflow));
  // the servers only a step without a model reads: started now too, not in the middle of that step —
  // but not required: such a step says what it could not read and the run goes on
  const warmed = serversNeeded(runtime.loaded.config, workflowToolReads(workflow)).filter(
    (id) => !needed.includes(id),
  );
  const servers: McpPreflight["servers"] = [];
  // side by side: each stdio server takes seconds to start (npx, uvx), one after another they added up
  const warming = Promise.all(warmed.map((id) => runtime.mcp.pool.discover(id).catch(() => undefined)));
  await Promise.all(
    needed.map(async (id) => {
      try {
        const entry = await runtime.mcp.pool.discover(id);
        servers.push({ id, ok: true, tools: entry.tools.length });
        runtime.events.emit({
          kind: "mcp.discovered",
          payload: { server: id, tools: entry.tools.length, hash: entry.hash },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        servers.push({ id, ok: false, error: message });
        runtime.events.emit({ kind: "mcp.unavailable", payload: { server: id, error: message } });
      }
    }),
  );
  await warming;
  servers.sort((a, b) => needed.indexOf(a.id) - needed.indexOf(b.id));
  runtime.registry.replace(runtime.mcp.provider);
  return { servers, ok: servers.every((s) => s.ok) };
}

/**
 * ADR-0007 §3: the steps of a workflow no model can serve, said before the run starts — with what the
 * configuration claims and what a probe found (src/models/router.ts effectiveModel). Said, not refused:
 * a step may be skipped (`when`), and the run fails at that step with the same words anyway.
 */
export function preflightModels(
  runtime: Runtime,
  workflow: WorkflowDefinition,
): Array<{ readonly step: string; readonly reason: string }> {
  const agents = new AgentRegistry(BUILTIN_AGENTS, runtime.loaded.project?.root);
  const out: Array<{ step: string; reason: string }> = [];
  for (const step of workflow.steps) {
    if (step.kind !== "agentic" || !step.agent) continue;
    const def = agents.get(step.agent);
    if (!def) continue;
    for (const p of validateRoles(
      runtime.loaded.config,
      [{ role: def.role, requires: def.requires }],
      runtime.probes,
    ))
      out.push({ step: step.id, reason: p.reason });
  }
  return out;
}

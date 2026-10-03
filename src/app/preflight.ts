import { BUILTIN_AGENTS } from "../agents/builtin/index.ts";
import { AgentRegistry } from "../agents/definition.ts";
import type { WorkflowDefinition } from "../core/domain/workflow.ts";
import { serversNeeded } from "../mcp/provider.ts";
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

/**
 * ADR-0017 §6: before a run is created, every MCP server its agents may reach must answer
 * `tools/list`; discovery refreshes the cache and the registry so unprofiled tools are exposed.
 */
export async function preflightMcp(runtime: Runtime, workflow: WorkflowDefinition): Promise<McpPreflight> {
  const needed = serversNeeded(runtime.loaded.config, workflowCapabilities(runtime, workflow));
  const servers: McpPreflight["servers"] = [];
  for (const id of needed) {
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
  }
  runtime.registry.replace(runtime.mcp.provider);
  return { servers, ok: servers.every((s) => s.ok) };
}

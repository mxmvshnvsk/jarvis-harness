import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Runtime } from "../app/runtime.ts";
import { runDetail } from "../app/status.ts";
import { effectiveStacks } from "../capabilities/detector.ts";
import { renderPackage } from "../knowledge/package.ts";
import { loadKnowledgeDocs, resolvePackage } from "../knowledge/resolver.ts";
import { loadSkills } from "../knowledge/skills.ts";
import { loadStandards } from "../knowledge/standards.ts";
import { shortRunId } from "../storage/runStore.ts";

/**
 * Jarvis as an MCP server (ADR-0017 §7): read-only tools for IDEs and other agents —
 * `knowledge.search`, `spec.get`, `run.status`, `context.inspect`. No set-operations.
 */
function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

export function buildMcpServer(
  runtime: Runtime,
  projectRoot: string | undefined,
  version: string,
): McpServer {
  const server = new McpServer({ name: "jarvis", version });
  const roots = { projectRoot, userRoot: runtime.loaded.home.root };

  server.registerTool(
    "knowledge.search",
    {
      description:
        "Search project knowledge, standards and skills (.jarvis/) by substring; returns refs and matching lines.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().positive().max(50).optional() },
    },
    async ({ query, limit }) => {
      const q = query.toLowerCase();
      const hits: string[] = [];
      const scan = (ref: string, body: string) => {
        body.split("\n").forEach((line, i) => {
          if (line.toLowerCase().includes(q)) hits.push(`${ref}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
      };
      for (const d of loadKnowledgeDocs(roots)) scan(`knowledge:${d.name}`, d.text);
      for (const s of loadStandards(roots)) scan(`standard:${s.id}@${s.version}`, `${s.title}\n${s.rule}`);
      for (const s of loadSkills(roots))
        scan(`skill:${s.id}@${s.version}`, `${s.title ?? ""}\n${s.instructions}`);
      const shown = hits.slice(0, limit ?? 20);
      return text(shown.length > 0 ? shown.join("\n") : `no matches for "${query}"`);
    },
  );

  server.registerTool(
    "spec.get",
    {
      description: "Latest specification artifact of a run (by run id/prefix or task key).",
      inputSchema: { run: z.string().min(1), type: z.string().min(1).optional() },
    },
    async ({ run: ref, type }) => {
      const run = runtime.runs.resolve(ref) ?? runtime.runs.list({ task: ref, includeTerminal: true }).at(-1);
      if (!run) return text(`run "${ref}" not found`);
      const artifact = runtime.artifacts.listLatest(run.id, type ?? "spec")[0];
      if (!artifact) return text(`run ${shortRunId(run.id)} has no ${type ?? "spec"} artifact`);
      return text(
        `# ${artifact.type}/${artifact.name}@${artifact.version} (run ${shortRunId(run.id)})\n${runtime.artifacts.text(artifact)}`,
      );
    },
  );

  server.registerTool(
    "run.status",
    {
      description: "Status of one run (id/prefix/task) or, without arguments, every active run.",
      inputSchema: { run: z.string().min(1).optional() },
    },
    async ({ run: ref }) => {
      if (!ref) {
        const runs = runtime.runs.list({});
        return text(
          runs.length > 0
            ? runs
                .map(
                  (r) =>
                    `${shortRunId(r.id)}  ${r.task}  ${r.state}${r.waitingFor ? ` (waiting ${r.waitingFor.kind})` : ""}  ${r.currentStep ?? "-"}`,
                )
                .join("\n")
            : "no active runs",
        );
      }
      const run = runtime.runs.resolve(ref) ?? runtime.runs.list({ task: ref, includeTerminal: true }).at(-1);
      if (!run) return text(`run "${ref}" not found`);
      const d = runDetail(runtime, run);
      const lines = [
        `run ${run.id} task ${run.task} workflow ${run.workflow}`,
        `state ${run.state}${run.stateReason ? ` — ${run.stateReason}` : ""}; step ${run.currentStep ?? "-"} #${run.currentIteration}`,
        run.waitingFor
          ? `waiting for ${run.waitingFor.kind}${run.waitingFor.detail ? ` (${run.waitingFor.detail})` : ""}`
          : "",
        d.capabilities ? `stack ${d.capabilities.stacks.join(", ")} level ${d.capabilities.level}` : "",
        `tokens ${d.tokens.calls} calls, ${d.tokens.outputTokens} output`,
        "steps:",
        ...d.steps.map(
          (s) =>
            `  ${s.stepId} #${s.iteration} ${s.status ?? "running"}${s.outcome ? ` (${s.outcome})` : ""}`,
        ),
        "artifacts:",
        ...d.artifacts
          .filter((a) => a.type !== "tool-output")
          .map((a) => `  ${a.type}/${a.name}@${a.version}${a.approved ? " approved" : ""}`),
        ...d.interactions.map((i) => `thread ${i.id} ${i.kind} ${i.state}`),
      ].filter(Boolean);
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "context.inspect",
    {
      description:
        "The EngineeringContextPackage an agent would receive for this project: skills, standards, knowledge (ADR-0020).",
      inputSchema: {
        agent: z.string().min(1).optional(),
        paths: z.array(z.string()).optional(),
        kind: z.string().min(1).optional(),
        budget: z.number().int().positive().optional(),
      },
    },
    async ({ agent, paths, kind, budget }) => {
      const stacks = effectiveStacks(runtime.loaded.config.stack, projectRoot);
      const pkg = resolvePackage({
        roots,
        config: runtime.loaded.config.knowledge,
        task: {
          kind: kind ?? "change",
          affectedPaths: paths ?? [],
          stacks,
          agentId: agent ?? "implementation",
        },
      });
      const header = `stacks: ${stacks.join(", ") || "-"}; agent: ${agent ?? "implementation"}; provenance: ${pkg.provenance.join(", ") || "-"}`;
      return text(`${header}\n\n${renderPackage(pkg, budget ?? 12_000, runtime.loaded.config.knowledge)}`);
    },
  );
  return server;
}

export async function serveStdio(
  runtime: Runtime,
  projectRoot: string | undefined,
  version: string,
): Promise<void> {
  const server = buildMcpServer(runtime, projectRoot, version);
  await server.connect(new StdioServerTransport());
}

import type { Capability, ToolProvider } from "../../tools/types.ts";
import type { GraphStore } from "./store.ts";
import { impactOf, neighborsOf, repoIdOf } from "./update.ts";

/**
 * Graph capabilities for agents (ADR-0008, ADR-0021 §4): answered from the latest snapshot of the
 * workspace's repository; without one they say so instead of guessing.
 */
export class GraphToolProvider implements ToolProvider {
  readonly name = "graph";
  private readonly store: GraphStore;

  constructor(store: GraphStore) {
    this.store = store;
  }

  capabilities(): readonly Capability[] {
    const snapshot = (workspace: string) => {
      const latest = this.store.latest(repoIdOf(workspace));
      return latest ? this.store.load(latest.id) : undefined;
    };
    const missing = {
      ok: false,
      error: "no project graph snapshot for this workspace; run `jarvis knowledge update`",
    };
    return [
      {
        name: "graph.impact",
        description:
          "Who depends on these files (transitively) and which tests cover them, from the project graph.",
        network: "none",
        access: "read",
        effect: false,
        parameters: {
          type: "object",
          properties: { files: { type: "array", items: { type: "string" } }, depth: { type: "integer" } },
          required: ["files"],
        },
        handler: async (args, ctx) => {
          const s = snapshot(ctx.workspacePath);
          if (!s) return missing;
          const files = Array.isArray(args.files) ? args.files.map(String) : [];
          const result = impactOf(s, files, typeof args.depth === "number" ? args.depth : 3);
          const text = [
            `snapshot ${s.id} (${s.treeSha.slice(0, 10)}, ${s.nodes.length} nodes, ${s.edges.length} edges)`,
            `dependents (${result.dependents.length}):`,
            ...result.dependents.map((d) => `  ${d.file} (distance ${d.distance})`),
            `tests (${result.tests.length}):`,
            ...result.tests.map((t) => `  ${t}`),
            ...(result.unresolved.length > 0 ? [`unresolved imports: ${result.unresolved.join(", ")}`] : []),
          ].join("\n");
          return { ok: true, text, data: result };
        },
      },
      {
        name: "graph.neighbors",
        description: "Imports, importers, tests and symbols of one file, from the project graph.",
        network: "none",
        access: "read",
        effect: false,
        parameters: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
        handler: async (args, ctx) => {
          const s = snapshot(ctx.workspacePath);
          if (!s) return missing;
          const n = neighborsOf(s, String(args.file ?? ""));
          const text = [
            `imports: ${n.imports.join(", ") || "-"}`,
            `imported by: ${n.importedBy.join(", ") || "-"}`,
            `tests: ${n.tests.join(", ") || "-"}`,
            `symbols: ${n.symbols.join(", ") || "-"}`,
          ].join("\n");
          return { ok: true, text, data: n };
        },
      },
    ];
  }
}

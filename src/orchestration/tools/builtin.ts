import type { DeterministicTool } from "../executors.ts";

/**
 * Deterministic tools that need nothing but the stores. Repository, git, test and typecheck
 * tools arrive with the Tool Platform (stage 4).
 */
export const BUILTIN_TOOLS: Record<string, DeterministicTool> = {
  noop: async () => ({ status: "success" }),

  fail: async (_ctx, args) => ({ status: "failure", reason: String(args.reason ?? "failed on purpose") }),

  /** Writes a static artifact — used by the smoke workflow and by tests. */
  "artifact.write": async (ctx, args) => {
    const type = String(args.type ?? "note");
    const name = String(args.name ?? `${type}.md`);
    const content = String(args.content ?? "");
    const artifact = ctx.runtime.artifacts.put({
      runId: ctx.run.id,
      type,
      name,
      content,
      provenance: { kind: "tool", capability: "artifact.write" },
      stepId: ctx.step.id,
      iteration: ctx.iteration,
    });
    return { status: "success", outputs: [`${artifact.artifactId}@${artifact.version}`] };
  },
};

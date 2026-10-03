import { effectiveStacks } from "../capabilities/detector.ts";
import { type EngineeringContextPackage, resolvePackage } from "../knowledge/resolver.ts";
import type { StepContext } from "../orchestration/types.ts";

/** Task kind from the task id/title: ABC-42 says nothing, so "change" unless the run says otherwise. */
export function taskKindOf(ctx: StepContext): string {
  const hint = String((ctx.run as { kind?: string }).kind ?? "");
  return hint || "change";
}

/** Affected paths from the latest impact artifact of the run (empty before impact analysis). */
export function affectedPathsOf(ctx: StepContext): string[] {
  const impact = ctx.runtime.artifacts.listLatest(ctx.run.id, "impact")[0];
  if (!impact) return [];
  try {
    const doc = JSON.parse(ctx.runtime.artifacts.text(impact)) as { affected?: Array<{ path?: string }> };
    return (doc.affected ?? []).map((a) => a.path).filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

export function packageForStep(ctx: StepContext, agentId: string): EngineeringContextPackage {
  const workspace = ctx.workspace.ref.path;
  const home = ctx.runtime.loaded.home.root;
  return resolvePackage({
    roots: { projectRoot: workspace, userRoot: home },
    config: ctx.runtime.loaded.config.knowledge,
    task: {
      kind: taskKindOf(ctx),
      affectedPaths: affectedPathsOf(ctx),
      stacks: effectiveStacks(ctx.runtime.loaded.config.stack, workspace),
      agentId,
    },
  });
}

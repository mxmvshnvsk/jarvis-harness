import { effectiveStacks } from "../capabilities/detector.ts";
import { type EngineeringContextPackage, resolvePackage } from "../knowledge/resolver.ts";
import { rankKnowledge, refreshIndex } from "../knowledge/retrieval/service.ts";
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

/** The retrieval query of a run: task key plus the latest requirements/spec titles and texts. */
export function queryOf(ctx: StepContext): string {
  const parts = [ctx.run.task];
  for (const type of ["requirements", "spec"]) {
    const a = ctx.runtime.artifacts.listLatest(ctx.run.id, type)[0];
    if (!a) continue;
    try {
      const doc = JSON.parse(ctx.runtime.artifacts.text(a)) as {
        title?: string;
        goals?: string[];
        requirements?: Array<{ text?: string }>;
        businessRules?: string[];
      };
      parts.push(
        doc.title ?? "",
        ...(doc.goals ?? []),
        ...(doc.businessRules ?? []),
        ...(doc.requirements ?? []).map((r) => r.text ?? ""),
      );
    } catch {
      // not JSON
    }
  }
  return parts.filter(Boolean).join("\n").slice(0, 4000);
}

export async function packageForStep(ctx: StepContext, agentId: string): Promise<EngineeringContextPackage> {
  const workspace = ctx.workspace.ref.path;
  const home = ctx.runtime.loaded.home.root;
  const roots = { projectRoot: workspace, userRoot: home };
  const pkg = resolvePackage({
    roots,
    config: ctx.runtime.loaded.config.knowledge,
    task: {
      kind: taskKindOf(ctx),
      affectedPaths: affectedPathsOf(ctx),
      stacks: effectiveStacks(ctx.runtime.loaded.config.stack, workspace),
      agentId,
    },
  });
  if (pkg.knowledge.length <= ctx.runtime.loaded.config.knowledge.retrieval.rankAbove) return pkg;
  // ADR-0015: the index keeps pace with the project and the run before it ranks.
  await refreshIndex(ctx.runtime, roots, ctx.run.id);
  const ranked = await rankKnowledge(ctx.runtime, roots, pkg.knowledge, queryOf(ctx));
  if (ranked.result) {
    ctx.runtime.events.emit({
      kind: "retrieval.knowledge",
      runId: ctx.run.id,
      stepId: ctx.step.id,
      iteration: ctx.iteration,
      payload: {
        agent: agentId,
        indexes: ranked.result.indexes,
        expansions: ranked.result.expansions,
        order: ranked.docs.map((d) => d.name),
        paths: ranked.result.evidence.map((e) => ({ ref: e.ref, path: e.retrievalPath })),
      },
    });
  }
  return {
    ...pkg,
    knowledge: ranked.docs,
    provenance: [
      ...pkg.provenance.filter((p) => !p.startsWith("knowledge:")),
      ...ranked.docs.map((k) => `knowledge:${k.name}#${k.sha}`),
    ],
  };
}

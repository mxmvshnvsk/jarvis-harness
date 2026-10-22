import { existsSync } from "node:fs";
import { join } from "node:path";
import { staleCommitsOf } from "../app/knowledgeView.ts";
import { type KindChoice, kindOfTask } from "../app/taskKind.ts";
import { detectStackScopes, effectiveStacks, stacksForPaths } from "../capabilities/detector.ts";
import type { TaskKind } from "../core/domain/run.ts";
import { layoutOf, rootRelative } from "../core/paths.ts";
import {
  type EngineeringContextPackage,
  resolvePackage,
  SHARED_KNOWLEDGE_PREFIX,
} from "../knowledge/resolver.ts";
import { loadGlossary, matchTerms } from "../knowledge/retrieval/glossary.ts";
import { rankKnowledge, refreshIndex } from "../knowledge/retrieval/service.ts";
import { skillRef } from "../knowledge/skills.ts";
import { knowledgeRootsOf } from "../knowledge/sources.ts";
import type { StepContext } from "../orchestration/types.ts";

/**
 * The kind of task (ADR-0020 §1) and what decided it: the person's pick, the workflow's own kind, the
 * words of the task, else `change` (src/app/taskKind.ts) — the same rules the page shows as it is typed.
 */
export function taskKindChoiceOf(ctx: Pick<StepContext, "run" | "workflow">): KindChoice {
  return kindOfTask({ task: ctx.run.task, picked: ctx.run.options?.kind, workflowKind: ctx.workflow.kind });
}

export function taskKindOf(ctx: Pick<StepContext, "run" | "workflow">): TaskKind {
  return taskKindChoiceOf(ctx).kind;
}

/**
 * Affected paths from the latest impact artifact of the run; before impact analysis, the `scope`
 * artifact a run may start with (`onboard --module` writes the module there); otherwise empty.
 */
export function affectedPathsOf(ctx: StepContext): string[] {
  const impact = ctx.runtime.artifacts.listLatest(ctx.run.id, "impact")[0];
  if (!impact) return scopePathsOf(ctx);
  try {
    const doc = JSON.parse(ctx.runtime.artifacts.text(impact)) as { affected?: Array<{ path?: string }> };
    return (doc.affected ?? []).map((a) => a.path).filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

/** Paths of the run's `scope` artifact — a directory as `dir/`, so `dir/**` scopes match it. */
function scopePathsOf(ctx: StepContext): string[] {
  const scope = ctx.runtime.artifacts.listLatest(ctx.run.id, "scope")[0];
  if (!scope) return [];
  try {
    const doc = JSON.parse(ctx.runtime.artifacts.text(scope)) as { paths?: unknown };
    return Array.isArray(doc.paths) ? doc.paths.filter((p): p is string => typeof p === "string") : [];
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

async function packageRanked(
  ctx: StepContext,
  agentId: string,
  paths?: readonly string[],
): Promise<EngineeringContextPackage> {
  const workspace = ctx.workspace.ref.path;
  const roots = knowledgeRootsOf(ctx.runtime.loaded, workspace);
  // the plan step's files when the agent works one (its documents, not the whole change's)
  const affectedPaths = paths ? [...paths] : affectedPathsOf(ctx);
  const config = ctx.runtime.loaded.config;
  // ADR-0021 §9: in a polyglot repository the affected scope decides which stack packs apply.
  const stacks = stacksForPaths(
    affectedPaths,
    detectStackScopes(workspace, config.stackScopes),
    effectiveStacks(config.stack, workspace),
  );
  const pkg = resolvePackage({
    roots,
    config: config.knowledge,
    task: { kind: taskKindOf(ctx), affectedPaths, stacks, agentId },
    ...(ctx.step.skills ? { stepSkills: ctx.step.skills } : {}),
  });
  // which skills the agent got and why, for the run's page (src/ui/model.ts)
  ctx.runtime.events.emit({
    kind: "context.skills",
    runId: ctx.run.id,
    stepId: ctx.step.id,
    iteration: ctx.iteration,
    payload: {
      agent: agentId,
      skills: pkg.skills.map(skillRef),
      how: pkg.skillsBy.how,
      ...(pkg.skillsBy.missing ? { missing: pkg.skillsBy.missing } : {}),
      kind: pkg.task.kind,
      kindBy: taskKindChoiceOf(ctx).by,
      stacks: pkg.task.stacks,
      paths: affectedPaths.length,
      onRequest: pkg.deferredSkills.map(skillRef),
    },
  });
  // the glossary's words the task uses, with the code they live in (whole words, not inside others)
  const terms = matchTerms(queryOf(ctx), loadGlossary(workspace)).slice(0, 20);
  const withTerms = terms.length > 0 ? { ...pkg, terms } : pkg;
  if (pkg.knowledge.length <= ctx.runtime.loaded.config.knowledge.retrieval.rankAbove) return withTerms;
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
    ...withTerms,
    knowledge: ranked.docs,
    provenance: [
      ...pkg.provenance.filter((p) => !p.startsWith("knowledge:")),
      ...ranked.docs.map((k) => `knowledge:${k.name}#${k.sha}`),
    ],
  };
}

/** Path-scoped documents looked at for staleness per step: the first ones, which the agent sees. */
const STALE_CHECKED = 12;

export async function packageForStep(
  ctx: StepContext,
  agentId: string,
  options: { paths?: readonly string[] } = {},
): Promise<EngineeringContextPackage> {
  const pkg = await packageRanked(ctx, agentId, options.paths);
  // a document whose code moved on since its last edit is said to be so (it was only on the UI's page)
  const root = ctx.workspace.ref.path;
  const layout = layoutOf(root);
  const fileOf = (name: string) =>
    name.startsWith(SHARED_KNOWLEDGE_PREFIX) && layout.meta
      ? join(layout.meta.knowledgeRoot, name.slice(SHARED_KNOWLEDGE_PREFIX.length))
      : existsSync(join(layout.knowledgeDir, name))
        ? join(layout.knowledgeDir, name)
        : join(root, name);
  const knowledge = await Promise.all(
    pkg.knowledge.map(async (d, i) => {
      if (i >= STALE_CHECKED || d.scope.paths.length === 0) return d;
      const n = await staleCommitsOf(root, rootRelative(root, fileOf(d.name)), d.scope.paths, d.sha).catch(
        () => undefined,
      );
      return n && n > 0 ? { ...d, staleCommits: n } : d;
    }),
  );
  return { ...pkg, knowledge };
}

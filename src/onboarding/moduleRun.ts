import type { Runtime } from "../app/runtime.ts";
import type { DeterministicTool } from "../orchestration/executors.ts";
import { renderModuleDoc } from "./render.ts";
import type { ModuleFacts } from "./scan.ts";
import { type Dropped, type ModuleMapDoc, verifyModuleMap } from "./verify.ts";

/**
 * The parts of an `onboard-module` run that the `verify` step and the pages read: what the run maps
 * (`module-input`), what the check found (`module-check`). Kept apart from `deep.ts`, which drives
 * the engine: the built-in tools import this file, and the engine imports the built-in tools.
 */
/** What the run is about: the `module-input` artifact the `verify` step reads. */
export interface ModuleInput {
  readonly module: string;
  readonly facts?: ModuleFacts | undefined;
  /** What matters to the person who asked (the page's "What matters", `--note`). */
  readonly note?: string | undefined;
}

/** What `verify` found: the `module-check` artifact (also when nothing survived). */
export interface ModuleCheck {
  readonly module: string;
  readonly claims: { readonly proposed: number; readonly kept: number; readonly sweeping: number };
  readonly dropped: readonly Dropped[];
  readonly sweeping: readonly string[];
  readonly candidateId?: string;
}

function json<T>(runtime: Runtime, runId: string, type: string): T | undefined {
  const artifact = runtime.artifacts.listLatest(runId, type).at(-1);
  if (!artifact) return undefined;
  try {
    return JSON.parse(runtime.artifacts.text(artifact)) as T;
  } catch {
    return undefined;
  }
}

/** The module a run of `onboard-module` maps: its input, or the scope of an older run. */
export function moduleOfRun(runtime: Runtime, runId: string): ModuleInput | undefined {
  const input = json<ModuleInput>(runtime, runId, "module-input");
  if (input?.module) return input;
  const scope = json<{ paths?: string[] }>(runtime, runId, "scope");
  const path = scope?.paths?.[0]?.replace(/\/+$/, "");
  return path ? { module: path } : undefined;
}

/** What the `verify` step of a run found, if it ran. */
export function moduleCheckOf(runtime: Runtime, runId: string): ModuleCheck | undefined {
  return json<ModuleCheck>(runtime, runId, "module-check");
}

/**
 * The `verify` step (deterministic): the mapper's claims against the files they cite. Writes
 * `module-check` always and the `candidate` when something survived; fails when nothing did.
 */
export const verifyModuleStep: DeterministicTool = async (ctx) => {
  const { runtime, run } = ctx;
  const input = moduleOfRun(runtime, run.id);
  const map = json<ModuleMapDoc>(runtime, run.id, "module-map");
  if (!input) return { status: "failure", reason: "the run does not say which module it maps" };
  if (!map) return { status: "failure", reason: "the mapper left no module-map" };
  const module = input.module;
  const verified = verifyModuleMap(
    { ...map, module },
    { root: run.workspace.path, isDenied: (rel) => runtime.pathPolicy.isDenied(rel) },
  );
  const count = (d: Pick<ModuleMapDoc, "publicApi" | "responsibilities" | "rules" | "terms">) =>
    (d.publicApi?.length ?? 0) +
    (d.responsibilities?.length ?? 0) +
    (d.rules?.length ?? 0) +
    (d.terms?.length ?? 0);
  const proposed = count(map);
  const kept = count(verified);
  const sweeping = [...verified.responsibilities, ...verified.rules]
    .filter((c) => c.sweeping)
    .map((c) => c.statement);
  const claims = { proposed, kept, sweeping: sweeping.length };
  const survived = verified.responsibilities.length + verified.rules.length + verified.publicApi.length;
  const put = (check: ModuleCheck) =>
    runtime.artifacts.put({
      runId: run.id,
      type: "module-check",
      name: "module-check.json",
      content: JSON.stringify(check, null, 2),
      mediaType: "application/json",
      provenance: { kind: "tool", capability: "onboard.verify" },
      stepId: ctx.step.id,
      iteration: ctx.iteration,
    });
  if (survived === 0) {
    const check = put({ module, claims, dropped: verified.dropped, sweeping });
    return {
      status: "failure",
      reason: "no claim survived verification against the code",
      outputs: [`${check.artifactId}@${check.version}`],
    };
  }
  const markdown = renderModuleDoc(verified, input.facts);
  const evidence = [
    ...new Set(
      [...verified.responsibilities, ...verified.rules].flatMap((c) =>
        c.evidence.map((e) => `${e.file}:${e.line}`),
      ),
    ),
  ];
  const mapArtifact = runtime.artifacts.listLatest(run.id, "module-map").at(-1);
  const candidate = runtime.artifacts.put({
    runId: run.id,
    type: "candidate",
    name: `onboard-${module.replace(/[^\w-]+/g, "-")}.json`,
    content: JSON.stringify(
      {
        kind: "knowledge",
        title: `module ${module}`,
        module,
        claims: { proposed, kept, dropped: verified.dropped.length },
        review: sweeping,
        dropped: verified.dropped,
        rationale: `Mapped by the onboarding agent; ${kept} of ${proposed} claims were confirmed against the code, ${verified.dropped.length} dropped${sweeping.length > 0 ? `; ${sweeping.length} generalise beyond their excerpts — check those (marked) before promoting` : ""}.`,
        evidence,
        proposal: markdown,
        paths: [`${module}/**`],
        ...(mapArtifact ? { from: `${mapArtifact.artifactId}@${mapArtifact.version}` } : {}),
        ...(input.note ? { note: input.note } : {}),
        status: "proposed",
      },
      null,
      2,
    ),
    mediaType: "application/json",
    provenance: { kind: "tool", capability: "onboard.verify" },
    sourceRefs: evidence,
    stepId: ctx.step.id,
    iteration: ctx.iteration,
  });
  const check = put({
    module,
    claims,
    dropped: verified.dropped,
    sweeping,
    candidateId: candidate.artifactId,
  });
  return {
    status: "success",
    outputs: [`${candidate.artifactId}@${candidate.version}`, `${check.artifactId}@${check.version}`],
  };
};

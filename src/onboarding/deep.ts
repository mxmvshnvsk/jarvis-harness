import { createEngine } from "../app/engine.ts";
import type { Runtime } from "../app/runtime.ts";
import { resolveActor } from "../core/actor/resolve.ts";
import { leaseOwner } from "../orchestration/lease.ts";
import { newRunId } from "../storage/runStore.ts";
import { git } from "../tools/local/exec.ts";
import { renderModuleDoc } from "./render.ts";
import type { ModuleFacts } from "./scan.ts";
import { type Dropped, type ModuleMapDoc, verifyModuleMap } from "./verify.ts";

/**
 * Agent mode of `jarvis onboard` (prototype: one module). The `onboard-module` workflow runs the
 * mapper; its claims are checked mechanically against the files; what survives becomes a knowledge
 * `candidate` that waits for a human (`jarvis candidates promote`) — nothing is written to the
 * project by the agent.
 */
export interface MapModuleResult {
  readonly runId: string;
  readonly state: string;
  readonly module: string;
  readonly candidateId?: string;
  readonly claims: { readonly proposed: number; readonly kept: number };
  readonly dropped: readonly Dropped[];
  readonly doc?: string;
  readonly problem?: string;
}

export interface MapModuleOptions {
  readonly root: string;
  readonly module: string;
  readonly facts?: ModuleFacts | undefined;
  readonly env: NodeJS.ProcessEnv;
}

export function taskFor(module: string, facts?: ModuleFacts): string {
  const lines = [`Map the module \`${module}\` of this repository for onboarding.`];
  if (facts) {
    lines.push(
      `Deterministic facts: ${facts.files} files, about ${facts.lines} lines (${facts.languages.join(", ") || "n/a"}).`,
      `Depends on: ${facts.dependsOn.join(", ") || "nothing in the project"}.`,
      `Used by: ${facts.usedBy.join(", ") || "nothing found"}.`,
    );
  }
  lines.push(`Stay inside \`${module}\` except to see how it is used.`);
  return lines.join("\n");
}

export async function mapModule(runtime: Runtime, options: MapModuleOptions): Promise<MapModuleResult> {
  const empty = { proposed: 0, kept: 0 };
  const resolved = await resolveActor(runtime.loaded.config, options.env, options.root);
  if (!resolved.actor)
    return {
      runId: "",
      state: "NOT_STARTED",
      module: options.module,
      claims: empty,
      dropped: [],
      problem: "cannot determine the actor (JARVIS_ACTOR, actor.id or git config user.email)",
    };
  const head = (await git(["rev-parse", "HEAD"], options.root)).stdout.trim();
  const run = runtime.runs.create({
    id: newRunId(),
    task: taskFor(options.module, options.facts),
    workflow: "onboard-module",
    owner: resolved.actor,
    workspace: {
      mode: "cwd",
      repoRoot: options.root,
      path: options.root,
      baseRef: head,
      baseCommit: head,
      headCommit: head,
    },
    dataClass: runtime.loaded.config.dataClass,
    ...(runtime.loaded.config.profile ? { profile: runtime.loaded.config.profile } : {}),
  });
  // the module is the run's scope: knowledge and skills scoped to other paths stay out of its context
  runtime.artifacts.put({
    runId: run.id,
    type: "scope",
    name: "scope.json",
    content: JSON.stringify({ paths: [`${options.module}/`] }),
    mediaType: "application/json",
    provenance: { kind: "tool", capability: "onboard.module" },
  });
  runtime.events.emit({
    kind: "run.created",
    runId: run.id,
    actor: `${resolved.actor.kind}:${resolved.actor.id}`,
    payload: { task: run.task, workflow: "onboard-module", trigger: "onboard", module: options.module },
  });
  const result = await createEngine(runtime).execute(run.id, { owner: leaseOwner("cli"), steal: false });
  const artifact = runtime.artifacts.listLatest(run.id, "module-map").at(-1);
  if (result.run.state !== "COMPLETED" || !artifact)
    return {
      runId: run.id,
      state: result.run.state,
      module: options.module,
      claims: empty,
      dropped: [],
      problem: `the mapping run ended ${result.run.state}${result.run.stateReason ? `: ${result.run.stateReason}` : ""}`,
    };

  const doc = JSON.parse(runtime.artifacts.text(artifact)) as ModuleMapDoc;
  const verified = verifyModuleMap(
    { ...doc, module: options.module },
    { root: options.root, isDenied: (rel) => runtime.pathPolicy.isDenied(rel) },
  );
  const proposed = doc.publicApi.length + doc.responsibilities.length + doc.rules.length + doc.terms.length;
  const kept =
    verified.publicApi.length +
    verified.responsibilities.length +
    verified.rules.length +
    verified.terms.length;
  const claims = { proposed, kept };
  const survived = verified.responsibilities.length + verified.rules.length + verified.publicApi.length;
  if (survived === 0)
    return {
      runId: run.id,
      state: result.run.state,
      module: options.module,
      claims,
      dropped: verified.dropped,
      problem: "no claim survived verification against the code",
    };

  const markdown = renderModuleDoc(verified, options.facts);
  const evidence = [
    ...new Set(
      [...verified.responsibilities, ...verified.rules].flatMap((c) =>
        c.evidence.map((e) => `${e.file}:${e.line}`),
      ),
    ),
  ];
  const candidate = runtime.artifacts.put({
    runId: run.id,
    type: "candidate",
    name: `onboard-${options.module.replace(/[^\w-]+/g, "-")}.json`,
    content: JSON.stringify(
      {
        kind: "knowledge",
        title: `module ${options.module}`,
        rationale: `Mapped by the onboarding agent; ${kept} of ${proposed} claims were confirmed against the code, ${verified.dropped.length} dropped.`,
        evidence,
        proposal: markdown,
        paths: [`${options.module}/**`],
        from: `${artifact.artifactId}@${artifact.version}`,
        status: "proposed",
      },
      null,
      2,
    ),
    mediaType: "application/json",
    provenance: { kind: "agent", agentId: "onboard-mapper" },
    sourceRefs: evidence,
    stepId: "map",
    iteration: 1,
  });
  return {
    runId: run.id,
    state: result.run.state,
    module: options.module,
    candidateId: candidate.artifactId,
    claims,
    dropped: verified.dropped,
    doc: markdown,
  };
}

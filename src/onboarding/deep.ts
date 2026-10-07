import { createEngine } from "../app/engine.ts";
import type { Runtime } from "../app/runtime.ts";
import { resolveActor } from "../core/actor/resolve.ts";
import type { Run } from "../core/domain/run.ts";
import { leaseOwner } from "../orchestration/lease.ts";
import { newRunId } from "../storage/runStore.ts";
import { git } from "../tools/local/exec.ts";
import { type ModuleInput, moduleCheckOf, moduleOfRun } from "./moduleRun.ts";
import type { ModuleFacts } from "./scan.ts";
import type { Dropped } from "./verify.ts";

/**
 * Agent mode of `jarvis onboard` (one module, or a folder inside one). The `onboard-module` workflow
 * runs the mapper (`map`), then checks its claims mechanically against the files (`verify`, no
 * model); what survives becomes a knowledge `candidate` that waits for a human (`jarvis candidates
 * promote`, or Accept on the Modules page) — nothing is written to the project by the agent. The
 * check is a step of the run, not of the command that started it: a run started from `jarvis ui`,
 * parked on a budget and resumed later still ends with its candidate.
 */
export interface MapModuleResult {
  readonly runId: string;
  readonly state: string;
  readonly module: string;
  readonly candidateId?: string;
  readonly claims: { readonly proposed: number; readonly kept: number; readonly sweeping?: number };
  readonly dropped: readonly Dropped[];
  /** Kept claims that generalise beyond their excerpts — what the reviewer reads first. */
  readonly sweeping?: readonly string[];
  readonly doc?: string;
  readonly problem?: string;
}

export interface MapModuleOptions {
  readonly root: string;
  readonly module: string;
  readonly facts?: ModuleFacts | undefined;
  readonly note?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

export const NOTE_MAX = 2000;

export function taskFor(module: string, facts?: ModuleFacts, note?: string): string {
  const lines = [`Map the module \`${module}\` of this repository for onboarding.`];
  if (facts) {
    lines.push(
      `Deterministic facts: ${facts.files} files, about ${facts.lines} lines (${facts.languages.join(", ") || "n/a"}).`,
      `Depends on: ${facts.dependsOn.join(", ") || "nothing in the project"}.`,
      `Used by: ${facts.usedBy.join(", ") || "nothing found"}.`,
    );
  }
  lines.push(`Stay inside \`${module}\` except to see how it is used.`);
  const said = note?.trim().slice(0, NOTE_MAX);
  if (said) lines.push("", "What matters to the person who asked:", said);
  return lines.join("\n");
}

/** Creates the run: its scope is the module, its input says what to map. Not executed here. */
export async function startModuleMap(
  runtime: Runtime,
  options: MapModuleOptions,
): Promise<{ run: Run } | { problem: string }> {
  const resolved = await resolveActor(runtime.loaded.config, options.env, options.root);
  if (!resolved.actor)
    return { problem: "cannot determine the actor (JARVIS_ACTOR, actor.id or git config user.email)" };
  const head = (await git(["rev-parse", "HEAD"], options.root)).stdout.trim();
  const note = options.note?.trim().slice(0, NOTE_MAX) || undefined;
  const run = runtime.runs.create({
    id: newRunId(),
    task: taskFor(options.module, options.facts, note),
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
  const input: ModuleInput = {
    module: options.module,
    ...(options.facts ? { facts: options.facts } : {}),
    ...(note ? { note } : {}),
  };
  runtime.artifacts.put({
    runId: run.id,
    type: "module-input",
    name: "module.json",
    content: JSON.stringify(input, null, 2),
    mediaType: "application/json",
    provenance: { kind: "tool", capability: "onboard.module" },
  });
  runtime.events.emit({
    kind: "run.created",
    runId: run.id,
    actor: `${resolved.actor.kind}:${resolved.actor.id}`,
    payload: {
      task: run.task,
      workflow: "onboard-module",
      trigger: "onboard",
      module: options.module,
      ...(note ? { note: true } : {}),
    },
  });
  return { run };
}

/** What a finished (or stopped) run of `onboard-module` came to, for the CLI and the page. */
export function mapResultOf(runtime: Runtime, run: Run): MapModuleResult {
  const module = moduleOfRun(runtime, run.id)?.module ?? "";
  const check = moduleCheckOf(runtime, run.id);
  const base = {
    runId: run.id,
    state: run.state,
    module,
    claims: check?.claims ?? { proposed: 0, kept: 0 },
    dropped: check?.dropped ?? [],
    ...(check && check.sweeping.length > 0 ? { sweeping: check.sweeping } : {}),
  };
  if (check?.candidateId) {
    const candidate = runtime.artifacts
      .listLatest(run.id, "candidate")
      .find((a) => a.artifactId === check.candidateId);
    let doc: string | undefined;
    try {
      doc = candidate
        ? (JSON.parse(runtime.artifacts.text(candidate)) as { proposal?: string }).proposal
        : undefined;
    } catch {
      doc = undefined;
    }
    return { ...base, candidateId: check.candidateId, ...(doc ? { doc } : {}) };
  }
  if (check) return { ...base, problem: "no claim survived verification against the code" };
  return {
    ...base,
    problem: `the mapping run ended ${run.state}${run.stateReason ? `: ${run.stateReason}` : ""}`,
  };
}

/** `jarvis onboard --module`: create the run and drive it to its candidate here. */
export async function mapModule(runtime: Runtime, options: MapModuleOptions): Promise<MapModuleResult> {
  const started = await startModuleMap(runtime, options);
  if ("problem" in started)
    return {
      runId: "",
      state: "NOT_STARTED",
      module: options.module,
      claims: { proposed: 0, kept: 0 },
      dropped: [],
      problem: started.problem,
    };
  const result = await createEngine(runtime).execute(started.run.id, {
    owner: leaseOwner("cli"),
    steal: false,
  });
  return mapResultOf(runtime, result.run);
}

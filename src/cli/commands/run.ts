import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clock } from "../../app/activity.ts";
import { applyRun } from "../../app/applyRun.ts";
import { changedSince, filesReadIn, nextWorkflowOf } from "../../app/continuation.ts";
import { awaitedArtifact, DecisionTakenError, recordDecision } from "../../app/decide.ts";
import { DeliveryError, deliverPr, PR_REQUEST, preparePr, prOf, prPolicy } from "../../app/deliver.ts";
import { createEngine } from "../../app/engine.ts";
import { canForget, forgetRuns } from "../../app/forget.ts";
import { continuationStep, continuedBy, handOff } from "../../app/handoff.ts";
import { duration } from "../../app/journey.ts";
import { preflightMcp, preflightModels, workflowRunsProjectCommands } from "../../app/preflight.ts";
import { noteForStart, requestRedo } from "../../app/redo.ts";
import { carriedSteps, RESTARTABLE, restartPlanOf } from "../../app/restart.ts";
import { createRuntime, type Runtime } from "../../app/runtime.ts";
import { runDetail } from "../../app/status.ts";
import { afterRunStops, CROSS_WORKFLOWS, workflowHere } from "../../app/subtasks.ts";
import { EDITABLE_TYPES, editableFile, isEditable, syncEditable } from "../../artifacts/editable.ts";
import type { Approval } from "../../artifacts/store.ts";
import { resolveActor } from "../../core/actor/resolve.ts";
import type { Actor } from "../../core/domain/actor.ts";
import type { ApprovalDecision } from "../../core/domain/artifact.ts";
import type { FreshSource, Run, TaskKind, WorkspaceRef } from "../../core/domain/run.ts";
import { layoutOf, rootRelative, versionedAt } from "../../core/paths.ts";
import { recordInputs, recordKnowledgeRepoInputs } from "../../evals/inputs.ts";
import { daemonTick } from "../../orchestration/daemon.ts";
import { UnresolvedEffectError } from "../../orchestration/effects.ts";
import { interruption } from "../../orchestration/interrupt.ts";
import { leaseOwner } from "../../orchestration/lease.ts";
import { exitCodeFor, type LocalWorkflowEngine } from "../../orchestration/runtime.ts";
import { LeaseHeldError } from "../../orchestration/types.ts";
import { gitIdentityEnv, WorktreeError, WorktreeWorkspace } from "../../orchestration/worktree.ts";
import { effectMarker } from "../../storage/effects.ts";
import { LeaseLostError, newRunId, shortRunId } from "../../storage/runStore.ts";
import { git } from "../../tools/local/exec.ts";
import {
  askCardToGoOn,
  changesIn,
  checkoutLink,
  describeFiles,
  formatChanges,
  type OpenIn,
  reviewFiles,
  type ShellIn,
  systemOpener,
  systemShell,
} from "../checkout.ts";
import type { CliContext } from "../context.ts";
import { humanGate, systemEditor } from "../gate.ts";
import { CliExit, EXIT } from "../output.ts";
import { waitParked } from "../parked.ts";
import { followRun, formatRunHeader, oneLine } from "../progress.ts";
import { createPrompt, isInteractive, type Prompt } from "../prompt.ts";
import { documentToMarkdown, renderDiff, renderMarkdown } from "../render.ts";
import { incompleteOf, padStyled } from "../style.ts";
import { artifactLink } from "../view.ts";
import { loadForCli } from "./config.ts";
import { renderSummary } from "./status.ts";

export async function actorFor(ctx: CliContext, runtime: Runtime): Promise<Actor> {
  const resolved = await resolveActor(runtime.loaded.config, ctx.env, runtime.loaded.project?.root);
  if (!resolved.actor) {
    ctx.out.error(
      "cannot determine the actor: set JARVIS_ACTOR, actor.id or git config user.email (ADR-0006)",
    );
    throw new CliExit(EXIT.error);
  }
  return resolved.actor;
}

export function requireRun(ctx: CliContext, runtime: Runtime, ref: string): Run {
  const run = runtime.runs.resolve(ref);
  if (!run) {
    ctx.out.error(`run "${ref}" not found (see \`jarvis status --all\`)`);
    throw new CliExit(EXIT.error);
  }
  return run;
}

export async function executeAndReport(
  ctx: CliContext,
  runtime: Runtime,
  engine: LocalWorkflowEngine,
  run: Run,
  steal: boolean,
  extra: Record<string, unknown> = {},
  /** The caller's prompt (`continue` asked already); otherwise one is opened for a person at a TTY. */
  shared?: Prompt,
  /** false when the caller has shown the run already. */
  showHeader = true,
  /** The run goes on in another process (the card saw it move): follow it, do not execute. */
  followFirst = false,
): Promise<never> {
  const owner = leaseOwner(runtime.loaded.config.interactive ? "cli" : "ci");
  const plan = planOf(engine, run);
  // a person at a terminal decides where the run stops and it goes on; otherwise exit 10 + commands
  const prompt = shared ?? promptFor(ctx, runtime);
  interruption.reset();
  try {
    let header = showHeader;
    let stealLease = steal;
    let following = followFirst;
    /** A card let the run go on: another process may have taken it meanwhile (ADR-0023 §4). */
    let afterCard = false;
    for (;;) {
      let result: { run: Run; exitCode: number };
      if (following) {
        following = false;
        const followed = await followElsewhere(ctx, runtime, run.id, plan, { header: false, graceTicks: 3 });
        if (followed.detached) {
          ctx.out.note(`detached; the run goes on — \`jarvis follow ${shortRunId(run.id)}\` to come back`);
          throw new CliExit(EXIT.ok);
        }
        result = { run: followed.run, exitCode: exitCodeFor(followed.run.state, followed.run.stateReason) };
      } else {
        const progress = followRun(ctx, runtime, { runId: run.id, plan, header });
        try {
          result = await engine.execute(run.id, { owner, steal: stealLease }).finally(() => progress.stop());
        } catch (error) {
          // the decision came with a `--resume` elsewhere, and that process won the lease: follow it
          if (!(afterCard && error instanceof LeaseHeldError)) throw error;
          ctx.out.line(
            `${ctx.out.style.warn("↻")} the run went on elsewhere ${ctx.out.style.muted("— following it here")}`,
          );
          following = true;
          afterCard = false;
          continue;
        }
      }
      header = false;
      stealLease = false;
      afterCard = false;
      // a model that is down or a quota window: wait here and go on (Ctrl-C leaves it parked)
      if (prompt && result.run.state === "WAITING_BUDGET") {
        if ((await waitParked(ctx, runtime, result.run)) === "ready") continue;
      }
      if (prompt && result.exitCode === EXIT.waitingHuman) {
        const actor = await actorFor(ctx, runtime);
        const gate = await humanGate(ctx, runtime, result.run, actor, prompt);
        if (gate === "decided") {
          afterCard = true;
          continue;
        }
        if (gate === "elsewhere") {
          following = true;
          continue;
        }
        ctx.out.line(
          `${ctx.out.style.muted("left waiting; come back with")} ${ctx.out.style.cmd("jarvis continue")}`,
        );
      }
      // a subtask that stopped frees its slot for the next; all done, the master goes on (ADR-0025 §6)
      await afterRunStops(runtime, runtime.runs.get(result.run.id) ?? result.run);
      const detail = runDetail(runtime, result.run);
      const goOn =
        result.run.state === "COMPLETED" && !continuedBy(runtime, result.run)
          ? nextWorkflowOf(engine, result.run)
          : undefined;
      ctx.out.result({ ...extra, ...detail, exitCode: result.exitCode }, () =>
        renderSummary(ctx, detail, {
          ...(goOn ? { goOn } : {}),
          link: (a, label) => artifactLink(ctx.out.style, runtime, a, label),
        }),
      );
      // an approved spec goes on to the implementation in the same command (pilot: the run just ended)
      if (prompt && result.run.state === "COMPLETED" && !continuedBy(runtime, result.run)) {
        const rest = restOf(engine, result.run);
        if (rest) {
          const st = ctx.out.style;
          ctx.out.line();
          ctx.out.line(`${st.heading("Go on to the implementation?")} ${st.muted(rest)}`);
          const answer = (await prompt.ask(`${st.cmd("[Y/n] >")} `))?.toLowerCase();
          if (
            answer !== undefined &&
            (answer === "" || answer === "y" || answer === "yes" || answer === "д" || answer === "да")
          ) {
            const next = await startContinuation(ctx, runtime, engine, result.run, prompt);
            if (next) await executeAndReport(ctx, runtime, engine, next, false, {}, prompt);
          } else
            ctx.out.line(`${st.muted("later:")} ${st.cmd(`jarvis continue ${shortRunId(result.run.id)}`)}`);
        }
      }
      throw new CliExit(result.exitCode);
    }
  } catch (error) {
    if (error instanceof LeaseHeldError) {
      ctx.out.error(error.message);
      throw new CliExit(EXIT.error);
    }
    if (error instanceof LeaseLostError) {
      ctx.out.error(error.message);
      throw new CliExit(EXIT.leaseLost);
    }
    throw error;
  } finally {
    if (!shared) prompt?.close();
  }
}

/**
 * Follows a run another process drives (another terminal, the daemon) until it stops running —
 * parked, finished, failed, or its process died; Ctrl-C only detaches. `jarvis follow`, and a card
 * that saw its run go on elsewhere (ADR-0023 §4): the terminal never takes a lease it did not win.
 */
async function followElsewhere(
  ctx: CliContext,
  runtime: Runtime,
  runId: string,
  plan: readonly string[],
  options: { header: boolean; pollMs?: number; graceTicks?: number },
): Promise<{ run: Run; detached: boolean }> {
  const alive = (r: Run) => r.lease !== undefined && Date.parse(r.lease.until) >= Date.now();
  // the course since the run last stopped for a person: the step lines of what ran meanwhile
  const parks = runtime.events
    .list({ runId, kind: "run.state", limit: 100_000 })
    .filter((e) => e.payload?.state === "WAITING_HUMAN");
  const progress = followRun(ctx, runtime, {
    runId,
    plan,
    header: options.header,
    signals: false,
    fromSeq: options.header ? 0 : (parks.at(-1)?.seq ?? 0),
  });
  let detached = false;
  const onInterrupt = () => {
    detached = true;
  };
  process.once("SIGINT", onInterrupt);
  let run = runtime.runs.require(runId);
  try {
    // a run handed over a moment ago may still show WAITING_HUMAN: give it a few polls to start
    let grace = options.graceTicks ?? 0;
    for (;;) {
      run = runtime.runs.require(runId);
      const runs = run.state === "RUNNING" && alive(run);
      if (!runs && (run.state !== "WAITING_HUMAN" || grace-- <= 0)) break;
      await new Promise((resolve) =>
        setTimeout(resolve, options.pollMs ?? (Number(ctx.env.JARVIS_CARD_POLL_MS) || 1000)),
      );
      if (detached) break;
    }
  } finally {
    progress.stop();
    process.removeListener("SIGINT", onInterrupt);
  }
  return { run, detached };
}

/** The workflow's step ids, for `[k/N]` and the plan under the header. */
function planOf(engine: LocalWorkflowEngine, run: Run): string[] {
  try {
    return engine.workflow(run.workflow).steps.map((s) => s.id);
  } catch {
    return []; // an unknown workflow fails in execute with its own message
  }
}

/** A prompt when a person is at the terminal (src/cli/prompt.ts); undefined in CI, pipes, --json. */
function promptFor(ctx: CliContext, runtime: Runtime): Prompt | undefined {
  const stdin = ctx.stdin as (NodeJS.ReadableStream & { isTTY?: boolean }) | undefined;
  if (!stdin) return undefined;
  const interactive = isInteractive({
    json: ctx.out.json,
    env: ctx.env,
    stdin,
    stdout: process.stdout,
    configInteractive: runtime.loaded.config.interactive,
  });
  return interactive ? createPrompt(stdin, ctx.out) : undefined;
}

/**
 * `jarvis continue [run]` (alias `c`) — back to the run that waits for you, without its id: the one
 * waiting for a person in this repository (a list to choose from when there are several), or the
 * given one. At a terminal it asks right there and goes on; a parked, failed or crashed run resumes.
 */
export async function runContinue(ctx: CliContext, ref: string | undefined): Promise<void> {
  // typed in the shell a card opened (`s`): the card goes on, the shell closes
  if (!ref && askCardToGoOn(ctx)) return;
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  const prompt = promptFor(ctx, runtime);
  try {
    const st = ctx.out.style;
    const engine = createEngine(runtime);
    let run: Run | undefined;
    if (ref) run = requireRun(ctx, runtime, ref);
    else {
      const root = loaded.project?.root ?? ctx.cwd;
      const now = Date.now();
      // waiting for a person, for a quota window, or interrupted (RUNNING with no process: Ctrl-C, a
      // closed terminal — pilot: `jarvis c` said "nothing waits" right after a Ctrl-C)
      const waiting = runtime.runs
        .list({ state: ["WAITING_HUMAN", "WAITING_BUDGET", "SUSPENDED", "RUNNING"], limit: 50 })
        .filter((r) => r.workspace.repoRoot === root || r.workspace.path === root)
        .filter((r) => r.state !== "RUNNING" || !r.lease || Date.parse(r.lease.until) < now);
      // and an approved spec of the last days that has not gone on to the implementation yet
      const ready = runtime.runs
        .list({ state: "COMPLETED", limit: 50 })
        .filter(
          (r) => nextWorkflowOf(engine, r) && (r.workspace.repoRoot === root || r.workspace.path === root),
        )
        .filter((r) => now - Date.parse(r.updatedAt) < 3 * 86_400_000 && !continuedBy(runtime, r));
      waiting.push(...ready);
      if (waiting.length === 0) {
        ctx.out.line(`nothing waits for you here ${st.muted("(`jarvis status --all` lists every run)")}`);
        return;
      }
      if (waiting.length === 1 || !prompt) {
        if (waiting.length > 1) {
          ctx.out.error(
            `${waiting.length} runs wait for you: ${waiting.map((r) => `${shortRunId(r.id)} (${waitsFor(r)})`).join(", ")} — \`jarvis continue <run>\``,
          );
          throw new CliExit(EXIT.error);
        }
        run = waiting[0];
      } else {
        ctx.out.line(st.heading(`${waiting.length} runs wait for you`));
        waiting.forEach((r, i) => {
          ctx.out.line(
            `  ${st.cmd(String(i + 1))}  ${st.name(shortRunId(r.id))}  ${r.workflow} ${st.muted("·")} ${oneLine(r.task, 60)} ${st.muted(`· ${r.currentStep ?? "-"} ·`)} ${st.warn(waitsFor(r))}`,
          );
        });
        const pick = Number(await prompt.ask(`${st.cmd(">")} `));
        run = waiting[pick - 1];
        if (!run) return;
      }
    }
    if (!run) return;
    if (run.state === "COMPLETED") {
      // a finished spec: an explicit `continue` is the consent to go on to the implementation
      const next = await startContinuation(ctx, runtime, engine, run, prompt);
      if (!next) {
        const by = continuedBy(runtime, run);
        ctx.out.line(
          by
            ? `run ${shortRunId(run.id)} went on as ${st.name(shortRunId(by))} — \`jarvis continue ${shortRunId(by)}\``
            : `run ${shortRunId(run.id)} is COMPLETED; nothing to go on with`,
        );
        return;
      }
      run = next;
    }
    if (run.state === "WAITING_HUMAN") {
      for (const line of formatRunHeader(run, planOf(engine, run), st, runtime.loaded.config))
        ctx.out.line(line);
      if (!prompt) {
        const detail = runDetail(runtime, run);
        ctx.out.result(detail, () => renderSummary(ctx, detail));
        throw new CliExit(EXIT.waitingHuman);
      }
      const actor = await actorFor(ctx, runtime);
      const gate = await humanGate(ctx, runtime, run, actor, prompt);
      if (gate === "elsewhere")
        await executeAndReport(ctx, runtime, engine, run, false, {}, prompt, false, true);
      if (gate !== "decided") {
        ctx.out.line(`${st.muted("left waiting; come back with")} ${st.cmd("jarvis continue")}`);
        throw new CliExit(EXIT.waitingHuman);
      }
    }
    if (run.state === "WAITING_BUDGET" && prompt) {
      // check the model before spending a full request (and its retries) on it
      for (const line of formatRunHeader(run, planOf(engine, run), st, runtime.loaded.config))
        ctx.out.line(line);
      if ((await waitParked(ctx, runtime, run)) !== "ready") throw new CliExit(EXIT.waitingBudget);
      await executeAndReport(ctx, runtime, engine, run, false, {}, prompt, false);
    }
    await executeAndReport(ctx, runtime, engine, run, false, {}, prompt, run.state !== "WAITING_HUMAN");
  } finally {
    prompt?.close();
    await runtime.close();
  }
}

/** Why a run waits, in a word or two. */
function waitsFor(r: Run): string {
  if (r.state === "COMPLETED") return "ready to implement";
  if (r.state === "RUNNING" || r.state === "SUSPENDED") return "interrupted";
  if (r.state === "WAITING_BUDGET") return r.waitingFor?.kind === "model" ? "the model" : "quota";
  return r.waitingFor?.kind ?? "a decision";
}

/** The run's checkout: a worktree of its own (workspace.mode worktree), or the current one. */
export async function prepareWorkspace(
  ctx: CliContext,
  runtime: Runtime,
  runId: string,
  task: string,
  base: string | undefined,
  prompt?: Prompt,
  /** The run's workflow runs the project's commands: without, the checkout skips `workspace.setup`. */
  setup = true,
): Promise<WorkspaceRef> {
  const loaded = runtime.loaded;
  const root = loaded.project?.root ?? ctx.cwd;
  const cwd: WorkspaceRef = { mode: "cwd", repoRoot: root, path: root, baseRef: base ?? "HEAD" };
  const useWorktree = loaded.config.workspace.mode === "worktree" && loaded.project?.isGitRepo === true;
  if (!useWorktree) return cwd;
  const st = ctx.out.errStyle;
  if (await WorktreeWorkspace.isDirty(root)) {
    ctx.out.note(
      `${st.warn("note:")} the working tree has uncommitted changes; the run starts from the last commit (ADR-0003 §2)`,
    );
  }
  // creating the worktree and its setup (`yarn install`, a build) take minutes: say what runs and
  // how long it has been running (pilot: `jarvis c` showed nothing for 22 s and then failed)
  const started = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let lastLine = "";
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const stop = () => {
    if (timer) clearInterval(timer);
    ctx.out.progress(undefined);
  };
  try {
    const wt = await WorktreeWorkspace.create({
      repoRoot: root,
      worktreesDir: loaded.home.worktreesDir,
      runId,
      task,
      ...(base ? { baseRef: base } : {}),
      // a run that only reads the code (spec, research) does not wait for an install it never uses
      ...(setup && loaded.config.workspace.setup ? { setup: loaded.config.workspace.setup } : {}),
      checkout: loaded.config.workspace.checkout,
      setupTimeoutMs: loaded.config.tools.commandTimeoutMs,
      env: ctx.env,
      ...(loaded.config.workspace.cache
        ? { cache: { dir: join(loaded.home.cacheDir, "deps"), ...loaded.config.workspace.cache } }
        : {}),
      onSetupLine: (line) => {
        lastLine = line;
      },
      onStage: (stage, detail) => {
        if (stage === "worktree") {
          ctx.out.note(`${st.muted("◌")} own checkout ${st.muted(detail)}`);
          return;
        }
        if (stage === "cache") {
          ctx.out.progress(undefined);
          ctx.out.note(`${st.muted("◌")} dependencies ${st.muted(detail)}`);
          return;
        }
        ctx.out.note(`${st.muted("◌")} workspace.setup ${st.cmd(detail)}`);
        const draw = () =>
          ctx.out.progress(
            `${st.cmd(frames[frame++ % frames.length] as string)} ${st.muted(clock(Date.now() - started))} workspace.setup ${st.muted(lastLine ? `· ${lastLine}` : "(installing and building in the new checkout)")}`,
          );
        draw();
        timer = setInterval(draw, 1000);
        timer.unref?.();
      },
    });
    stop();
    runtime.log.info("workspace.ready", { runId, path: wt.ref.path, ms: Date.now() - started });
    ctx.out.note(`${st.ok("✓")} checkout ready ${st.muted(`in ${duration(Date.now() - started)}`)}`);
    return wt.ref;
  } catch (error) {
    stop();
    if (!(error instanceof WorktreeError)) throw error;
    runtime.log.error("workspace.failed", {
      runId,
      ms: Date.now() - started,
      message: error.message.slice(0, 4000),
    });
    ctx.out.error(error.message);
    if (prompt) {
      const so = ctx.out.style;
      const answer = (
        await prompt.ask(
          `${so.heading("Work in your checkout instead?")} ${so.warn("changes land in your working tree")} ${so.cmd("[y/N] >")} `,
        )
      )?.toLowerCase();
      if (answer === "y" || answer === "yes" || answer === "д" || answer === "да") return cwd;
    }
    // without a prompt the help line of the error (J006) says how to go on
    throw new CliExit(EXIT.error);
  }
}

/**
 * A finished `spec`/`research` run handed on to `sdd`, starting after what it already did
 * (src/app/handoff.ts). Undefined when the run has nowhere to go on or went on already.
 */
async function startContinuation(
  ctx: CliContext,
  runtime: Runtime,
  engine: LocalWorkflowEngine,
  from: Run,
  prompt?: Prompt,
): Promise<Run | undefined> {
  const targetName = nextWorkflowOf(engine, from);
  if (!targetName) return undefined;
  const target = engine.workflow(targetName);
  const startAt = continuationStep(from, target);
  if (!startAt || continuedBy(runtime, from)) return undefined;
  const actor = await actorFor(ctx, runtime);
  const runId = newRunId();
  // say at once what happens: preparing a worktree may take minutes before anything else shows
  ctx.out.note(
    `${ctx.out.errStyle.ok("→")} run ${shortRunId(from.id)} goes on as ${targetName} from ${startAt} ${ctx.out.errStyle.muted("— preparing the checkout")}`,
  );
  // research or spec across services goes on as sdd-cross in the same knowledge repository
  const workspace: WorkspaceRef = CROSS_WORKFLOWS.has(targetName)
    ? { mode: "cwd", repoRoot: from.workspace.repoRoot, path: from.workspace.repoRoot, baseRef: "HEAD" }
    : await prepareWorkspace(
        ctx,
        runtime,
        runId,
        from.task,
        undefined,
        prompt,
        workflowRunsProjectCommands(runtime, target),
      );
  const run = runtime.runs.create({
    id: runId,
    task: from.task,
    workflow: targetName,
    owner: actor,
    workspace,
    dataClass: runtime.loaded.config.dataClass,
    ...(runtime.loaded.config.profile ? { profile: runtime.loaded.config.profile } : {}),
    // a spec goes on as sdd: the kind the person picked goes with it, and an autonomous run stays one
    ...((o) => (Object.keys(o).length > 0 ? { options: o } : {}))({
      ...(from.options?.kind ? { kind: from.options.kind } : {}),
      ...(from.options?.autonomous ? { autonomous: true as const } : {}),
      ...(from.options?.related !== undefined ? { related: from.options.related } : {}),
    }),
  });
  const carried = handOff(runtime, from, run, startAt);
  runtime.events.emit({
    kind: "run.created",
    runId: run.id,
    actor: `${actor.kind}:${actor.id}`,
    payload: {
      task: from.task,
      workflow: targetName,
      continuedFrom: from.id,
      startAt,
      carried: carried.length,
      inputs: await recordInputs(workspace.repoRoot, workspace.baseCommit),
      ...(await knowledgeRepoInputsOf(workspace.repoRoot)),
    },
  });
  const st = ctx.out.style;
  ctx.out.line();
  ctx.out.line(
    `${st.ok("→")} ${st.name(shortRunId(run.id))} ${targetName} ${st.muted(`from ${startAt}, with ${carried.map((a) => a.name).join(", ")} of run ${shortRunId(from.id)}`)}`,
  );
  if (workspace.mode === "worktree")
    ctx.out.line(
      st.muted(`  works in its own checkout ${workspace.path}; yours stays as it is until \`jarvis apply\``),
    );
  else if (CROSS_WORKFLOWS.has(targetName))
    ctx.out.line(st.muted("  works in the knowledge repository: the subtasks change the services' code"));
  else ctx.out.line(st.warn("  works in your checkout: changes land in your working tree"));
  return runtime.runs.get(run.id);
}

/**
 * `jarvis restart <run> [--from <step>]`: a stopped run started again from one of its steps, with the
 * artifacts and approvals of the steps before it (src/app/restart.ts), in a fresh checkout.
 */
export async function runRestart(
  ctx: CliContext,
  ref: string,
  options: { readonly from?: string; readonly noRun?: boolean; readonly note?: string },
): Promise<void> {
  let loaded = await loadForCli(ctx);
  let runtime = createRuntime(loaded, { env: ctx.env });
  let here = ctx;
  try {
    let from = requireRun(ctx, runtime, ref);
    // the repository of the run, wherever the command is typed
    if (loaded.project?.root !== from.workspace.repoRoot && existsSync(from.workspace.repoRoot)) {
      runtime.close();
      here = { ...ctx, cwd: from.workspace.repoRoot };
      loaded = await loadForCli(here);
      runtime = createRuntime(loaded, { env: ctx.env });
      from = requireRun(here, runtime, ref);
    }
    const st = ctx.out.style;
    if (from.options?.parent) {
      ctx.out.error(
        `${shortRunId(from.id)} is subtask ${from.options.parent.key} of ${shortRunId(from.options.parent.runId)}: \`jarvis subtask retry ${shortRunId(from.options.parent.runId)} ${from.options.parent.key}\``,
      );
      throw new CliExit(EXIT.error);
    }
    if (!RESTARTABLE.has(from.state)) {
      ctx.out.error(
        `${shortRunId(from.id)} is ${from.state}: it goes on with \`jarvis resume ${shortRunId(from.id)}\`, or \`jarvis cancel\` it first`,
      );
      throw new CliExit(EXIT.error);
    }
    const engine = createEngine(runtime);
    const workflow = engine.workflow(from.workflow);
    const plan = restartPlanOf(runtime, from, workflow);
    if (!plan) {
      ctx.out.error(`${shortRunId(from.id)} has nothing to take on: \`jarvis work\` starts it anew`);
      throw new CliExit(EXIT.error);
    }
    const startable = plan.steps.filter((s) => s.startable).map((s) => s.id);
    const startAt = options.from ?? plan.startAt;
    if (!startable.includes(startAt)) {
      ctx.out.error(
        `it cannot start at "${startAt}": it can at ${startable.slice(1).join(", ")} (after a step that writes code, the code is not taken on)`,
      );
      throw new CliExit(EXIT.error);
    }
    const keepSteps = carriedSteps(plan, startAt);
    ctx.out.line(
      `${st.heading(`${shortRunId(from.id)} ${from.workflow}`)} ${st.muted(`· ${oneLine(from.task, 60)} · ${from.state}`)}`,
    );
    for (const s of plan.steps.filter((x) => x.startable)) {
      const mark = s.id === startAt ? st.ok("→") : keepSteps.has(s.id) ? st.ok("✓") : st.muted("·");
      const note =
        s.id === startAt
          ? "starts here"
          : keepSteps.has(s.id)
            ? s.approved
              ? "approved, taken on"
              : "taken on"
            : "";
      ctx.out.line(`  ${mark} ${s.id.padEnd(16)} ${st.muted(note)}`);
    }
    // the code it read may have changed since
    const since = await changedSince(from, filesReadIn(runtime, from.id));
    if (since && since.touched.length > 0)
      ctx.out.line(
        st.warn(
          `  ${since.commits} commit${since.commits === 1 ? "" : "s"} since it looked changed ${since.touched.length} file${since.touched.length === 1 ? "" : "s"} it read: ${since.touched.slice(0, 5).join(", ")}${since.touched.length > 5 ? " …" : ""} — what it found may be out of date; --from an earlier step to look again`,
        ),
      );
    const actor = await actorFor(here, runtime);
    const runId = newRunId();
    const prompt = promptFor(here, runtime);
    const workspace: WorkspaceRef = CROSS_WORKFLOWS.has(from.workflow)
      ? { mode: "cwd", repoRoot: from.workspace.repoRoot, path: from.workspace.repoRoot, baseRef: "HEAD" }
      : await prepareWorkspace(
          here,
          runtime,
          runId,
          from.task,
          undefined,
          prompt,
          workflowRunsProjectCommands(runtime, workflow),
        );
    const run = runtime.runs.create({
      id: runId,
      task: from.task,
      workflow: from.workflow,
      owner: actor,
      workspace,
      dataClass: runtime.loaded.config.dataClass,
      ...(runtime.loaded.config.profile ? { profile: runtime.loaded.config.profile } : {}),
      ...((o) => (Object.keys(o).length > 0 ? { options: o } : {}))({
        ...(from.options?.fresh?.length ? { fresh: [...from.options.fresh] } : {}),
        ...(from.options?.kind ? { kind: from.options.kind } : {}),
        ...(from.options?.autonomous ? { autonomous: true as const } : {}),
        ...(from.options?.related !== undefined ? { related: from.options.related } : {}),
      }),
    });
    const carried = handOff(runtime, from, run, startAt, (a) => !a.stepId || keepSteps.has(a.stepId));
    if (options.note) noteForStart(runtime, run, startAt, actor, options.note);
    runtime.events.emit({
      kind: "run.created",
      runId: run.id,
      actor: `${actor.kind}:${actor.id}`,
      payload: {
        task: from.task,
        workflow: from.workflow,
        continuedFrom: from.id,
        restartOf: from.id,
        startAt,
        carried: carried.length,
        inputs: await recordInputs(workspace.repoRoot, workspace.baseCommit),
        ...(await knowledgeRepoInputsOf(workspace.repoRoot)),
      },
    });
    ctx.out.line();
    ctx.out.line(
      `${st.ok("→")} ${st.name(shortRunId(run.id))} ${from.workflow} ${st.muted(`from ${startAt}, with ${carried.length} artifact${carried.length === 1 ? "" : "s"} of run ${shortRunId(from.id)}`)}`,
    );
    if (options.noRun) {
      ctx.out.line(st.muted(`  not started: \`jarvis resume ${shortRunId(run.id)}\``));
      return;
    }
    const created = runtime.runs.get(run.id) ?? run;
    await executeAndReport(here, runtime, engine, created, false, {}, prompt);
  } finally {
    runtime.close();
  }
}

/**
 * `jarvis redo <run> <step> [--note]` (src/app/redo.ts): a run that waits, is paused or failed goes
 * back to a step it went through, with a note for that step, and goes on from there in its own
 * checkout; a run that ended starts again from the step as a new run (`jarvis restart`).
 */
export async function runRedo(
  ctx: CliContext,
  ref: string,
  step: string,
  options: { readonly note?: string; readonly noRun?: boolean },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  let ended = false;
  try {
    const run = requireRun(ctx, runtime, ref);
    if (run.options?.parent) {
      ctx.out.error(
        `${shortRunId(run.id)} is subtask ${run.options.parent.key} of ${shortRunId(run.options.parent.runId)}: \`jarvis subtask retry\``,
      );
      throw new CliExit(EXIT.error);
    }
    ended = run.state === "CANCELLED" || run.state === "COMPLETED";
    if (!ended) {
      const engine = createEngine(runtime);
      const workflow = engine.workflow(run.workflow);
      const actor = await actorFor(ctx, runtime);
      try {
        requestRedo(runtime, run, workflow, step, actor, "cli", options.note);
      } catch (error) {
        ctx.out.error(error instanceof Error ? error.message : String(error));
        throw new CliExit(EXIT.error);
      }
      const st = ctx.out.style;
      ctx.out.line(
        `${st.ok("↶")} ${st.name(shortRunId(run.id))} goes back to ${step}${options.note ? st.muted(" with your note") : ""} ${st.muted("— the steps after it run again; the checkout keeps what the run wrote")}`,
      );
      if (options.noRun) {
        ctx.out.line(st.muted(`  not started: \`jarvis resume ${shortRunId(run.id)}\``));
        return;
      }
      await executeAndReport(
        ctx,
        runtime,
        engine,
        runtime.runs.get(run.id) ?? run,
        false,
        {},
        promptFor(ctx, runtime),
      );
      return;
    }
  } finally {
    runtime.close();
  }
  // ended: a new run from the step
  await runRestart(ctx, ref, {
    from: step,
    ...(options.note ? { note: options.note } : {}),
    ...(options.noRun ? { noRun: true } : {}),
  });
}

/** What the rest of the work is, for the question. */
function restOf(engine: LocalWorkflowEngine, from: Run): string | undefined {
  const targetName = nextWorkflowOf(engine, from);
  if (!targetName) return undefined;
  const target = engine.workflow(targetName);
  const startAt = continuationStep(from, target);
  if (!startAt) return undefined;
  const ids = target.steps.map((s) => s.id);
  return ids
    .slice(ids.indexOf(startAt))
    .filter((id) => !id.startsWith("approve-"))
    .join(" → ");
}

/** `jarvis work <task>` — create a run and execute it in the foreground (ADR-0001 §15). */
export async function runWork(
  ctx: CliContext,
  task: string,
  options: {
    workflow?: string;
    noRun?: boolean;
    base?: string;
    fresh?: readonly FreshSource[];
    kind?: TaskKind;
    /** `--deliver pr`: the run opens its own PR when its workflow is done (ADR-0003 §4). */
    deliver?: "pr";
    /** `--autonomous`: no person in the loop (src/app/autonomy.ts); else `human.autonomous`. */
    autonomous?: boolean;
    /** `--related` / `--no-related` (ADR-0026); else `relatedWork.enabled`. */
    related?: boolean;
  },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const engine = createEngine(runtime);
    // in a knowledge repository research and spec are across services; work and fix have no code there
    const here = workflowHere(options.workflow ?? "sdd", loaded.meta);
    if ("refused" in here) {
      ctx.out.error(here.refused);
      throw new CliExit(EXIT.error);
    }
    const workflowName = here.workflow;
    const workflow = engine.workflow(workflowName);
    const actor = await actorFor(ctx, runtime);
    const preflight = await preflightMcp(runtime, workflow);
    if (!preflight.ok) {
      for (const s of preflight.servers.filter((x) => !x.ok)) {
        ctx.out.error(
          `mcp server "${s.id}" is required by workflow ${workflowName} but unavailable: ${s.error}`,
        );
      }
      ctx.out.error(
        "fix the servers above (`jarvis mcp list`, `jarvis auth status`) and retry (ADR-0017 §6)",
      );
      throw new CliExit(EXIT.error);
    }
    // steps no model can serve: said now, not an hour into the run
    for (const p of preflightModels(runtime, workflow))
      ctx.out.note(`${ctx.out.errStyle.warn("!")} step ${p.step}: ${p.reason}`);
    const runId = newRunId();
    // a task across services runs in the knowledge repository and changes no code there (ADR-0025 §6)
    const workspace = CROSS_WORKFLOWS.has(workflowName)
      ? ({
          mode: "cwd",
          repoRoot: loaded.project?.root ?? ctx.cwd,
          path: loaded.project?.root ?? ctx.cwd,
          baseRef: "HEAD",
        } satisfies WorkspaceRef)
      : await prepareWorkspace(
          ctx,
          runtime,
          runId,
          task,
          options.base,
          undefined,
          workflowRunsProjectCommands(runtime, workflow),
        );
    const run = runtime.runs.create({
      id: runId,
      task,
      workflow: workflowName,
      owner: actor,
      workspace,
      dataClass: loaded.config.dataClass,
      ...(loaded.config.profile ? { profile: loaded.config.profile } : {}),
      ...((o) => (Object.keys(o).length > 0 ? { options: o } : {}))({
        ...(options.fresh?.length ? { fresh: [...options.fresh] } : {}),
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.deliver ? { delivery: options.deliver } : {}),
        ...(options.autonomous || loaded.config.human.autonomous ? { autonomous: true as const } : {}),
        ...(options.related !== undefined ? { related: options.related } : {}),
      }),
    });
    runtime.events.emit({
      kind: "run.created",
      runId: run.id,
      actor: `${actor.kind}:${actor.id}`,
      payload: {
        task,
        workflow: workflowName,
        ...(run.options ? { options: run.options } : {}),
        // the configuration and knowledge it starts with, for an eval case made later (src/evals/inputs.ts)
        inputs: await recordInputs(workspace.repoRoot, workspace.baseCommit),
        ...(await knowledgeRepoInputsOf(workspace.repoRoot)),
      },
    });
    if (options.noRun) {
      ctx.out.result({ id: run.id, state: run.state }, () =>
        ctx.out.line(
          `created run ${shortRunId(run.id)} for ${task} (${workflowName}); start it with \`jarvis resume ${shortRunId(run.id)}\``,
        ),
      );
      return;
    }
    await executeAndReport(ctx, runtime, engine, run, false);
  } finally {
    await runtime.close();
  }
}

/** `jarvis resume <run> [--steal]` (ADR-0002 §5). */
export async function runResume(ctx: CliContext, ref: string, options: { steal?: boolean }): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const engine = createEngine(runtime);
    const run = requireRun(ctx, runtime, ref);
    if (options.steal) {
      const actor = await actorFor(ctx, runtime);
      runtime.events.emit({
        kind: "run.steal",
        runId: run.id,
        actor: `${actor.kind}:${actor.id}`,
        payload: { previous: run.lease?.owner },
      });
    }
    await executeAndReport(ctx, runtime, engine, run, options.steal === true);
  } finally {
    await runtime.close();
  }
}

export interface ApproveOptions {
  readonly type?: string;
  readonly decision?: ApprovalDecision;
  readonly comment?: string;
  readonly resume?: boolean;
  /** ADR-0009 §4: materialize the approval in `.jarvis/approvals/<task>/<type>.json` and commit it. */
  readonly commit?: boolean;
}

/** `jarvis approve <run>` (ADR-0005 §4). */
export async function runApprove(ctx: CliContext, ref: string, options: ApproveOptions): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const run = requireRun(ctx, runtime, ref);
    const actor = await actorFor(ctx, runtime);
    // ADR-0005 §3: `jarvis approve` decides on the latest version — the person's edit of the file too
    const edits = syncEditable(runtime, run, actor);
    for (const a of edits.edited)
      if (!ctx.out.json) ctx.out.line(`${a.type}/${a.name}@${a.version}: your edit of the file is recorded`);
    for (const r of edits.rejected) ctx.out.error(`${r.file}: edit not taken — ${r.reason}`);
    const awaited = awaitedArtifact(runtime, run);
    const type = options.type ?? awaited?.type;
    if (!type) {
      ctx.out.error("nothing awaits approval on this run; pass --type <artifactType> to approve explicitly");
      throw new CliExit(EXIT.error);
    }
    const latest = runtime.artifacts.listLatest(run.id, type)[0];
    if (!latest) {
      ctx.out.error(`run has no artifact of type "${type}"`);
      throw new CliExit(EXIT.error);
    }
    const decision = options.decision ?? "approve";
    let approval: Approval;
    try {
      approval = recordDecision(runtime, run, {
        actor,
        artifact: latest,
        type,
        decision,
        ...(options.comment ? { comment: options.comment } : {}),
        channel: "cli",
      });
    } catch (error) {
      if (!(error instanceof DecisionTakenError)) throw error;
      ctx.out.error(error.message);
      throw new CliExit(EXIT.error);
    }
    let committed: string | undefined;
    if (options.commit) {
      const root = loaded.project?.root ?? ctx.cwd;
      // a service's approvals are the knowledge repository's, committed there (ADR-0025 §1)
      const layout = layoutOf(root);
      const file = join(layout.approvalsDir, run.task, `${type}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            artifactId: latest.artifactId,
            version: latest.version,
            contentRef: latest.contentRef,
            actor,
            decision,
            createdAt: approval.createdAt,
          },
          null,
          2,
        )}\n`,
      );
      const at = versionedAt(layout, rootRelative(root, file));
      const rel = at.path;
      const add = await git(["add", rel], at.cwd);
      const commit =
        add.code === 0
          ? await git(
              [
                "commit",
                "-q",
                "--no-verify",
                "-m",
                `jarvis: ${decision} ${type} for ${run.task}\n\nJarvis-Run: ${run.id}\nJarvis-Kind: approval`,
              ],
              at.cwd,
              { env: gitIdentityEnv(ctx.env, { name: actor.display ?? actor.id, email: actor.id }) },
            )
          : add;
      if (commit.code !== 0) {
        ctx.out.error(
          `approval written to ${rel} but not committed: ${(commit.stderr || commit.stdout).trim()}`,
        );
      } else committed = rel;
    }
    const line = `${decision}: ${type}/${latest.name}@${latest.version} by ${actor.id}${committed ? ` (committed ${committed})` : ""}`;
    if (options.resume) {
      if (!ctx.out.json) ctx.out.line(line);
      await executeAndReport(ctx, runtime, createEngine(runtime), run, false, { approval });
    }
    ctx.out.result(approval, () => ctx.out.line(line));
  } finally {
    await runtime.close();
  }
}

export interface EditOptions {
  /** false: print the file only (`--no-open`). */
  readonly open?: boolean;
  /** Opens the file and returns when the person is done (default `$VISUAL`, `$EDITOR`, `vi`). */
  readonly editor?: (file: string) => boolean;
}

/**
 * `jarvis edit <run> [type]` (ADR-0005 §3): the document in its file, in the person's editor; what
 * they change is recorded as the next version, theirs. Without a type: what the run waits on, else
 * the first editable document it has.
 */
export async function runEdit(
  ctx: CliContext,
  ref: string,
  type: string | undefined,
  options: EditOptions = {},
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const run = requireRun(ctx, runtime, ref);
    const actor = await actorFor(ctx, runtime);
    syncEditable(runtime, run, actor);
    const awaited = awaitedArtifact(runtime, run)?.type;
    const chosen =
      type ??
      (awaited && isEditable(awaited)
        ? awaited
        : EDITABLE_TYPES.find((t) => runtime.artifacts.listLatest(run.id, t).length > 0));
    if (!chosen || !isEditable(chosen)) {
      ctx.out.error(
        `${chosen ? `"${chosen}" is not edited as a file` : "the run has no document to edit yet"}; editable: ${EDITABLE_TYPES.join(", ")}`,
      );
      throw new CliExit(EXIT.error);
    }
    const before = runtime.artifacts.listLatest(run.id, chosen)[0];
    if (!before) {
      ctx.out.error(`run has no artifact of type "${chosen}"`);
      throw new CliExit(EXIT.error);
    }
    const file = editableFile(run, before);
    if (!existsSync(file)) {
      ctx.out.error(`the run's workspace ${run.workspace.path} is gone: nothing to edit`);
      throw new CliExit(EXIT.error);
    }
    const label = `${before.type}/${before.name}@${before.version}`;
    if (options.open === false || ctx.out.json) {
      ctx.out.result({ file, artifact: label }, () => ctx.out.line(file));
      return;
    }
    (options.editor ?? systemEditor(ctx))(file);
    const after = syncEditable(runtime, run, actor);
    const made = after.edited.find((a) => a.artifactId === before.artifactId);
    for (const r of after.rejected) ctx.out.error(`${r.file}: edit not taken — ${r.reason}`);
    ctx.out.line(
      made
        ? `${made.type}/${made.name}@${made.version}: edited by ${actor.id} (from @${before.version})`
        : `${label}: no change`,
    );
    if (made && run.state === "WAITING_HUMAN")
      ctx.out.line(`  the new version waits for a decision: jarvis approve ${shortRunId(run.id)}`);
  } finally {
    await runtime.close();
  }
}

/** `jarvis daemon [--interval s] [--once]` (ADR-0001 §3). */
export async function runDaemon(
  ctx: CliContext,
  options: { interval?: number; once?: boolean },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const engine = createEngine(runtime);
    const interval = Math.max(1, options.interval ?? 30);
    for (;;) {
      const report = await daemonTick(runtime, engine, {
        evals: { cwd: ctx.cwd, homeDir: ctx.homeDir, env: ctx.env },
      });
      ctx.out.result(report, () => {
        const line = `${report.at} considered ${report.considered}, resumed ${report.resumed.length}, skipped ${report.skipped.length}`;
        ctx.out.line(line);
        for (const r of report.resumed) ctx.out.line(`  resumed ${shortRunId(r.runId)} → ${r.state}`);
        for (const s of report.skipped) ctx.out.line(`  skipped ${shortRunId(s.runId)}: ${s.reason}`);
        for (const e of report.evals ?? [])
          ctx.out.line(
            `  evals ${e.suite} (${e.mode}, pool ${e.pool}): ${e.error ? `failed: ${e.error}` : e.regressed ? `REGRESSION: ${e.regressions.join("; ")}` : `${e.summary?.successes}/${e.summary?.cases} succeeded`}${e.file ? ` → ${e.file}` : ""}`,
          );
      });
      if (options.once) return;
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    }
  } finally {
    await runtime.close();
  }
}

/** `jarvis diff <run>` (ADR-0003 §4). */
export async function runDiff(ctx: CliContext, ref: string): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const run = requireRun(ctx, runtime, ref);
    if (run.workspace.mode !== "worktree") {
      ctx.out.error("this run works in the current checkout (cwd mode); use `git diff` directly");
      throw new CliExit(EXIT.error);
    }
    const wt = WorktreeWorkspace.open(run.workspace, ctx.env);
    const diff = await wt.diff();
    const files = await wt.changedFiles();
    ctx.out.result({ run: run.id, branch: run.workspace.branch, files, diff }, () => {
      if (diff.length > 0) ctx.out.raw(renderDiff(diff.replace(/\n$/, ""), ctx.out.style));
      else
        ctx.out.line(
          ctx.out.style.muted(
            `no changes on ${run.workspace.branch} since ${run.workspace.baseCommit?.slice(0, 10)}`,
          ),
        );
    });
  } finally {
    await runtime.close();
  }
}

export interface ApplyOptions {
  readonly message?: string;
  /** Deliver as a pull request instead: push the branch, open the PR (ADR-0003 §4). */
  readonly pr?: boolean;
  readonly title?: string;
  readonly target?: string;
  /** `delivery.pr: approve` without a terminal: the person approves the PR as shown. */
  readonly yes?: boolean;
}

/** `jarvis apply <run>` — squash the run branch onto the current branch (ADR-0003 §4). */
export async function runApply(ctx: CliContext, ref: string, options: ApplyOptions): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const run = requireRun(ctx, runtime, ref);
    if (run.workspace.mode !== "worktree") {
      ctx.out.error("this run works in the current checkout (cwd mode); nothing to apply");
      throw new CliExit(EXIT.error);
    }
    const actor = await actorFor(ctx, runtime);
    if (options.pr) {
      await applyAsPr(ctx, runtime, run, actor, options);
      return;
    }
    try {
      const result = await applyRun(runtime, run, actor, ctx.env, options.message);
      ctx.out.result({ run: run.id, ...result }, () => {
        ctx.out.line(
          `applied ${result.files.length} file(s) as ${result.commit.slice(0, 10)} on the current branch`,
        );
      });
    } catch (error) {
      if (error instanceof WorktreeError) {
        ctx.out.error(error.message);
        throw new CliExit(EXIT.error);
      }
      throw error;
    }
  } finally {
    await runtime.close();
  }
}

/**
 * `jarvis apply <run> --pr`: the run's changes pushed as its branch and a PR opened through the MCP
 * server (src/app/deliver.ts). With `delivery.pr: approve` the PR is shown first and the person says
 * yes — at a terminal, or with `--yes`; the approval is recorded as theirs.
 */
async function applyAsPr(
  ctx: CliContext,
  runtime: Runtime,
  run: Run,
  actor: Actor,
  options: ApplyOptions,
): Promise<void> {
  if (run.state !== "COMPLETED") {
    ctx.out.error(`the run is ${run.state}: a PR is made of a completed run`);
    throw new CliExit(EXIT.error);
  }
  const wanted = {
    ...(options.title ? { title: options.title } : {}),
    ...(options.target ? { target: options.target } : {}),
  };
  try {
    if (prPolicy(runtime) === "approve" && !prOf(runtime, run)) {
      const { artifact, request } = await preparePr(runtime, run, wanted);
      if (!runtime.artifacts.isApproved(artifact.artifactId).approved) {
        ctx.out.line(`${ctx.out.style.heading(request.title)}  ${request.source} → ${request.target}`);
        ctx.out.line(ctx.out.style.muted(request.description));
        let yes = options.yes === true;
        if (!yes) {
          const prompt = promptFor(ctx, runtime);
          if (!prompt) {
            ctx.out.error(
              "the project wants the PR approved first (delivery.pr: approve): add --yes to approve it as shown",
            );
            throw new CliExit(EXIT.waitingHuman);
          }
          try {
            yes = /^y(es)?$/i.test((await prompt.ask("Create this PR? [y/N] ")) ?? "");
          } finally {
            prompt.close();
          }
        }
        if (!yes) {
          ctx.out.line("no PR created");
          return;
        }
        recordDecision(runtime, run, {
          actor,
          artifact,
          type: PR_REQUEST,
          decision: "approve",
          channel: "cli",
        });
      }
    }
    const done = await deliverPr(runtime, run, { actor, channel: "cli", ...wanted });
    ctx.out.result({ run: run.id, ...done }, () => {
      const where = done.url ?? `${done.source} → ${done.target}`;
      ctx.out.line(
        done.already ? `already delivered: ${where}` : `pushed ${done.source} and opened the PR: ${where}`,
      );
    });
  } catch (error) {
    if (error instanceof DeliveryError) {
      ctx.out.error(error.message);
      throw new CliExit(error.code === "denied" ? EXIT.policyDenied : EXIT.error);
    }
    if (error instanceof UnresolvedEffectError) {
      ctx.out.error(
        `${error.message}: look for "${effectMarker(run.id, error.record.key)}" on the remote branch or in the PRs, then run this again`,
      );
      throw new CliExit(EXIT.error);
    }
    throw error;
  }
}

/** Removes graph fact files not read since the cutoff (atime when available, else mtime). */
function gcGraphCache(dir: string, cutoff: number): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".json")) {
        const st = statSync(p);
        if (Math.max(st.atimeMs, st.mtimeMs) < cutoff) {
          rmSync(p, { force: true });
          removed += 1;
        }
      }
    }
  };
  walk(dir);
  return removed;
}

/** `jarvis gc` — remove worktrees of terminal runs past retention (ADR-0003 §6) and stale graph facts. */
export async function runGc(
  ctx: CliContext,
  options: { pruneBranches?: boolean; days?: number },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const days = options.days ?? loaded.config.workspace.retentionDays;
    const cutoff = Date.now() - days * 86_400_000;
    const removed: string[] = [];
    const kept: string[] = [];
    for (const run of runtime.runs.list({ state: ["COMPLETED", "CANCELLED", "FAILED"], limit: 1000 })) {
      if (run.workspace.mode !== "worktree" || !existsSync(run.workspace.path)) continue;
      if (run.state === "FAILED" || Date.parse(run.updatedAt) > cutoff) {
        kept.push(run.id);
        continue;
      }
      // what it is doing, one run at a time (pilot: a silent minute looked like a hang)
      const started = Date.now();
      ctx.out.note(
        `◌ ${shortRunId(run.id)} ${run.state.toLowerCase()} · removing its checkout${options.pruneBranches ? " and branch" : ""}`,
      );
      await new WorktreeWorkspace(run.workspace, ctx.env).remove({
        pruneBranch: options.pruneBranches === true,
      });
      ctx.out.note(
        `✓ ${shortRunId(run.id)} removed (${duration(Date.now() - started)}; the files go in the background)`,
      );
      runtime.events.emit({
        kind: "run.gc",
        runId: run.id,
        payload: { path: run.workspace.path, branchPruned: options.pruneBranches === true },
      });
      removed.push(run.id);
    }
    // Graph facts cache (ADR-0008 §1): blobs nobody referenced within the retention window go.
    const cacheRemoved = gcGraphCache(join(loaded.home.cacheDir, "graph"), cutoff);
    ctx.out.result({ removed, kept, days, graphCacheRemoved: cacheRemoved }, () => {
      ctx.out.line(
        `removed ${removed.length} worktree(s) older than ${days} day(s); kept ${kept.length}; graph cache: ${cacheRemoved} stale fact file(s) removed`,
      );
    });
  } finally {
    await runtime.close();
  }
}

/**
 * `jarvis show <run> [artifact] [--out <file>]` — what a run produced: the list, or one artifact
 * (by type, name or any unique part of `type/name`) printed for reading. Pilot: `jarvis spec`
 * stopped at "awaiting approval" and there was no command to read the spec it asked to approve.
 */
/** What the redactor masked in what agents read, per step, with the shapes of the high-entropy guesses. */
function redactionsOf(
  runtime: Runtime,
  runId: string,
): Array<{
  stepId: string;
  count: number;
  byType: Record<string, number>;
  samples: Array<{ placeholder: string; shape: string; before: string }>;
}> {
  const by = new Map<
    string,
    {
      count: number;
      byType: Record<string, number>;
      samples: Map<string, { placeholder: string; shape: string; before: string }>;
    }
  >();
  for (const e of runtime.events.list({ runId, kind: "security.redaction" })) {
    const p = (e.payload ?? {}) as {
      boundary?: string;
      count?: number;
      byType?: Record<string, number>;
      samples?: Array<{ placeholder: string; shape: string; before: string }>;
    };
    // what agents read: tool output and files put into a model request, not what they wrote
    if (p.boundary === "artifact") continue;
    const step = e.stepId ?? "-";
    const acc = by.get(step) ?? {
      count: 0,
      byType: {} as Record<string, number>,
      samples: new Map<string, { placeholder: string; shape: string; before: string }>(),
    };
    acc.count += p.count ?? 0;
    for (const [k, n] of Object.entries(p.byType ?? {})) acc.byType[k] = (acc.byType[k] ?? 0) + n;
    for (const s of p.samples ?? []) if (acc.samples.size < 5) acc.samples.set(s.placeholder, s);
    by.set(step, acc);
  }
  return [...by.entries()].map(([stepId, a]) => ({
    stepId,
    count: a.count,
    byType: a.byType,
    samples: [...a.samples.values()],
  }));
}

/**
 * `jarvis follow [run]`: follow a run that goes on in another terminal or the daemon — its course
 * so far, then live, until it stops for a person, finishes or fails; Ctrl-C only detaches, the run
 * goes on. Without an id: the run of this repository that runs now.
 */
export async function runFollow(
  ctx: CliContext,
  ref: string | undefined,
  options: { pollMs?: number } = {},
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const engine = createEngine(runtime);
    const root = loaded.project?.root ?? ctx.cwd;
    const alive = (r: Run) => r.lease !== undefined && Date.parse(r.lease.until) >= Date.now();
    let run: Run | undefined = ref
      ? requireRun(ctx, runtime, ref)
      : runtime.runs
          .list({ state: "RUNNING", limit: 50 })
          .find((r) => (r.workspace.repoRoot === root || r.workspace.path === root) && alive(r));
    if (!run) {
      ctx.out.line(`nothing runs here now ${ctx.out.style.muted("(`jarvis status` lists the runs)")}`);
      return;
    }
    const followed = await followElsewhere(ctx, runtime, run.id, planOf(engine, run), {
      header: true,
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    });
    run = followed.run;
    if (followed.detached) {
      ctx.out.note(`detached; the run goes on — \`jarvis follow ${shortRunId(run.id)}\` to come back`);
      return;
    }
    const detail = runDetail(runtime, run);
    ctx.out.result(detail, () =>
      renderSummary(ctx, detail, { link: (a, label) => artifactLink(ctx.out.style, runtime, a, label) }),
    );
    throw new CliExit(exitCodeFor(run.state, run.stateReason));
  } finally {
    await runtime.close();
  }
}

export async function runShow(
  ctx: CliContext,
  ref: string,
  artifactRef: string | undefined,
  options: { out?: string; raw?: boolean },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const run = requireRun(ctx, runtime, ref);
    const id = shortRunId(run.id);
    const st = ctx.out.style;
    const all = runtime.artifacts.listLatest(run.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const pending = new Set(
      runtime.artifacts
        .pendingApprovals(run.id, ["spec", "plan", "review", "implementation"])
        .map((a) => a.artifactId),
    );
    const stateOf = (a: (typeof all)[number]) =>
      pending.has(a.artifactId)
        ? "awaiting approval"
        : runtime.artifacts.isApproved(a.artifactId).approved
          ? "approved"
          : "";
    if (!artifactRef) {
      const masked = redactionsOf(runtime, run.id);
      ctx.out.result(
        {
          run: run.id,
          artifacts: all.map((a) => ({ ...a, state: stateOf(a) || undefined })),
          ...(masked.length > 0 ? { redactions: masked } : {}),
        },
        () => {
          ctx.out.line(`${st.heading("run")} ${st.name(id)}  ${run.task} ${st.muted(`· ${run.workflow}`)}`);
          if (all.length === 0) {
            ctx.out.line(st.muted("  no artifacts yet"));
            return;
          }
          const w = Math.max(...all.map((a) => `${a.type}/${a.name}@${a.version}`.length));
          for (const a of all) {
            const state = stateOf(a);
            const partial = incompleteOf(a);
            ctx.out.line(
              `  ${padStyled(artifactLink(st, runtime, a, `${a.type}/${a.name}@${a.version}`), w)}  ${st.muted(padStyled(a.stepId ? `${a.stepId}${a.iteration && a.iteration > 1 ? `#${a.iteration}` : ""}` : "-", 16))} ${state === "approved" ? st.ok(state) : st.warn(state)}${partial ? ` ${st.warn(`⚠ incomplete (${partial.limit} limit)`)}` : ""}`.trimEnd(),
            );
          }
          if (masked.length > 0) {
            ctx.out.line();
            ctx.out.line(
              `${st.heading("masked in what agents read")} ${st.muted("(a code name here is a false positive)")}`,
            );
            for (const m of masked) {
              const kinds = Object.entries(m.byType)
                .map(([k, n]) => `${k} ×${n}`)
                .join(", ");
              ctx.out.line(`  ${st.name(m.stepId)}  ${m.count} ${st.muted(`(${kinds})`)}`);
              for (const s of m.samples)
                ctx.out.line(
                  `    ${st.muted(s.before ? `${s.before}` : "")}${st.warn(s.placeholder)}  ${st.muted(s.shape)}`,
                );
            }
          }
          ctx.out.line();
          ctx.out.line(`${st.muted("read")}  ${st.cmd(`jarvis show ${id} <type or name>`)}`);
        },
      );
      return;
    }
    const exact = all.filter(
      (a) => a.type === artifactRef || a.name === artifactRef || a.artifactId === artifactRef,
    );
    const matches = exact.length > 0 ? exact : all.filter((a) => `${a.type}/${a.name}`.includes(artifactRef));
    if (matches.length !== 1) {
      ctx.out.error(
        matches.length === 0
          ? `run ${id} has no artifact "${artifactRef}" (see \`jarvis show ${id}\`)`
          : `"${artifactRef}" matches ${matches.length} artifacts: ${matches.map((a) => `${a.type}/${a.name}`).join(", ")}`,
      );
      throw new CliExit(EXIT.error);
    }
    const a = matches[0] as (typeof all)[number];
    const text = runtime.artifacts.text(a);
    if (options.out) {
      mkdirSync(dirname(options.out), { recursive: true });
      writeFileSync(options.out, text);
      ctx.out.result({ artifact: a, file: options.out }, () =>
        ctx.out.line(`${st.ok("✓")} ${a.type}/${a.name}@${a.version} ${st.muted("→")} ${options.out}`),
      );
      return;
    }
    const state = stateOf(a);
    ctx.out.result(
      { artifact: a, state: state || undefined, incomplete: incompleteOf(a), content: text },
      () => {
        const who =
          a.provenance.kind === "agent"
            ? `agent ${a.provenance.agentId}`
            : a.provenance.kind === "human"
              ? `human ${a.provenance.actor.id}`
              : a.provenance.kind;
        ctx.out.line(
          `${st.name(`${a.type}/${a.name}@${a.version}`)}  ${st.muted(`run ${id} · ${a.stepId ?? "-"} · ${who}`)}${state ? `  ${state === "approved" ? st.ok(state) : st.warn(state)}` : ""}`,
        );
        const partial = incompleteOf(a);
        if (partial)
          ctx.out.line(
            `${st.warn("⚠")} ${st.warn(`incomplete: agent ${partial.agentId} hit its ${partial.limit} limit`)} ${st.muted("— what it did not cover is unknown; check before relying on it. More room for the next runs:")} ${st.cmd(`agents.${partial.agentId}.limits.max${partial.limit === "tool call" ? "Tool" : "Model"}Calls`)} ${st.muted("in .jarvis/project.yaml")}`,
          );
        ctx.out.line(st.muted("─".repeat(60)));
        // a result document reads as markdown; --raw (and --json) keep the JSON
        const doc = a.name.endsWith(".json") && !options.raw ? parseObject(text) : undefined;
        const body = doc ? documentToMarkdown(doc) : a.name.endsWith(".json") ? prettyJson(text) : text;
        ctx.out.raw(renderMarkdown(body.trimEnd(), st));
        ctx.out.line(st.muted("─".repeat(60)));
        if (state === "awaiting approval") {
          ctx.out.line(`${st.muted("accept ")} ${st.cmd(`jarvis approve ${id} --resume`)}`);
          ctx.out.line(
            `${st.muted("changes")} ${st.cmd(`jarvis approve ${id} --request-changes --comment "…" --resume`)}`,
          );
        }
        ctx.out.line(`${st.muted("save   ")} ${st.cmd(`jarvis show ${id} ${a.type} --out <file>`)}`);
      },
    );
  } finally {
    await runtime.close();
  }
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * `jarvis shell [run]`: a shell in a run's checkout (its worktree), so a person fixes something by
 * hand without copying the path; `--print` (or no terminal) prints the path for `cd "$(…)"`. Without
 * an id — the newest unfinished run of this repository.
 */
export async function runShellIn(
  ctx: CliContext,
  ref: string | undefined,
  options: { print?: boolean; shell?: ShellIn } = {},
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  let goOn: string | undefined;
  try {
    const st = ctx.out.style;
    const run = checkoutRun(ctx, runtime, loaded.project?.root ?? ctx.cwd, ref);
    const dir = run.workspace.path;
    const prompt = promptFor(ctx, runtime);
    prompt?.close();
    if (options.print || !prompt) {
      ctx.out.raw(`${dir}\n`);
      return;
    }
    const waits = ["WAITING_HUMAN", "SUSPENDED", "WAITING_BUDGET"].includes(run.state);
    ctx.out.line(
      `${st.muted("a shell in the checkout of run")} ${st.name(shortRunId(run.id))} ${checkoutLink(st, dir, ctx.homeDir)}`,
    );
    ctx.out.line(
      st.muted(
        waits
          ? "  fix, then type `jarvis c` — the run goes on; exit (Ctrl-D) leaves it waiting"
          : "  exit (Ctrl-D) to come back",
      ),
    );
    const end = await (options.shell ?? systemShell(ctx))(dir, run);
    const changes = changesIn(dir);
    if (changes && changes.length > 0) ctx.out.line(`${st.muted("changed:")} ${formatChanges(changes, st)}`);
    if (end === "go-on") goOn = run.id;
    else if (waits) ctx.out.line(`${st.muted("the run waits —")} ${st.cmd("jarvis continue")}`);
  } finally {
    await runtime.close();
  }
  // `jarvis c` typed in the shell: the run goes on here, as if typed after leaving it
  if (goOn) await runContinue(ctx, goOn);
}

/** The run whose checkout `shell`/`open` go to: by id, else the newest unfinished run here, else the newest. */
function checkoutRun(ctx: CliContext, runtime: Runtime, root: string, ref: string | undefined): Run {
  const here = runtime.runs
    .list({ includeTerminal: true, limit: 50 })
    .filter((r) => r.workspace.repoRoot === root || r.workspace.path === root);
  const run = ref
    ? requireRun(ctx, runtime, ref)
    : (here.find((r) => !["COMPLETED", "FAILED", "CANCELLED"].includes(r.state)) ?? here[0]);
  if (!run) {
    ctx.out.error("no run here (`jarvis status --all` lists every run)");
    throw new CliExit(EXIT.error);
  }
  if (!existsSync(run.workspace.path)) {
    ctx.out.error(`the checkout of run ${shortRunId(run.id)} is gone: ${run.workspace.path}`);
    throw new CliExit(EXIT.error);
  }
  return run;
}

/** `jarvis open [run]`: the run's checkout in the person's editor (the card's `o`). */
export async function runOpen(
  ctx: CliContext,
  ref: string | undefined,
  options: { open?: OpenIn } = {},
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const st = ctx.out.style;
    const run = checkoutRun(ctx, runtime, loaded.project?.root ?? ctx.cwd, ref);
    // what to look at: the reasons of a used-up loop first, then what the run changed
    const exhausted =
      run.waitingFor?.kind === "loop" ? runtime.artifacts.listLatest(run.id, "loop-exhausted")[0] : undefined;
    let reasons = "";
    try {
      const doc = exhausted
        ? (JSON.parse(runtime.artifacts.text(exhausted)) as { reason?: unknown })
        : undefined;
      reasons = typeof doc?.reason === "string" ? doc.reason : "";
    } catch {
      reasons = "";
    }
    const files = reviewFiles(run.workspace.path, run.workspace.baseCommit ?? run.workspace.baseRef, reasons);
    const editor = (options.open ?? systemOpener(ctx))(run.workspace.path, files);
    if (!editor) {
      ctx.out.error(
        `no editor found — set JARVIS_EDITOR (code, idea, webstorm…); the checkout is ${run.workspace.path}`,
      );
      throw new CliExit(EXIT.error);
    }
    ctx.out.line(
      `${st.ok("↗")} run ${st.name(shortRunId(run.id))} opened in ${editor}${files.length > 0 ? `: ${describeFiles(files)}` : ""}  ${checkoutLink(st, run.workspace.path, ctx.homeDir)}`,
    );
  } finally {
    await runtime.close();
  }
}

/**
 * `jarvis forget <run…> | --all [--yes]`: finished runs leave Jarvis's store (src/app/forget.ts) —
 * and their checkouts and branches, if gc has not taken them yet. Asks first at a terminal; without
 * one, `--yes` is required.
 */
export async function runForget(
  ctx: CliContext,
  refs: readonly string[],
  options: { all?: boolean; yes?: boolean },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  const prompt = promptFor(ctx, runtime);
  try {
    const st = ctx.out.style;
    const root = loaded.project?.root ?? ctx.cwd;
    const runs = options.all
      ? runtime.runs
          .list({ includeTerminal: true, limit: 10_000 })
          .filter((r) => canForget(r) && (r.workspace.repoRoot === root || r.workspace.path === root))
      : refs.map((ref) => requireRun(ctx, runtime, ref));
    if (runs.length === 0) {
      ctx.out.line(`nothing to forget here ${st.muted("(only finished runs are forgotten)")}`);
      return;
    }
    const busy = runs.filter((r) => !canForget(r));
    if (busy.length > 0) {
      ctx.out.error(
        `${busy.map((r) => `${shortRunId(r.id)} is ${r.state}`).join(", ")}: only finished runs are forgotten — \`jarvis cancel\` first`,
      );
      throw new CliExit(EXIT.error);
    }
    for (const r of runs)
      ctx.out.line(
        `  ${st.name(shortRunId(r.id))}  ${st.muted(r.state.toLowerCase())}  ${oneLine(r.task, 70)}`,
      );
    if (!options.yes) {
      if (!prompt) {
        ctx.out.error("forgetting cannot be undone: add --yes to confirm without a terminal");
        throw new CliExit(EXIT.error);
      }
      const answer = await prompt.ask(
        `forget ${runs.length} run(s), their artifacts and events? ${st.muted("[y/N]")} `,
      );
      if (answer?.toLowerCase() !== "y") {
        ctx.out.line(st.muted("nothing forgotten"));
        return;
      }
    }
    for (const r of runs)
      if (r.workspace.mode === "worktree" && existsSync(r.workspace.path))
        await new WorktreeWorkspace(r.workspace, ctx.env).remove({ pruneBranch: true });
    const done = forgetRuns(runtime, runs);
    ctx.out.result(done, () =>
      ctx.out.line(
        `${st.ok("✓")} forgot ${done.runs} run(s): ${done.artifacts} artifact version(s), ${done.events} event(s), ${done.blobs} stored document(s)`,
      ),
    );
  } finally {
    prompt?.close();
    await runtime.close();
  }
}

/** A service's knowledge repository as the run starts with it, for `run.created` (ADR-0025 §5). */
async function knowledgeRepoInputsOf(repoRoot: string) {
  const knowledgeRepo = await recordKnowledgeRepoInputs(repoRoot);
  return knowledgeRepo ? { knowledgeRepo } : {};
}

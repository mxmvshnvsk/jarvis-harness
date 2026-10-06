import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { awaitedArtifact, recordDecision } from "../../app/decide.ts";
import { createEngine } from "../../app/engine.ts";
import { preflightMcp } from "../../app/preflight.ts";
import { createRuntime, type Runtime } from "../../app/runtime.ts";
import { runDetail } from "../../app/status.ts";
import { resolveActor } from "../../core/actor/resolve.ts";
import type { Actor } from "../../core/domain/actor.ts";
import type { ApprovalDecision } from "../../core/domain/artifact.ts";
import type { Run, WorkspaceRef } from "../../core/domain/run.ts";
import { removeMarkers } from "../../interaction/review/collector.ts";
import { daemonTick } from "../../orchestration/daemon.ts";
import { leaseOwner } from "../../orchestration/lease.ts";
import type { LocalWorkflowEngine } from "../../orchestration/runtime.ts";
import { LeaseHeldError } from "../../orchestration/types.ts";
import { gitIdentityEnv, WorktreeError, WorktreeWorkspace } from "../../orchestration/worktree.ts";
import { LeaseLostError, newRunId, shortRunId } from "../../storage/runStore.ts";
import { git } from "../../tools/local/exec.ts";
import type { CliContext } from "../context.ts";
import { humanGate } from "../gate.ts";
import { CliExit, EXIT } from "../output.ts";
import { followRun, formatRunHeader, oneLine } from "../progress.ts";
import { createPrompt, isInteractive, type Prompt } from "../prompt.ts";
import { documentToMarkdown, renderDiff, renderMarkdown } from "../render.ts";
import { incompleteOf, padStyled } from "../style.ts";
import { loadForCli } from "./config.ts";
import { renderSummary } from "./status.ts";

async function actorFor(ctx: CliContext, runtime: Runtime): Promise<Actor> {
  const resolved = await resolveActor(runtime.loaded.config, ctx.env, runtime.loaded.project?.root);
  if (!resolved.actor) {
    ctx.out.error(
      "cannot determine the actor: set JARVIS_ACTOR, actor.id or git config user.email (ADR-0006)",
    );
    throw new CliExit(EXIT.error);
  }
  return resolved.actor;
}

function requireRun(ctx: CliContext, runtime: Runtime, ref: string): Run {
  const run = runtime.runs.resolve(ref);
  if (!run) {
    ctx.out.error(`run "${ref}" not found (see \`jarvis status --all\`)`);
    throw new CliExit(EXIT.error);
  }
  return run;
}

async function executeAndReport(
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
): Promise<never> {
  const owner = leaseOwner(runtime.loaded.config.interactive ? "cli" : "ci");
  const plan = planOf(engine, run);
  // a person at a terminal decides where the run stops and it goes on; otherwise exit 10 + commands
  const prompt = shared ?? promptFor(ctx, runtime);
  try {
    let header = showHeader;
    let stealLease = steal;
    for (;;) {
      const progress = followRun(ctx, runtime, { runId: run.id, plan, header });
      const result = await engine
        .execute(run.id, { owner, steal: stealLease })
        .finally(() => progress.stop());
      header = false;
      stealLease = false;
      if (prompt && result.exitCode === EXIT.waitingHuman) {
        const actor = await actorFor(ctx, runtime);
        if ((await humanGate(ctx, runtime, result.run, actor, prompt)) === "decided") continue;
        ctx.out.line(
          `${ctx.out.style.muted("left waiting; come back with")} ${ctx.out.style.cmd("jarvis continue")}`,
        );
      }
      const detail = runDetail(runtime, result.run);
      ctx.out.result({ ...extra, ...detail, exitCode: result.exitCode }, () => renderSummary(ctx, detail));
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
      const waiting = runtime.runs
        .list({ state: ["WAITING_HUMAN"], limit: 50 })
        .filter((r) => r.workspace.repoRoot === root || r.workspace.path === root);
      if (waiting.length === 0) {
        ctx.out.line(`nothing waits for you here ${st.muted("(`jarvis status --all` lists every run)")}`);
        return;
      }
      if (waiting.length === 1 || !prompt) {
        if (waiting.length > 1) {
          ctx.out.error(
            `${waiting.length} runs wait for you: ${waiting.map((r) => shortRunId(r.id)).join(", ")} — \`jarvis continue <run>\``,
          );
          throw new CliExit(EXIT.error);
        }
        run = waiting[0];
      } else {
        ctx.out.line(st.heading(`${waiting.length} runs wait for you`));
        waiting.forEach((r, i) => {
          ctx.out.line(
            `  ${st.cmd(String(i + 1))}  ${st.name(shortRunId(r.id))}  ${r.workflow} ${st.muted("·")} ${oneLine(r.task, 60)} ${st.muted(`· ${r.currentStep ?? "-"}`)}`,
          );
        });
        const pick = Number(await prompt.ask(`${st.cmd(">")} `));
        run = waiting[pick - 1];
        if (!run) return;
      }
    }
    if (!run) return;
    if (run.state === "WAITING_HUMAN") {
      for (const line of formatRunHeader(run, planOf(engine, run), st)) ctx.out.line(line);
      if (!prompt) {
        const detail = runDetail(runtime, run);
        ctx.out.result(detail, () => renderSummary(ctx, detail));
        throw new CliExit(EXIT.waitingHuman);
      }
      const actor = await actorFor(ctx, runtime);
      if ((await humanGate(ctx, runtime, run, actor, prompt)) !== "decided") {
        ctx.out.line(`${st.muted("left waiting; come back with")} ${st.cmd("jarvis continue")}`);
        throw new CliExit(EXIT.waitingHuman);
      }
    }
    await executeAndReport(ctx, runtime, engine, run, false, {}, prompt, run.state !== "WAITING_HUMAN");
  } finally {
    prompt?.close();
    await runtime.close();
  }
}

/** `jarvis work <task>` — create a run and execute it in the foreground (ADR-0001 §15). */
export async function runWork(
  ctx: CliContext,
  task: string,
  options: { workflow?: string; noRun?: boolean; base?: string },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const engine = createEngine(runtime);
    const workflowName = options.workflow ?? "sdd";
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
    const root = loaded.project?.root ?? ctx.cwd;
    const runId = newRunId();
    const useWorktree = loaded.config.workspace.mode === "worktree" && loaded.project?.isGitRepo === true;
    let workspace: WorkspaceRef = {
      mode: "cwd",
      repoRoot: root,
      path: root,
      baseRef: options.base ?? "HEAD",
    };
    if (useWorktree) {
      if (await WorktreeWorkspace.isDirty(root)) {
        ctx.out.note(
          `${ctx.out.errStyle.warn("note:")} the working tree has uncommitted changes; the run starts from the last commit (ADR-0003 §2)`,
        );
      }
      try {
        const wt = await WorktreeWorkspace.create({
          repoRoot: root,
          worktreesDir: loaded.home.worktreesDir,
          runId,
          task,
          ...(options.base ? { baseRef: options.base } : {}),
          ...(loaded.config.workspace.setup ? { setup: loaded.config.workspace.setup } : {}),
          setupTimeoutMs: loaded.config.tools.commandTimeoutMs,
          env: ctx.env,
        });
        workspace = wt.ref;
      } catch (error) {
        if (error instanceof WorktreeError) {
          ctx.out.error(error.message);
          throw new CliExit(EXIT.error);
        }
        throw error;
      }
    }
    const run = runtime.runs.create({
      id: runId,
      task,
      workflow: workflowName,
      owner: actor,
      workspace,
      dataClass: loaded.config.dataClass,
      ...(loaded.config.profile ? { profile: loaded.config.profile } : {}),
    });
    runtime.events.emit({
      kind: "run.created",
      runId: run.id,
      actor: `${actor.kind}:${actor.id}`,
      payload: { task, workflow: workflowName },
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
    const approval = recordDecision(runtime, run, {
      actor,
      artifact: latest,
      type,
      decision,
      ...(options.comment ? { comment: options.comment } : {}),
    });
    let committed: string | undefined;
    if (options.commit) {
      const root = loaded.project?.root ?? ctx.cwd;
      const file = join(root, ".jarvis", "approvals", run.task, `${type}.json`);
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
      const rel = relative(root, file);
      const add = await git(["add", rel], root);
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
              root,
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
      const report = await daemonTick(runtime, engine);
      ctx.out.result(report, () => {
        const line = `${report.at} considered ${report.considered}, resumed ${report.resumed.length}, skipped ${report.skipped.length}`;
        ctx.out.line(line);
        for (const r of report.resumed) ctx.out.line(`  resumed ${shortRunId(r.runId)} → ${r.state}`);
        for (const s of report.skipped) ctx.out.line(`  skipped ${shortRunId(s.runId)}: ${s.reason}`);
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

/** `jarvis apply <run>` — squash the run branch onto the current branch (ADR-0003 §4). */
export async function runApply(ctx: CliContext, ref: string, options: { message?: string }): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const run = requireRun(ctx, runtime, ref);
    if (run.workspace.mode !== "worktree") {
      ctx.out.error("this run works in the current checkout (cwd mode); nothing to apply");
      throw new CliExit(EXIT.error);
    }
    const actor = await actorFor(ctx, runtime);
    const wt = WorktreeWorkspace.open(run.workspace, ctx.env, {
      name: actor.display ?? actor.id,
      email: actor.id,
    });
    try {
      if (loaded.config.human.review.removeMarkersAfterApproval) {
        // ADR-0019 §5: markers leave the code once the work is approved; threads stay in the store.
        const stripped = await removeMarkers(run.workspace.path);
        if (stripped.length > 0) {
          await wt.checkpoint("jarvis: remove review markers", {
            "Jarvis-Run": run.id,
            "Jarvis-Kind": "review-cleanup",
          });
          runtime.events.emit({ kind: "review.markersRemoved", runId: run.id, payload: { files: stripped } });
        }
      }
      const trailer = `Jarvis-Run: ${run.id}`;
      const message = options.message
        ? options.message.includes(trailer)
          ? options.message
          : `${options.message.trimEnd()}\n\n${trailer}`
        : `${run.task}: apply jarvis run ${shortRunId(run.id)}\n\n${trailer}`;
      const result = await wt.apply(message);
      runtime.events.emit({
        kind: "run.applied",
        runId: run.id,
        actor: `${actor.kind}:${actor.id}`,
        payload: { commit: result.commit, files: result.files.length },
      });
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
      await new WorktreeWorkspace(run.workspace, ctx.env).remove({
        pruneBranch: options.pruneBranches === true,
      });
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
      ctx.out.result(
        { run: run.id, artifacts: all.map((a) => ({ ...a, state: stateOf(a) || undefined })) },
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
              `  ${padStyled(`${a.type}/${a.name}@${a.version}`, w)}  ${st.muted(padStyled(a.stepId ? `${a.stepId}${a.iteration && a.iteration > 1 ? `#${a.iteration}` : ""}` : "-", 16))} ${state === "approved" ? st.ok(state) : st.warn(state)}${partial ? ` ${st.warn(`⚠ incomplete (${partial.limit} limit)`)}` : ""}`.trimEnd(),
            );
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

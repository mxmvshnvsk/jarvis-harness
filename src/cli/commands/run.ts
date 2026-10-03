import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
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
import { CliExit, EXIT } from "../output.ts";
import { loadForCli } from "./config.ts";
import { renderDetail } from "./status.ts";

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
): Promise<never> {
  const owner = leaseOwner(runtime.loaded.config.interactive ? "cli" : "ci");
  try {
    const result = await engine.execute(run.id, { owner, steal });
    const detail = runDetail(runtime, result.run);
    ctx.out.result({ ...extra, ...detail, exitCode: result.exitCode }, () =>
      renderDetail(ctx, detail, new Date(), 8),
    );
    throw new CliExit(result.exitCode);
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
        ctx.out.error(
          "note: the working tree has uncommitted changes; the run starts from the last commit (ADR-0003 §2)",
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
    const checkpoint = runtime.checkpoints.latest(run.id);
    const awaiting = checkpoint?.state.awaitingApproval as { artifactId?: string; type?: string } | undefined;
    const type = options.type ?? awaiting?.type;
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
    const approval = runtime.artifacts.approve({
      runId: run.id,
      stepId: checkpoint?.stepId ?? run.currentStep ?? "approve",
      artifactId: latest.artifactId,
      version: latest.version,
      actor,
      decision,
      ...(options.comment ? { comment: options.comment } : {}),
    });
    runtime.events.emit({
      kind: "approval.recorded",
      runId: run.id,
      stepId: approval.stepId,
      actor: `${actor.kind}:${actor.id}`,
      payload: { artifactId: latest.artifactId, version: latest.version, type, decision },
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
      ctx.out.line(
        diff.length > 0
          ? diff
          : `no changes on ${run.workspace.branch} since ${run.workspace.baseCommit?.slice(0, 10)}`,
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

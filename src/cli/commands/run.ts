import { createEngine } from "../../app/engine.ts";
import { createRuntime, type Runtime } from "../../app/runtime.ts";
import { runDetail } from "../../app/status.ts";
import { resolveActor } from "../../core/actor/resolve.ts";
import type { Actor } from "../../core/domain/actor.ts";
import type { ApprovalDecision } from "../../core/domain/artifact.ts";
import type { Run } from "../../core/domain/run.ts";
import { daemonTick } from "../../orchestration/daemon.ts";
import { leaseOwner } from "../../orchestration/lease.ts";
import type { LocalWorkflowEngine } from "../../orchestration/runtime.ts";
import { LeaseHeldError } from "../../orchestration/types.ts";
import { LeaseLostError, shortRunId } from "../../storage/runStore.ts";
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
): Promise<never> {
  const owner = leaseOwner(runtime.loaded.config.interactive ? "cli" : "ci");
  try {
    const result = await engine.execute(run.id, { owner, steal });
    const detail = runDetail(runtime, result.run);
    ctx.out.result({ ...detail, exitCode: result.exitCode }, () => renderDetail(ctx, detail, new Date(), 8));
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
  options: { workflow?: string; noRun?: boolean },
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const engine = createEngine(runtime);
    const workflowName = options.workflow ?? "sdd";
    engine.workflow(workflowName);
    const actor = await actorFor(ctx, runtime);
    const root = loaded.project?.root ?? ctx.cwd;
    const run = runtime.runs.create({
      task,
      workflow: workflowName,
      owner: actor,
      workspace: { mode: "cwd", repoRoot: root, path: root, baseRef: "HEAD" },
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
    runtime.close();
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
    runtime.close();
  }
}

export interface ApproveOptions {
  readonly type?: string;
  readonly decision?: ApprovalDecision;
  readonly comment?: string;
  readonly resume?: boolean;
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
    ctx.out.result(approval, () =>
      ctx.out.line(`${decision}: ${type}/${latest.name}@${latest.version} by ${actor.id}`),
    );
    if (options.resume) {
      await executeAndReport(ctx, runtime, createEngine(runtime), run, false);
    }
  } finally {
    runtime.close();
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
    runtime.close();
  }
}

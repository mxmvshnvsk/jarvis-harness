import { formatActivity } from "../../app/activity.ts";
import { createRuntime } from "../../app/runtime.ts";
import { type PoolStatus, type RunDetail, runDetail, runsOverview } from "../../app/status.ts";
import { isTerminal } from "../../core/domain/run.ts";
import { shortRunId } from "../../storage/runStore.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT, padEnd } from "../output.ts";
import { loadForCli } from "./config.ts";

export interface StatusOptions {
  readonly all?: boolean;
  readonly watch?: number;
  readonly events?: number;
}

function ago(iso: string, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function fmtPool(p: PoolStatus): string {
  const out =
    p.limits.outputTokens !== undefined
      ? `${p.usage.outputTokens}/${p.limits.outputTokens}`
      : `${p.usage.outputTokens}`;
  const req =
    p.limits.requests !== undefined ? `${p.usage.requests}/${p.limits.requests}` : `${p.usage.requests}`;
  const soft = p.pressure >= p.soft ? " SOFT" : "";
  return `${p.pool}: ${out} output tokens, ${req} requests in ${p.windowMinutes}m window (${Math.round(p.pressure * 100)}%${soft})`;
}

export async function runStatus(
  ctx: CliContext,
  runRef: string | undefined,
  options: StatusOptions = {},
): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const render = () =>
      runRef ? renderRun(ctx, runtime, runRef, options) : renderOverview(ctx, runtime, options);
    const watch = options.watch;
    if (watch && !ctx.out.json) {
      const started = Date.now();
      for (;;) {
        ctx.out.line("\u001b[2J\u001b[H");
        render();
        ctx.out.line("");
        ctx.out.line(
          `watching every ${watch}s for ${Math.round((Date.now() - started) / 1000)}s — Ctrl-C to stop`,
        );
        // ADR-0018: a watch ends on its own when there is nothing left to watch.
        const run = runRef ? runtime.runs.resolve(runRef) : undefined;
        if (
          run &&
          (run.state === "COMPLETED" ||
            run.state === "FAILED" ||
            run.state === "CANCELLED" ||
            run.state === "WAITING_HUMAN")
        ) {
          const hint =
            run.state === "WAITING_HUMAN"
              ? `run waits for a human${run.waitingFor ? ` (${run.waitingFor.kind})` : ""}: see the hint above`
              : `run ${run.state.toLowerCase()}`;
          ctx.out.line(`\u0007${hint}; stopped watching`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, watch * 1000));
      }
      return;
    }
    render();
  } finally {
    await runtime.close();
  }
}

function renderOverview(
  ctx: CliContext,
  runtime: ReturnType<typeof createRuntime>,
  options: StatusOptions,
): void {
  const now = new Date();
  const overview = runsOverview(runtime, { includeTerminal: options.all ?? false });
  ctx.out.result(overview, () => {
    if (overview.runs.length === 0) {
      ctx.out.line(options.all ? "no runs" : "no active runs (use --all to include completed and cancelled)");
    } else {
      const w = Math.max(...overview.runs.map((r) => r.task.length), 4);
      ctx.out.line(
        `${padEnd("run", 8)}  ${padEnd("task", w)}  ${padEnd("state", 15)}  ${padEnd("step", 22)}  ${padEnd("updated", 9)}  lease`,
      );
      for (const r of overview.runs) {
        const step = r.currentStep ? `${r.currentStep}#${r.currentIteration}` : "-";
        const live = r.lease && Date.parse(r.lease.until) >= now.getTime();
        const lease = live
          ? (r.lease as { owner: string }).owner
          : r.cancelRequested
            ? "cancel requested"
            : "-";
        ctx.out.line(
          `${padEnd(shortRunId(r.id), 8)}  ${padEnd(r.task, w)}  ${padEnd(r.state, 15)}  ${padEnd(step, 22)}  ${padEnd(ago(r.updatedAt, now), 9)}  ${lease}`,
        );
      }
    }
    if (overview.pools.length > 0) {
      ctx.out.line();
      ctx.out.line("budget:");
      for (const p of overview.pools) ctx.out.line(`  ${fmtPool(p)}`);
    }
  });
}

function renderRun(
  ctx: CliContext,
  runtime: ReturnType<typeof createRuntime>,
  runRef: string,
  options: StatusOptions,
): void {
  const run = runtime.runs.resolve(runRef);
  if (!run) {
    ctx.out.error(`run "${runRef}" not found (use \`jarvis status --all\`)`);
    throw new CliExit(EXIT.error);
  }
  const now = new Date();
  const detail = runDetail(runtime, run, now);
  ctx.out.result(detail, () => renderDetail(ctx, detail, now, options.events ?? 10));
  if (!ctx.out.json) return;
}

export function renderDetail(ctx: CliContext, d: RunDetail, now: Date, eventLimit: number): void {
  const { out } = ctx;
  const r = d.run;
  out.line(`run ${r.id}  (${shortRunId(r.id)})`);
  out.line(
    `  task       ${r.task}    workflow ${r.workflow}    dataClass ${r.dataClass}${r.profile ? `    profile ${r.profile}` : ""}`,
  );
  out.line(
    `  state      ${r.state}${r.stateReason ? ` — ${r.stateReason}` : ""}${r.cancelRequested ? "  (cancel requested)" : ""}`,
  );
  out.line(`  step       ${r.currentStep ? `${r.currentStep} #${r.currentIteration}` : "-"}`);
  // ADR-0018: what the run does right now — the same line the foreground command draws
  if (d.activity && !d.activity.finished && r.state === "RUNNING")
    out.line(`  now        ${formatActivity(d.activity, d.activityOptions ?? {})}`);
  const capsArtifact = d.artifacts.find((a) => a.type === "project-capabilities");
  if (capsArtifact && d.capabilities) {
    out.line(
      `  stack      ${d.capabilities.stacks.join(", ") || "-"}    level ${d.capabilities.level}${d.capabilities.adapters.length > 0 ? `    adapters ${d.capabilities.adapters.map((a) => a.id).join(", ")}` : ""}`,
    );
  }
  if (r.waitingFor) {
    const w = r.waitingFor;
    const hint =
      w.kind === "clarification"
        ? `jarvis attach ${shortRunId(r.id)} | jarvis answer ${w.interactionId ?? ""} "…"`
        : w.kind === "approval"
          ? `jarvis approve ${shortRunId(r.id)} | jarvis review submit ${shortRunId(r.id)}`
          : "";
    out.line(
      `  waiting    ${w.kind}${w.detail ? ` (${w.detail})` : ""}${w.interactionId ? `  thread ${w.interactionId}` : ""}${hint ? `  → ${hint}` : ""}`,
    );
  }
  for (const i of d.interactions) {
    out.line(
      `  thread     ${i.id}  ${i.kind}  ${i.state}  ${i.stepId} #${i.iteration}${i.contentRef ? `  ${i.contentRef}` : ""}`,
    );
  }
  out.line(
    `  owner      ${r.owner.kind}:${r.owner.id}    created ${ago(r.createdAt, now)}    updated ${ago(r.updatedAt, now)}`,
  );
  out.line(
    `  workspace  ${r.workspace.mode} ${r.workspace.path}${r.workspace.branch ? ` (${r.workspace.branch})` : ""}${r.workspace.headCommit ? ` @ ${r.workspace.headCommit.slice(0, 10)}` : ""}`,
  );
  out.line(
    `  lease      ${r.lease ? `${r.lease.owner} epoch ${r.lease.epoch} ${d.leaseLive ? "live" : "expired"}` : "-"}`,
  );
  const loops = Object.entries(r.iterations).filter(([, n]) => n > 0);
  if (loops.length > 0) out.line(`  loops      ${loops.map(([e, n]) => `${e} ×${n}`).join(", ")}`);

  out.line();
  out.line(
    `tokens     ${d.tokens.calls} calls, ${d.tokens.promptTokens} prompt (${d.tokens.cachedTokens} cached), ${d.tokens.outputTokens} output, ${d.tokens.retries} retries`,
  );

  if (d.steps.length > 0) {
    out.line();
    out.line("steps:");
    for (const s of d.steps.slice(-10)) {
      const status = s.status ? `${s.status}${s.outcome ? ` → ${s.outcome}` : ""}` : "running";
      out.line(
        `  ${padEnd(`${s.stepId} #${s.iteration}`, 24)} ${padEnd(status, 28)} ${ago(s.startedAt, now)}`,
      );
    }
  }
  if (d.checkpoint) {
    out.line();
    out.line(
      `checkpoint ${d.checkpoint.kind} at ${d.checkpoint.stepId} #${d.checkpoint.iteration}${d.checkpoint.headCommit ? ` @ ${d.checkpoint.headCommit.slice(0, 10)}` : ""} (${ago(d.checkpoint.createdAt, now)})`,
    );
  }
  if (d.artifacts.length > 0) {
    out.line();
    out.line("artifacts:");
    for (const a of d.artifacts) {
      const who =
        a.provenance.kind === "human"
          ? `human:${a.provenance.actor.id}`
          : a.provenance.kind === "agent"
            ? `agent:${a.provenance.agentId}`
            : a.provenance.kind;
      const gate = d.pendingApprovals.some((p) => p.artifactId === a.artifactId)
        ? "  AWAITING APPROVAL"
        : a.approved
          ? "  approved"
          : "";
      out.line(
        `  ${padEnd(`${a.type}/${a.name}@${a.version}`, 32)} ${padEnd(who, 24)} ${ago(a.createdAt, now)}${gate}`,
      );
    }
  }
  const effectTotal = Object.values(d.effects.counts).reduce((a, b) => a + b, 0);
  if (effectTotal > 0) {
    out.line();
    out.line(
      `effects    ${Object.entries(d.effects.counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ")}`,
    );
    for (const e of d.effects.recent)
      out.line(
        `  ${padEnd(e.capability, 24)} ${padEnd(e.status, 9)} ${e.key.slice(0, 12)} ${ago(e.createdAt, now)}`,
      );
  }
  if (d.events.length > 0) {
    out.line();
    out.line("events:");
    for (const e of d.events.slice(-eventLimit)) {
      const p = e.payload ?? {};
      const brief =
        e.kind === "model.call"
          ? `${String(p.modelId)} ${String(p.promptTokens)}→${String(p.outputTokens)} tok ${String(p.latencyMs)}ms`
          : e.kind.startsWith("effect")
            ? String(p.capability ?? "")
            : "";
      out.line(`  ${padEnd(e.kind, 18)} ${padEnd(brief, 40)} ${ago(e.ts, now)}`);
    }
  }
}

export async function runCancel(ctx: CliContext, runRef: string): Promise<void> {
  const loaded = await loadForCli(ctx);
  const runtime = createRuntime(loaded, { env: ctx.env });
  try {
    const run = runtime.runs.resolve(runRef);
    if (!run) {
      ctx.out.error(`run "${runRef}" not found`);
      throw new CliExit(EXIT.error);
    }
    // pilot: cancelling a run that had already completed printed "held by undefined; cancel requested"
    if (isTerminal(run.state)) {
      ctx.out.result({ id: run.id, state: run.state, cancelRequested: false }, () =>
        ctx.out.line(`run ${shortRunId(run.id)} is already ${run.state}; nothing to cancel`),
      );
      return;
    }
    const updated = runtime.runs.requestCancel(run.id);
    runtime.events.emit({
      kind: "run.cancel",
      runId: run.id,
      payload: { immediate: updated.state === "CANCELLED" },
    });
    ctx.out.result({ id: updated.id, state: updated.state, cancelRequested: updated.cancelRequested }, () => {
      ctx.out.line(
        updated.state === "CANCELLED"
          ? `run ${shortRunId(updated.id)} cancelled`
          : `run ${shortRunId(updated.id)} is held by ${updated.lease?.owner}; cancel requested — it stops at the next safe point`,
      );
    });
  } finally {
    await runtime.close();
  }
}

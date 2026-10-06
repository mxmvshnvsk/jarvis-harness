import { formatActivity, kilo } from "../../app/activity.ts";
import { duration } from "../../app/journey.ts";
import { createRuntime } from "../../app/runtime.ts";
import { type PoolStatus, type RunDetail, runDetail, runsOverview } from "../../app/status.ts";
import { isTerminal } from "../../core/domain/run.ts";
import { shortRunId } from "../../storage/runStore.ts";
import type { CliContext } from "../context.ts";
import { CliExit, EXIT, padEnd } from "../output.ts";
import { oneLine } from "../progress.ts";
import { incompleteOf } from "../style.ts";
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
      // a task can be a paragraph (onboarding prompts): its first line, cut, plain — a column, not a document
      const taskOf = (task: string) => oneLine(task.replace(/`/g, ""), 48);
      const w = Math.max(...overview.runs.map((r) => [...taskOf(r.task)].length), 4);
      const st = ctx.out.style;
      ctx.out.line(
        st.heading(
          `${padEnd("run", 8)}  ${padEnd("task", w)}  ${padEnd("state", 15)}  ${padEnd("step", 22)}  ${padEnd("updated", 9)}  lease`,
        ),
      );
      for (const r of overview.runs) {
        const step = r.currentStep ? `${r.currentStep}#${r.currentIteration}` : "-";
        const live = r.lease && Date.parse(r.lease.until) >= now.getTime();
        // RUNNING without a live lease: the process that ran it is gone (Ctrl-C, crash, closed terminal)
        const orphan = r.state === "RUNNING" && !live;
        const lease = live
          ? st.muted((r.lease as { owner: string }).owner)
          : orphan
            ? `${st.warn(`no process${r.cancelRequested ? ", cancel requested" : ""}`)} ${st.muted("→")} ${st.cmd(`jarvis resume|cancel ${shortRunId(r.id)}`)}`
            : r.cancelRequested
              ? st.warn("cancel requested")
              : st.muted("-");
        ctx.out.line(
          `${st.name(padEnd(shortRunId(r.id), 8))}  ${padEnd(taskOf(r.task), w)}  ${st.byState(r.state, padEnd(r.state, 15))}  ${padEnd(step, 22)}  ${st.muted(padEnd(ago(r.updatedAt, now), 9))}  ${lease}`,
        );
      }
    }
    if (overview.pools.length > 0) {
      ctx.out.line();
      ctx.out.line(ctx.out.style.heading("budget:"));
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
  const st = out.style;
  // field labels dim, values plain: `  task       …`
  const f = (label: string) => `  ${st.muted(padEnd(label, 10))} `;
  const r = d.run;
  out.line(`${st.heading("run")} ${st.name(r.id)}  ${st.muted(`(${shortRunId(r.id)})`)}`);
  out.line(
    `${f("task")}${oneLine(r.task, 120)}    ${st.muted("workflow")} ${r.workflow}    ${st.muted("dataClass")} ${r.dataClass}${r.profile ? `    ${st.muted("profile")} ${r.profile}` : ""}`,
  );
  out.line(
    `${f("state")}${st.state(r.state)}${r.stateReason ? ` ${st.muted("—")} ${r.stateReason}` : ""}${r.cancelRequested ? `  ${st.warn("(cancel requested)")}` : ""}`,
  );
  if (r.state === "RUNNING" && !d.leaseLive)
    out.line(
      `             ${st.warn("no process holds it (interrupted or crashed):")} ${st.cmd(`jarvis resume ${shortRunId(r.id)}`)} ${st.muted("|")} ${st.cmd(`jarvis cancel ${shortRunId(r.id)}`)}`,
    );
  out.line(`${f("step")}${r.currentStep ? `${r.currentStep} #${r.currentIteration}` : "-"}`);
  // ADR-0018: what the run does right now — the same line the foreground command draws
  if (d.activity && !d.activity.finished && r.state === "RUNNING")
    out.line(`${f("now")}${formatActivity(d.activity, d.activityOptions ?? {})}`);
  const capsArtifact = d.artifacts.find((a) => a.type === "project-capabilities");
  if (capsArtifact && d.capabilities) {
    out.line(
      `${f("stack")}${d.capabilities.stacks.join(", ") || "-"}    level ${d.capabilities.level}${d.capabilities.adapters.length > 0 ? `    adapters ${d.capabilities.adapters.map((a) => a.id).join(", ")}` : ""}`,
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
      `${f("waiting")}${st.warn(w.kind)}${w.detail ? ` (${w.detail})` : ""}${w.interactionId ? `  ${st.muted("thread")} ${w.interactionId}` : ""}${hint ? `  ${st.muted("→")} ${st.cmd(hint)}` : ""}`,
    );
  }
  for (const i of d.interactions) {
    out.line(
      `${f("thread")}${i.id}  ${i.kind}  ${i.state}  ${i.stepId} #${i.iteration}${i.contentRef ? `  ${i.contentRef}` : ""}`,
    );
  }
  out.line(
    `${f("owner")}${r.owner.kind}:${r.owner.id}    ${st.muted(`created ${ago(r.createdAt, now)}    updated ${ago(r.updatedAt, now)}`)}`,
  );
  out.line(
    `${f("workspace")}${r.workspace.mode} ${r.workspace.path}${r.workspace.branch ? ` (${r.workspace.branch})` : ""}${r.workspace.headCommit ? ` @ ${r.workspace.headCommit.slice(0, 10)}` : ""}`,
  );
  out.line(
    `${f("lease")}${r.lease ? `${r.lease.owner} ${st.muted(`epoch ${r.lease.epoch}`)} ${d.leaseLive ? st.ok("live") : st.muted("expired")}` : "-"}`,
  );
  const loops = Object.entries(r.iterations).filter(([, n]) => n > 0);
  if (loops.length > 0) out.line(`${f("loops")}${loops.map(([e, n]) => `${e} ×${n}`).join(", ")}`);

  out.line();
  out.line(
    `${st.heading("tokens")}     ${d.tokens.calls} calls, ${d.tokens.promptTokens} prompt ${st.muted(`(${d.tokens.cachedTokens} cached)`)}, ${d.tokens.outputTokens} output, ${d.tokens.retries > 0 ? st.warn(`${d.tokens.retries} retries`) : `${d.tokens.retries} retries`}`,
  );

  if (d.steps.length > 0) {
    out.line();
    out.line(st.heading("steps:"));
    for (const s of d.steps.slice(-10)) {
      const status = s.status ? `${s.status}${s.outcome ? ` → ${s.outcome}` : ""}` : "running";
      out.line(
        `  ${padEnd(`${s.stepId} #${s.iteration}`, 24)} ${st.byState(s.status ?? "RUNNING", padEnd(status, 28))} ${st.muted(ago(s.startedAt, now))}`,
      );
    }
  }
  if (d.checkpoint) {
    out.line();
    out.line(
      `${st.heading("checkpoint")} ${d.checkpoint.kind} at ${d.checkpoint.stepId} #${d.checkpoint.iteration}${d.checkpoint.headCommit ? ` @ ${d.checkpoint.headCommit.slice(0, 10)}` : ""} (${ago(d.checkpoint.createdAt, now)})`,
    );
  }
  if (d.artifacts.length > 0) {
    out.line();
    out.line(st.heading("artifacts:"));
    for (const a of d.artifacts) {
      const who =
        a.provenance.kind === "human"
          ? `human:${a.provenance.actor.id}`
          : a.provenance.kind === "agent"
            ? `agent:${a.provenance.agentId}`
            : a.provenance.kind;
      const gate = d.pendingApprovals.some((p) => p.artifactId === a.artifactId)
        ? `  ${st.warn("AWAITING APPROVAL")}`
        : a.approved
          ? `  ${st.ok("approved")}`
          : "";
      out.line(
        `  ${padEnd(`${a.type}/${a.name}@${a.version}`, 32)} ${st.muted(padEnd(who, 24))} ${st.muted(ago(a.createdAt, now))}${gate}`,
      );
    }
  }
  const effectTotal = Object.values(d.effects.counts).reduce((a, b) => a + b, 0);
  if (effectTotal > 0) {
    out.line();
    out.line(
      `${st.heading("effects")}    ${Object.entries(d.effects.counts)
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
    out.line(st.heading("events:"));
    for (const e of d.events.slice(-eventLimit)) {
      const p = e.payload ?? {};
      const brief =
        e.kind === "model.call"
          ? `${String(p.modelId)} ${String(p.promptTokens)}→${String(p.outputTokens)} tok ${String(p.latencyMs)}ms`
          : e.kind.startsWith("effect")
            ? String(p.capability ?? "")
            : "";
      const kind = padEnd(e.kind, 18);
      const tone = /error|failed|gave/.test(e.kind)
        ? st.bad
        : /retry|waiting/.test(e.kind)
          ? st.warn
          : (t: string) => t;
      out.line(`  ${tone(kind)} ${padEnd(brief, 40)} ${st.muted(ago(e.ts, now))}`);
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

/** What a person can do next with a run in this state: commands, most likely first. */
export function nextCommands(d: RunDetail, goOn?: string): Array<{ cmd: string; why: string }> {
  const r = d.run;
  const id = shortRunId(r.id);
  const out: Array<{ cmd: string; why: string }> = [];
  const pending = d.pendingApprovals[0];
  if (r.state === "WAITING_HUMAN") {
    // one command, no flags: it asks right there (questions, accept, send back) and goes on
    out.push({
      cmd: "jarvis continue",
      why:
        r.waitingFor?.kind === "clarification" ? "answer the questions and go on" : "read, decide and go on",
    });
    if (pending) out.push({ cmd: `jarvis show ${id} ${pending.type}`, why: `just read the ${pending.type}` });
  } else if (r.state === "WAITING_BUDGET") {
    out.push(
      r.waitingFor?.kind === "model"
        ? { cmd: "jarvis continue", why: `waits for model ${r.waitingFor.detail ?? ""} here and goes on` }
        : { cmd: `jarvis resume ${id}`, why: "when the quota window frees up" },
    );
  } else if (r.state === "FAILED") {
    out.push({ cmd: `jarvis logs ${id} --level error`, why: "what went wrong" });
    out.push({ cmd: `jarvis resume ${id}`, why: "retry from the last checkpoint" });
  } else if (r.state === "RUNNING" && !d.leaseLive) {
    out.push({ cmd: `jarvis resume ${id}`, why: "continue from the checkpoint" });
  } else if (r.state === "COMPLETED") {
    if (goOn) out.push({ cmd: `jarvis continue ${id}`, why: `go on as ${goOn}: the implementation` });
    const main = [...d.artifacts].reverse().find((a) => GATED.has(a.type)) ?? d.artifacts.at(-1);
    if (main) out.push({ cmd: `jarvis show ${id} ${main.type}`, why: `read the ${main.type}` });
    if (r.workspace.mode === "worktree") {
      out.push({ cmd: `jarvis diff ${id}`, why: "the change" });
      out.push({ cmd: `jarvis apply ${id}`, why: "bring it onto your branch" });
    }
  }
  out.push({ cmd: `jarvis status ${id}`, why: "every detail of the run" });
  return out;
}

const GATED = new Set(["spec", "plan", "review", "implementation", "research", "requirements"]);

/** Time spent in steps (a run resumed a day later is not a day long). */
function workedMs(d: RunDetail): number {
  return d.steps.reduce(
    (sum, s) => sum + (s.finishedAt ? Math.max(0, Date.parse(s.finishedAt) - Date.parse(s.startedAt)) : 0),
    0,
  );
}

/** The end of a foreground run: state, cost, what it produced and what to do next. */
export function renderSummary(ctx: CliContext, d: RunDetail, options: { goOn?: string } = {}): void {
  const { out } = ctx;
  const st = out.style;
  const r = d.run;
  const f = (label: string) => `  ${st.muted(padEnd(label, 10))} `;
  out.line();
  out.line(
    `${st.heading("run")} ${st.name(shortRunId(r.id))}  ${st.state(r.state)}  ${st.muted(`in ${duration(workedMs(d))}`)}`,
  );
  out.line(`${f("task")}${oneLine(r.task, 100)} ${st.muted(`· workflow ${r.workflow}`)}`);
  out.line(`${f("state")}${st.state(r.state)}${r.stateReason ? ` ${st.muted("—")} ${r.stateReason}` : ""}`);
  const t = d.tokens;
  if (t.calls > 0)
    out.line(
      `${f("model")}${t.calls} calls ${st.muted("·")} in ${kilo(t.promptTokens)} ${st.muted(`(${kilo(t.cachedTokens)} cached)`)} ${st.muted("·")} out ${kilo(t.outputTokens)}${t.retries > 0 ? ` ${st.muted("·")} ${st.warn(`${t.retries} retries`)}` : ""}`,
    );
  d.artifacts
    .filter((a) => a.type !== "project-capabilities")
    .forEach((a, i) => {
      const gate = d.pendingApprovals.some((p) => p.artifactId === a.artifactId)
        ? `  ${st.warn("awaiting approval")}`
        : a.approved
          ? `  ${st.ok("approved")}`
          : "";
      const partial = incompleteOf(a);
      const incomplete = partial ? `  ${st.warn(`⚠ incomplete (${partial.limit} limit)`)}` : "";
      const step = a.stepId
        ? st.muted(`  ${a.stepId}${a.iteration && a.iteration > 1 ? `#${a.iteration}` : ""}`)
        : "";
      out.line(
        `${i === 0 ? f("artifacts") : " ".repeat(13)}${a.type}/${a.name}@${a.version}${step}${gate}${incomplete}`,
      );
    });
  const next = nextCommands(d, options.goOn);
  const w = Math.max(...next.map((n) => n.cmd.length));
  next.forEach((n, i) => {
    out.line(`${i === 0 ? f("next") : " ".repeat(13)}${st.cmd(padEnd(n.cmd, w))}  ${st.muted(n.why)}`);
  });
}

import { activityOf, formatActivity, kilo, noticeOf } from "../app/activity.ts";
import { duration, Journey, type LoopReport, type StepReport } from "../app/journey.ts";
import type { Runtime } from "../app/runtime.ts";
import type { ArtifactVersion } from "../core/domain/artifact.ts";
import type { Run } from "../core/domain/run.ts";
import type { StoredEvent } from "../telemetry/events.ts";
import type { CliContext } from "./context.ts";
import type { Style } from "./style.ts";

/**
 * The course of a foreground run (`work`, `spec`, `research`, `resume`, `onboard --module`, `ask`)
 * on stderr, read from the event journal once a second:
 *
 *   ▶ spec · ABC-1 · run 1a2b3c4d
 *     discover → research → requirements → spec → approve-spec
 *   ✓ [1/5] discover       0.4s   project.discover                        → project-capabilities
 *   ✓ [2/5] research       3m 12s research · 9 calls · 182k→6.1k tok · 23/60 tools → research.md
 *   ⠹ 3:41 · requirements#1 requirements · model call 2, waiting 0:21 · …   (the live line)
 *
 * A finished step leaves a line that stays (also in a pipe and with `--json`, like retries and
 * provider failures); the live line under it is drawn only on a terminal and not with
 * JARVIS_PROGRESS=off. Pilot: the live line showed only the current step, so after a long `spec`
 * nobody could tell which step took the time or produced what.
 */
export interface Progress {
  stop(): void;
}

export interface FollowOptions {
  readonly runId?: string;
  /** The workflow's step ids in order: `[2/5]` positions and the plan under the header. */
  readonly plan?: readonly string[];
  /** false: the run goes on after a decision in the same command, its header is already shown. */
  readonly header?: boolean;
  readonly intervalMs?: number;
  readonly signals?: boolean;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A task is often a paragraph: the first line, cut, in a header. */
export function oneLine(text: string, max: number): string {
  const line = text.split("\n")[0]?.trim() ?? "";
  return [...line].length > max ? `${[...line].slice(0, max - 1).join("")}…` : line;
}

const shortId = (runId: string) => runId.replace(/^run_/, "").slice(0, 8);

export function formatRunHeader(
  run: Pick<Run, "id" | "task" | "workflow">,
  plan: readonly string[],
  st: Style,
): string[] {
  const lines = [
    `${st.heading("▶")} ${st.heading(run.workflow)} ${st.muted("·")} ${oneLine(run.task, 90)} ${st.muted(`· run ${shortId(run.id)}`)}`,
  ];
  if (plan.length > 1) lines.push(`  ${st.muted(plan.join(" → "))}`);
  return lines;
}

/** `→ spec.md, questions.json` — what the step produced, by name. */
function producedOf(artifacts: readonly ArtifactVersion[]): string {
  return artifacts.map((a) => `${a.name}${a.version > 1 ? `@${a.version}` : ""}`).join(", ");
}

export function formatStepReport(
  r: StepReport,
  artifacts: readonly ArtifactVersion[],
  st: Style,
  width = 0,
): string[] {
  const ok = r.status === "success";
  const glyph = ok ? st.ok("✓") : st.bad("✗");
  const pos = r.index ? st.muted(`[${r.index}/${r.total}] `) : "";
  const label = `${r.stepId}${r.iteration > 1 ? `#${r.iteration}` : ""}`;
  const name = st.name(label) + " ".repeat(Math.max(0, width - label.length));
  const facts: string[] = [];
  if (r.agent) facts.push(r.agent);
  else if (r.kind) facts.push(r.kind);
  if (r.modelCalls > 0) {
    facts.push(`${r.modelCalls} call${r.modelCalls === 1 ? "" : "s"}`);
    facts.push(`${kilo(r.promptTokens)}→${kilo(r.outputTokens)} tok`);
  }
  if (r.toolCalls > 0 || r.maxToolCalls)
    facts.push(r.maxToolCalls ? `${r.toolCalls}/${r.maxToolCalls} tools` : `${r.toolCalls} tools`);
  const retries = r.retries > 0 ? ` ${st.warn(`· ${r.retries} retr${r.retries === 1 ? "y" : "ies"}`)}` : "";
  const limit = r.budgetExhausted
    ? ` ${st.warn(`· ${r.budgetExhausted === "model" ? "model call" : "tool"} limit reached, result may be incomplete`)}`
    : "";
  const outcome = r.outcome && r.outcome !== "success" ? ` ${st.muted("·")} ${st.warn(r.outcome)}` : "";
  const produced = artifacts.length > 0 ? `  ${st.muted("→")} ${producedOf(artifacts)}` : "";
  const lines = [
    `${glyph} ${pos}${name}  ${duration(r.durationMs).padEnd(7)} ${st.muted(facts.join(" · "))}${retries}${limit}${outcome}${produced}`.trimEnd(),
  ];
  if (!ok && r.reason)
    lines.push(`  ${st.bad(r.status === "error" ? "error:" : "failed:")} ${r.reason.split("\n")[0]}`);
  else if (r.reason && r.outcome && r.outcome !== "success")
    lines.push(`  ${st.muted(r.reason.split("\n")[0] ?? "")}`);
  return lines;
}

export function formatLoop(l: LoopReport, st: Style): string {
  const of = l.max ? `/${l.max}` : "";
  const why = l.reasons ? ` ${st.muted(`— ${l.reasons.split("\n")[0]}`)}` : "";
  return `${st.warn("↻")} ${st.name(l.from)} ${st.muted("→")} ${st.name(l.to)} ${st.warn(`${l.outcome}, round ${l.iteration}${of}`)}${why}`;
}

/** A run that stopped for a human, a quota window or a failure: one line, what it waits for. */
export function formatParked(run: Run, st: Style, plan: readonly string[] = []): string | undefined {
  const at = run.currentStep ? plan.indexOf(run.currentStep) : -1;
  const pos = at >= 0 ? st.muted(`[${at + 1}/${plan.length}] `) : "";
  const step = run.currentStep ? `${pos}${st.name(run.currentStep)}  ` : "";
  if (run.state.startsWith("WAITING")) {
    const w = run.waitingFor;
    // the reason names what is awaited ("approve spec (spec.md@1)"); the detail only without one
    const what = w
      ? `${w.kind}${w.detail && !run.stateReason ? ` of ${w.detail}` : ""}`
      : run.state.toLowerCase();
    return `${st.warn("⏸")} ${step}${st.warn(`waiting for ${what}`)}${run.stateReason ? st.muted(` — ${run.stateReason}`) : ""}`;
  }
  if (run.state === "FAILED")
    return `${st.bad("✗")} ${step}${st.bad("run failed")}${run.stateReason ? `: ${run.stateReason}` : ""}`;
  return undefined;
}

export function followRun(ctx: CliContext, runtime: Runtime, options: FollowOptions = {}): Progress {
  const st = ctx.out.errStyle;
  let seq = runtime.events.lastSeq();
  let runId = options.runId;
  const plan = options.plan ?? [];
  const width = Math.max(0, ...plan.map((s) => s.length));
  const journey = new Journey(plan);
  const events: StoredEvent[] = [];
  let headed = options.header === false;
  let frame = 0;

  const header = () => {
    if (headed || !runId) return;
    const run = runtime.runs.get(runId);
    if (!run) return;
    headed = true;
    for (const line of formatRunHeader(run, plan, st)) ctx.out.note(line);
  };
  const producedBy = (r: StepReport) =>
    runId
      ? runtime.artifacts
          .listLatest(runId)
          .filter((a) => a.stepId === r.stepId && a.iteration === r.iteration)
      : [];

  const poll = () => {
    for (const e of runtime.events.list({ afterSeq: seq, limit: 2000 })) {
      seq = e.seq;
      // a new run announces itself; a resumed one is known up front
      if (!runId && e.kind === "run.created" && e.runId) runId = e.runId;
      if (!runId || e.runId !== runId) continue;
      header();
      events.push(e);
      for (const line of journey.push(e)) {
        if (line.kind === "step")
          for (const l of formatStepReport(line.report, producedBy(line.report), st, width)) ctx.out.note(l);
        else ctx.out.note(formatLoop(line.report, st));
      }
      if (e.kind === "run.state") {
        // judged by the event, not by the run now: polling may see a later state
        const state = (e.payload as { state?: string } | undefined)?.state ?? "";
        const run = state.startsWith("WAITING") || state === "FAILED" ? runtime.runs.get(runId) : undefined;
        const parked = run ? formatParked({ ...run, state: state as Run["state"] }, st, plan) : undefined;
        if (parked) ctx.out.note(parked);
        continue;
      }
      // retries and provider failures: lines that stay, also in a pipe
      const notice = noticeOf(e);
      if (notice) ctx.out.note(notice);
    }
  };
  header();

  // Ctrl-C: hand the run back at once (no 90 s wait for the lease to expire) and say how to go on.
  // Pilot: an interrupted run stayed RUNNING in `status` and looked hung.
  const onInterrupt = () => {
    poll();
    ctx.out.progress(undefined);
    if (runId) {
      const lease = runtime.runs.get(runId)?.lease;
      if (lease?.owner.endsWith(`:${process.pid}`))
        runtime.runs.releaseLease(runId, lease.owner, lease.epoch);
      runtime.events.emit({
        kind: "run.interrupted",
        runId,
        payload: { signal: "SIGINT", pid: process.pid },
      });
      const short = shortId(runId);
      ctx.out.note(
        `${st.warn("⏸")} interrupted; run ${short} keeps its checkpoint: \`jarvis resume ${short}\` | \`jarvis cancel ${short}\``,
      );
    } else ctx.out.note("interrupted");
    process.exit(130);
  };
  if (options.signals !== false) process.once("SIGINT", onInterrupt);
  const detach = () => process.removeListener("SIGINT", onInterrupt);

  if (!ctx.out.live) {
    // no live line, but the course of the run and the notices still matter (CI logs, pipes)
    const timer = setInterval(poll, options.intervalMs ?? 1000);
    timer.unref?.();
    return {
      stop: () => {
        clearInterval(timer);
        poll();
        detach();
      },
    };
  }
  const draw = () => {
    poll();
    const spinner = st.cmd(FRAMES[frame++ % FRAMES.length] as string);
    const activity = activityOf(events);
    if (!activity) {
      ctx.out.progress(`${spinner} ${st.muted("starting…")}`);
      return;
    }
    const modelId = activity.step?.modelId;
    const timeoutMs = modelId ? runtime.loaded.config.models[modelId]?.timeoutMs : undefined;
    const stepOutputTokens = runtime.loaded.config.budget.perStep.outputTokens;
    ctx.out.progress(
      `${spinner} ${formatActivity(activity, {
        paint: st,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(stepOutputTokens !== undefined ? { stepOutputTokens } : {}),
      })}`,
    );
  };
  draw();
  const timer = setInterval(draw, options.intervalMs ?? 1000);
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
      poll();
      detach();
      ctx.out.progress(undefined);
    },
  };
}

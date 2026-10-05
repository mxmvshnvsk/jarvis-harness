import { activityOf, formatActivity, noticeOf } from "../app/activity.ts";
import type { Runtime } from "../app/runtime.ts";
import type { StoredEvent } from "../telemetry/events.ts";
import type { CliContext } from "./context.ts";

/**
 * The live line of a foreground command (`work`, `resume`, `onboard --module`, `ask`): what the run
 * does now, read from the event journal once a second and redrawn on stderr. Drawn only on a
 * terminal; `--json`, pipes and JARVIS_PROGRESS=off get no progress line. Retries, provider failures
 * and a failed or parked run are printed to stderr as lines that stay — in a pipe and with `--json` too.
 */
export interface Progress {
  stop(): void;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function followRun(
  ctx: CliContext,
  runtime: Runtime,
  options: { runId?: string; intervalMs?: number; signals?: boolean } = {},
): Progress {
  let seq = runtime.events.lastSeq();
  let runId = options.runId;
  const events: StoredEvent[] = [];
  let frame = 0;
  const poll = () => {
    for (const e of runtime.events.list({ afterSeq: seq, limit: 2000 })) {
      seq = e.seq;
      // a new run announces itself; a resumed one is known up front
      if (!runId && e.kind === "run.created" && e.runId) runId = e.runId;
      if (runId && e.runId === runId) {
        events.push(e);
        // retries, provider failures, a failed or parked run: a line that stays, also in a pipe
        const notice = noticeOf(e);
        if (notice) ctx.out.error(notice);
      }
    }
  };

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
      const short = runId.replace(/^run_/, "").slice(0, 8);
      ctx.out.error(
        `interrupted; run ${short} keeps its checkpoint: jarvis resume ${short} | jarvis cancel ${short}`,
      );
    } else ctx.out.error("interrupted");
    process.exit(130);
  };
  if (options.signals !== false) process.once("SIGINT", onInterrupt);
  const detach = () => process.removeListener("SIGINT", onInterrupt);

  if (!ctx.out.live) {
    // no progress line, but the notices still matter (CI logs, pipes)
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
    const spinner = FRAMES[frame++ % FRAMES.length] as string;
    const activity = activityOf(events);
    if (!activity) {
      ctx.out.progress(`${spinner} starting…`);
      return;
    }
    const modelId = activity.step?.modelId;
    const timeoutMs = modelId ? runtime.loaded.config.models[modelId]?.timeoutMs : undefined;
    const stepOutputTokens = runtime.loaded.config.budget.perStep.outputTokens;
    ctx.out.progress(
      `${spinner} ${formatActivity(activity, {
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

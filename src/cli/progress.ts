import { activityOf, formatActivity } from "../app/activity.ts";
import type { Runtime } from "../app/runtime.ts";
import type { StoredEvent } from "../telemetry/events.ts";
import type { CliContext } from "./context.ts";

/**
 * The live line of a foreground command (`work`, `resume`, `onboard --module`, `ask`): what the run
 * does now, read from the event journal once a second and redrawn on stderr. Drawn only on a
 * terminal; `--json`, pipes and JARVIS_PROGRESS=off get nothing.
 */
export interface Progress {
  stop(): void;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function followRun(
  ctx: CliContext,
  runtime: Runtime,
  options: { runId?: string; intervalMs?: number } = {},
): Progress {
  if (!ctx.out.live) return { stop: () => undefined };
  let seq = runtime.events.lastSeq();
  let runId = options.runId;
  const events: StoredEvent[] = [];
  let frame = 0;
  const draw = () => {
    for (const e of runtime.events.list({ afterSeq: seq, limit: 2000 })) {
      seq = e.seq;
      // a new run announces itself; a resumed one is known up front
      if (!runId && e.kind === "run.created" && e.runId) runId = e.runId;
      if (runId && e.runId === runId) events.push(e);
    }
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
      ctx.out.progress(undefined);
    },
  };
}

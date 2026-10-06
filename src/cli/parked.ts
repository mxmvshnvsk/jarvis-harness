import { clock } from "../app/activity.ts";
import type { Runtime } from "../app/runtime.ts";
import type { Run } from "../core/domain/run.ts";
import { modelAlive } from "../models/probe.ts";
import type { CliContext } from "./context.ts";

/**
 * A run parked for a model that is down, or for a quota window, waits here instead of sending the
 * person away: a countdown to the next check, a one-attempt ping of the model, and the run goes on
 * when it answers. Ctrl-C leaves the run parked (`jarvis continue` comes back to it).
 * Pilot: an afternoon of a slow gateway meant watching `models stats` and typing `jarvis c` by hand.
 */
export interface WaitOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly alive?: (
    modelId: string,
  ) => Promise<{ ok: true; latencyMs: number } | { ok: false; reason: string }>;
  /** Stop waiting (Ctrl-C); checked between ticks. */
  readonly interrupted?: () => boolean;
  readonly tickMs?: number;
}

export interface Outage {
  readonly modelId?: string;
  readonly since?: string;
  readonly reason?: string;
  readonly checks: number;
  readonly resumeAfter?: number;
}

/** What a parked run waits for, from its last suspend checkpoint. */
export function outageOf(runtime: Runtime, run: Run): Outage {
  const parked = runtime.checkpoints
    .list(run.id)
    .filter((c) => c.kind === "suspend")
    .at(-1);
  const state = (parked?.state ?? {}) as Record<string, unknown>;
  const down = state.modelUnavailable as { since?: string; reason?: string; checks?: number } | undefined;
  const after = typeof state.resumeAfter === "string" ? Date.parse(state.resumeAfter) : undefined;
  const modelId = run.waitingFor?.kind === "model" ? run.waitingFor.detail : undefined;
  return {
    ...(modelId ? { modelId } : {}),
    ...(down?.since ? { since: down.since } : {}),
    ...(down?.reason ? { reason: down.reason } : {}),
    checks: down?.checks ?? 0,
    ...(after !== undefined && Number.isFinite(after) ? { resumeAfter: after } : {}),
  };
}

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export async function waitParked(
  ctx: CliContext,
  runtime: Runtime,
  run: Run,
  options: WaitOptions = {},
): Promise<"ready" | "left"> {
  const st = ctx.out.style;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const alive = options.alive ?? ((id: string) => modelAlive(runtime.gateway, id));
  const tick = options.tickMs ?? 1000;
  const every = runtime.loaded.config.modelWait.checkEveryMinutes * 60_000;
  const outage = outageOf(runtime, run);
  let next = outage.resumeAfter ?? now();
  let reason = outage.reason;
  let checks = outage.checks;
  let stop = false;
  const onInterrupt = () => {
    stop = true;
  };
  process.once("SIGINT", onInterrupt);
  const what = outage.modelId
    ? `model ${st.name(outage.modelId)} is unavailable${outage.since ? ` since ${hhmm(outage.since)}` : ""}`
    : "the quota window is used up";
  ctx.out.note(
    `${st.warn("⏸")} ${what}${reason ? st.muted(` (${reason})`) : ""} — waiting here; Ctrl-C leaves the run parked`,
  );
  try {
    for (;;) {
      if (stop || options.interrupted?.()) {
        ctx.out.progress(undefined);
        ctx.out.note(`${st.muted("left waiting; come back with")} ${st.cmd("jarvis continue")}`);
        return "left";
      }
      const left = next - now();
      if (left > 0) {
        const label = outage.modelId
          ? `check ${checks + 1} of model ${outage.modelId}`
          : "quota window frees";
        ctx.out.progress(
          `${st.warn("⏸")} ${label} in ${clock(left)} ${st.muted("· Ctrl-C to leave it parked")}`,
        );
        await sleep(Math.min(tick, left));
        continue;
      }
      if (!outage.modelId) {
        ctx.out.progress(undefined);
        return "ready";
      }
      ctx.out.progress(`${st.muted("…")} checking model ${outage.modelId}`);
      const check = await alive(outage.modelId);
      checks += 1;
      if (check.ok) {
        ctx.out.progress(undefined);
        ctx.out.note(
          `${st.ok("✓")} model ${st.name(outage.modelId)} answers again ${st.muted(`(${clock(check.latencyMs)})`)} — going on`,
        );
        return "ready";
      }
      reason = check.reason.replace(/^model \S+: /, "").slice(0, 120);
      next = now() + every;
      ctx.out.progress(undefined);
      ctx.out.note(`${st.muted(`check ${checks}:`)} still unavailable ${st.muted(`(${reason})`)}`);
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

import type { Run } from "../core/domain/run.ts";
import type { Runtime } from "./runtime.ts";

/**
 * What a run parked on WAITING_BUDGET waits for, in the words the pages use: a quota window (and
 * which pool, how full) or a model that is down, and when it goes on by itself. Pilot: a module
 * research waiting for the pool's window looked like a run that had failed — the journal's last
 * lines were a model error.
 */
export interface BudgetWait {
  readonly kind: "quota" | "model";
  readonly pool?: string;
  readonly model?: string;
  /** `output tokens: 14155 used of 30000 in window, need 2000` — how full the window is. */
  readonly detail?: string;
  /** When the window frees enough (or the model is checked again). */
  readonly resumeAfter?: string;
  readonly reason?: string;
}

export function budgetWaitOf(runtime: Runtime, run: Run): BudgetWait | undefined {
  if (run.state !== "WAITING_BUDGET") return undefined;
  const parked = runtime.checkpoints
    .list(run.id)
    .filter((c) => c.kind === "suspend")
    .at(-1);
  const after = parked?.state.resumeAfter;
  const reason = run.stateReason ?? undefined;
  const pool = reason ? /pool "([^"]+)"/.exec(reason)?.[1] : undefined;
  const detail = reason ? /pool "[^"]+": (.+)$/.exec(reason)?.[1] : undefined;
  const model =
    run.waitingFor?.kind === "model"
      ? run.waitingFor.detail
      : reason
        ? /^model (\S+):/.exec(reason)?.[1]
        : undefined;
  const kind: BudgetWait["kind"] = run.waitingFor?.kind === "model" && !pool ? "model" : "quota";
  return {
    kind,
    ...(pool ? { pool } : {}),
    ...(model ? { model } : {}),
    ...(detail ? { detail } : {}),
    ...(typeof after === "string" ? { resumeAfter: after } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** `14:45 (in 6 min)`, `now`. */
export function whenText(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "when the window frees";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "when the window frees";
  const d = new Date(at);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const left = Math.round((at - now) / 60_000);
  return left <= 0 ? `${hhmm} (any moment now)` : `${hhmm} (in ${left} min)`;
}

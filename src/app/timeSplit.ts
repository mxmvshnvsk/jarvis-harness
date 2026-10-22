import type { StoredEvent } from "../telemetry/events.ts";

/**
 * Where a run's time went, from its journal: the `run.state` transitions cut it into intervals —
 * working (the run in its step loop), waiting for a person (a gate, a question, a budget grant),
 * waiting on budget and the model (a quota window, a model taken off the gateway), a task across
 * services waiting for its subtasks (they work meanwhile, in their own runs), and paused or
 * stopped (Pause, Ctrl-C, a failure until Try again, no process holding the run).
 * Pilot: the page showed one time, and two hours of it were an approval waiting overnight.
 */
export type TimePart = "working" | "human" | "waiting" | "subtasks" | "stopped";

export interface TimeItem {
  readonly label: string;
  readonly ms: number;
  /** Separate stops of this kind (a model re-checked every few minutes is one outage). */
  readonly times: number;
}

export interface TimeShare {
  readonly ms: number;
  /** Biggest first. */
  readonly items: readonly TimeItem[];
}

export interface TimeSplit {
  readonly startedAt: string;
  /** Set when the run is over: the clock stopped there. */
  readonly endedAt?: string;
  readonly totalMs: number;
  readonly parts: Readonly<Record<TimePart, TimeShare>>;
}

export const TIME_PARTS: readonly TimePart[] = ["working", "human", "waiting", "subtasks", "stopped"];

const TERMINAL = new Set(["COMPLETED", "CANCELLED"]);

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

interface Stop {
  readonly part: TimePart;
  readonly label: string;
}

/** What a parked state waits for; `undefined` for RUNNING. */
function stopOf(e: StoredEvent): Stop | undefined {
  const p = e.payload ?? {};
  const state = str(p.state);
  const reason = str(p.reason) ?? "";
  const waitingFor = (p.waitingFor ?? {}) as { kind?: string; detail?: string };
  switch (state) {
    case "RUNNING":
      return undefined;
    case "CREATED":
      return { part: "stopped", label: "not started yet" };
    case "WAITING_HUMAN": {
      const kind = waitingFor.kind ?? (/^budget\.|limit|tool calls|model calls/.test(reason) ? "budget" : "");
      const label =
        kind === "approval"
          ? (e.stepId ?? "approval")
          : kind === "budget"
            ? "budget grant"
            : kind === "clarification"
              ? "clarification"
              : kind === "loop"
                ? "a loop used up"
                : kind === "effect"
                  ? "an unconfirmed action"
                  : kind === "review"
                    ? "review"
                    : kind === "conflict"
                      ? "a conflict"
                      : (e.stepId ?? "your decision");
      return { part: "human", label };
    }
    case "WAITING_BUDGET":
      return {
        part: "waiting",
        label:
          waitingFor.kind === "model" || (/unavailable/.test(reason) && !/admission/.test(reason))
            ? "model unavailable"
            : "quota window",
      };
    case "SUSPENDED":
      // a master parked for its subtasks is not stopped: they work (pilot: «Ctrl-C» while they started)
      if (waitingFor.kind === "children") return { part: "subtasks", label: "subtasks" };
      return { part: "stopped", label: reason.startsWith("paused") ? "Pause" : "Ctrl-C" };
    case "FAILED":
      return { part: "stopped", label: "failed, until Try again" };
    default:
      return { part: "stopped", label: (state ?? "stopped").toLowerCase() };
  }
}

/**
 * The split at `now`. `live`: a process holds the run now (its lease) — a RUNNING run nobody
 * holds stands still since its last event. Events in journal order.
 */
export function timeSplitOf(events: readonly StoredEvent[], now: Date, live = true): TimeSplit | undefined {
  const first = events[0];
  if (!first) return undefined;
  const acc: Record<TimePart, Map<string, { ms: number; times: number }>> = {
    working: new Map(),
    human: new Map(),
    waiting: new Map(),
    subtasks: new Map(),
    stopped: new Map(),
  };
  const add = (part: TimePart, label: string, ms: number, newStop: boolean): void => {
    const item = acc[part].get(label) ?? { ms: 0, times: 0 };
    item.ms += Math.max(0, ms);
    if (newStop) item.times += 1;
    acc[part].set(label, item);
  };
  // the open interval: since when, in what — a stop, or the run working on `step`
  let since = Date.parse(first.ts);
  let stop: Stop | undefined = { part: "stopped", label: "not started yet" };
  let step = first.stepId ?? "the run";
  let lastAt = since;
  let lastStop: Stop | undefined;
  let workedSinceStop = true;
  let ended: string | undefined;
  const close = (at: number): void => {
    if (stop) add(stop.part, stop.label, at - since, false);
    else add("working", step, at - since, false);
    since = at;
  };
  for (const e of events) {
    const at = Date.parse(e.ts);
    if (Number.isNaN(at)) continue;
    const p = e.payload ?? {};
    if (e.kind === "run.recovered" && !stop) {
      // the process holding the run died: from its last event on, nobody ran it
      close(lastAt);
      add("stopped", "no process ran it", at - lastAt, true);
      since = at;
    } else if (e.kind === "step.start") {
      close(at);
      step = str(p.stepId) ?? e.stepId ?? step;
      // a step starts only in a running run: a journal without the RUNNING transition still counts
      stop = undefined;
    } else if (e.kind === "model.call") {
      workedSinceStop = true;
    } else if (e.kind === "run.state") {
      close(at);
      const state = str(p.state);
      const next = stopOf(e);
      if (next) {
        // the same stop again with no model answer between: a re-check, not a new stop
        const same = !workedSinceStop && lastStop?.part === next.part && lastStop.label === next.label;
        add(next.part, next.label, 0, !same);
        lastStop = next;
        workedSinceStop = false;
      }
      stop = next;
      if (state && (TERMINAL.has(state) || state === "FAILED")) ended = e.ts;
      else ended = undefined;
      if (state && TERMINAL.has(state)) {
        stop = undefined;
        lastAt = at;
        break;
      }
    }
    lastAt = at;
  }
  // a run that ended FAILED is over too — the clock stops there unless it went on (Try again)
  const endAt = ended ? Date.parse(ended) : now.getTime();
  if (!ended) {
    if (!stop && !live && endAt > lastAt) {
      close(lastAt);
      add("stopped", "no process ran it", endAt - lastAt, true);
      since = endAt;
    } else close(endAt);
  }
  const startedAt = first.ts;
  const shareOf = (part: TimePart): TimeShare => {
    const items = [...acc[part].entries()]
      .map(([label, v]) => ({ label, ms: v.ms, times: v.times }))
      .filter((i) => i.ms > 0)
      .sort((a, b) => b.ms - a.ms);
    return { ms: items.reduce((s, i) => s + i.ms, 0), items };
  };
  const parts: Record<TimePart, TimeShare> = {
    working: shareOf("working"),
    human: shareOf("human"),
    waiting: shareOf("waiting"),
    subtasks: shareOf("subtasks"),
    stopped: shareOf("stopped"),
  };
  const totalMs = TIME_PARTS.reduce((s, part) => s + parts[part].ms, 0);
  return { startedAt, ...(ended ? { endedAt: ended } : {}), totalMs, parts };
}

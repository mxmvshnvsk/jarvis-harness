import type { StoredEvent } from "../telemetry/events.ts";

/**
 * What a run is doing right now, derived from its events only (ADR-0018 §2: the journal is the
 * source; the same view serves the live progress line of a foreground command and `status --watch`
 * from another terminal). Pilot: an 18-minute onboarding pass gave no sign of life, so a slow
 * gateway and a hung call looked the same.
 */
export interface Activity {
  readonly runId: string;
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly finished: boolean;
  readonly step?: {
    readonly id: string;
    readonly iteration: number;
    readonly startedAt: string;
    readonly agent?: string;
    readonly modelId?: string;
    /** Tool and model call limits of the agent, when it reported them. */
    readonly maxToolCalls?: number;
    readonly maxModelCalls?: number;
    readonly modelCalls: number;
    readonly toolCalls: number;
    /** Tokens of this step: what the per-step output cap is compared with. */
    readonly promptTokens?: number;
    readonly outputTokens?: number;
  };
  /** Totals over the run. */
  readonly modelCalls: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly retries: number;
  readonly toolCalls: number;
  readonly avgLatencyMs?: number;
  readonly lastTool?: { readonly capability: string; readonly detail?: string; readonly ok: boolean };
  /** The last few tool calls of the current step, oldest first: what the agent is doing. */
  readonly recentTools?: ReadonlyArray<{
    readonly capability: string;
    readonly detail?: string;
    readonly ok: boolean;
  }>;
  /** Inside an agent step: since when the agent waits for the model (the last thing that happened). */
  readonly waitingSince?: string;
  readonly waitingMs?: number;
  readonly lastRetry?: string;
  /** Retries of the call in flight: how many, and why the last attempt failed. */
  readonly retrying?: { readonly attempt: number; readonly reason: string };
  /** A streamed answer on its way: characters of the answer and of the reasoning so far. */
  readonly receiving?: { readonly outputChars: number; readonly reasoningChars: number };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/** The most telling argument of a tool call: a path, a pattern, a query, a ref. */
function detailOf(args: unknown): string | undefined {
  if (typeof args !== "string") return undefined;
  try {
    const a = JSON.parse(args) as Record<string, unknown>;
    return str(a.path) ?? str(a.file) ?? str(a.pattern) ?? str(a.query) ?? str(a.ref) ?? str(a.args);
  } catch {
    return undefined;
  }
}

export function activityOf(events: readonly StoredEvent[], now: Date = new Date()): Activity | undefined {
  const first = events[0];
  if (!first?.runId) return undefined;
  const runId = first.runId;
  type StepView = { -readonly [K in keyof NonNullable<Activity["step"]>]: NonNullable<Activity["step"]>[K] };
  /**
   * One per step in flight: the children of a composite step run side by side, and a skipped sibling
   * must not take the live line over (pilot: "telemetry#1 test" while the test agent worked).
   */
  interface Live {
    step: StepView;
    agentActive: boolean;
    waitingSince?: string | undefined;
    recent: Array<NonNullable<Activity["lastTool"]>>;
    retrying?: { attempt: number; reason: string } | undefined;
    receiving?: { outputChars: number; reasoningChars: number } | undefined;
  }
  const open = new Map<string, Live>();
  let last: Live | undefined;
  let finished = false;
  let modelCalls = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  let retries = 0;
  let toolCalls = 0;
  let latency = 0;
  let lastTool: Activity["lastTool"];
  let lastRetry: string | undefined;
  /** The step an event belongs to: by the payload's step, the event's, or the one started last. */
  const at = (e: StoredEvent, p: Record<string, unknown>): Live | undefined =>
    open.get(str(p.stepId) ?? "") ?? open.get(e.stepId ?? "") ?? [...open.values()].at(-1);
  for (const e of events) {
    if (e.runId !== runId) continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const live = at(e, p);
    switch (e.kind) {
      case "step.start": {
        const id = str(p.stepId) ?? e.stepId ?? "?";
        const fresh: Live = {
          step: {
            id,
            iteration: num(p.iteration) || (e.iteration ?? 1),
            startedAt: e.ts,
            modelCalls: 0,
            toolCalls: 0,
            promptTokens: 0,
            outputTokens: 0,
          },
          agentActive: false,
          recent: [],
        };
        open.delete(id);
        open.set(id, fresh);
        last = fresh;
        break;
      }
      case "step.finish":
        if (live) {
          live.agentActive = false;
          live.waitingSince = undefined;
          open.delete(live.step.id);
        }
        break;
      case "agent.start":
        if (live) {
          live.agentActive = true;
          live.waitingSince = e.ts;
          const agent = str(p.agent);
          const modelId = str(p.modelId);
          if (agent) live.step.agent = agent;
          if (modelId) live.step.modelId = modelId;
          if (num(p.maxToolCalls) > 0) live.step.maxToolCalls = num(p.maxToolCalls);
          if (num(p.maxModelCalls) > 0) live.step.maxModelCalls = num(p.maxModelCalls);
          live.step.toolCalls = num(p.restoredToolCalls);
        }
        break;
      case "agent.finish":
        if (live) {
          live.agentActive = false;
          live.waitingSince = undefined;
        }
        break;
      case "model.call":
        modelCalls += 1;
        promptTokens += num(p.promptTokens);
        outputTokens += num(p.outputTokens);
        retries += num(p.retries);
        latency += num(p.latencyMs);
        if (live) {
          live.step.modelCalls += 1;
          live.step.promptTokens = (live.step.promptTokens ?? 0) + num(p.promptTokens);
          live.step.outputTokens = (live.step.outputTokens ?? 0) + num(p.outputTokens);
          if (live.agentActive) live.waitingSince = e.ts;
          live.retrying = undefined;
          live.receiving = undefined;
        }
        break;
      case "model.progress":
        if (live) live.receiving = { outputChars: num(p.outputChars), reasoningChars: num(p.reasoningChars) };
        break;
      case "model.retry":
        // the wait keeps counting from the first attempt: the answer is still the same one
        lastRetry = str(p.message);
        if (live) {
          live.receiving = undefined;
          live.retrying = {
            attempt: num(p.attempt) || (live.retrying?.attempt ?? 0) + 1,
            reason: reasonOf(lastRetry),
          };
        }
        break;
      case "tool.call": {
        toolCalls += 1;
        const capability = str(p.capability) ?? "?";
        const detail = detailOf(p.args);
        lastTool = { capability, ok: p.ok !== false, ...(detail ? { detail } : {}) };
        if (live) {
          live.step.toolCalls += 1;
          live.recent = [...live.recent, lastTool].slice(-3);
          if (live.agentActive) live.waitingSince = e.ts;
          live.retrying = undefined;
          live.receiving = undefined;
        }
        break;
      }
      case "run.state": {
        // the run left the step loop: finished, or parked for a human or a quota window
        const state = str(p.state);
        if (state !== "RUNNING")
          for (const l of open.values()) {
            l.agentActive = false;
            l.waitingSince = undefined;
          }
        if (state === "COMPLETED" || state === "FAILED" || state === "CANCELLED") finished = true;
        break;
      }
      default:
        break;
    }
  }
  // the step to show: the newest one whose agent works, else the newest in flight, else the last
  const inFlight = [...open.values()];
  const current = inFlight.filter((l) => l.agentActive).at(-1) ?? inFlight.at(-1) ?? last;
  const startedAt = first.ts;
  const waitingSince = current?.waitingSince;
  const waitingMs =
    !finished && current?.agentActive && waitingSince
      ? Math.max(0, now.getTime() - Date.parse(waitingSince))
      : undefined;
  const recent = current?.recent ?? [];
  return {
    runId,
    startedAt,
    elapsedMs: Math.max(0, now.getTime() - Date.parse(startedAt)),
    finished,
    ...(current ? { step: current.step } : {}),
    modelCalls,
    promptTokens,
    outputTokens,
    retries,
    toolCalls,
    ...(modelCalls > 0 ? { avgLatencyMs: Math.round(latency / modelCalls) } : {}),
    ...(lastTool ? { lastTool: current?.recent.at(-1) ?? lastTool } : {}),
    ...(recent.length > 0 && !finished ? { recentTools: recent } : {}),
    ...(waitingMs !== undefined && waitingSince ? { waitingSince, waitingMs } : {}),
    ...(lastRetry ? { lastRetry } : {}),
    ...(current?.retrying && waitingMs !== undefined ? { retrying: current.retrying } : {}),
    ...(current?.receiving && waitingMs !== undefined ? { receiving: current.receiving } : {}),
  };
}

/** "receiving ~1.2k tok" while the answer streams in; "thinking ~3k tok" while only reasoning does. */
function receivingText(r: NonNullable<Activity["receiving"]>): string {
  const tokens = (chars: number) => kilo(Math.round(chars / 4));
  if (r.outputChars > 0) return `receiving ~${tokens(r.outputChars)} tok`;
  return `thinking ~${tokens(r.reasoningChars)} tok`;
}

/** "model x: provider error (500): {…}" → "provider error (500)". */
export function reasonOf(message: string | undefined): string {
  if (!message) return "an error";
  const rest = message.replace(/^model [^:]+:\s*/, "");
  return rest.split(/:\s/)[0]?.trim() || rest.slice(0, 40);
}

export function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

export function kilo(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function bar(done: number, total: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((done / total) * width)));
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

/** Shortens a path from the left: `…/senders/invoice-mailer.ts`. */
function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  const parts = text.split("/");
  let out = parts.pop() ?? text;
  while (parts.length > 0 && out.length + (parts.at(-1)?.length ?? 0) + 2 <= max)
    out = `${parts.pop()}/${out}`;
  return out.length < text.length ? `…/${out}`.slice(0, max) : out.slice(0, max);
}

/** Colours for a line, structurally the CLI's Style (the app layer does not depend on the CLI). */
export interface Paint {
  name(text: string): string;
  muted(text: string): string;
  warn(text: string): string;
  bad(text: string): string;
}

const NO_PAINT: Paint = { name: (t) => t, muted: (t) => t, warn: (t) => t, bad: (t) => t };

export interface FormatOptions {
  readonly paint?: Paint;
  /** Model timeout: a wait past it is a hang, not a slow answer. */
  readonly timeoutMs?: number;
  /** Per-step output token cap (budget.perStep.outputTokens). */
  readonly stepOutputTokens?: number;
  /** Per-step input token cap (budget.perStep.inputTokens). */
  readonly stepInputTokens?: number;
  /** Name the last tool at the end of the line (false when a line of its own shows the recent ones). */
  readonly lastTool?: boolean;
}

/** The second line of the live region: the step's last tool calls, `↳ read src/a.ts · search foo ✗`. */
export function formatRecent(a: Activity, options: FormatOptions = {}): string | undefined {
  const st = options.paint ?? NO_PAINT;
  if (!a.recentTools || a.recentTools.length === 0 || a.waitingMs === undefined) return undefined;
  const calls = a.recentTools.map((t) => {
    const name = t.capability.slice(t.capability.lastIndexOf(".") + 1);
    const detail = t.detail ? ` ${tail(t.detail, 36)}` : "";
    return `${name}${detail}${t.ok ? "" : ` ${st.bad("✗")}`}`;
  });
  return `  ${st.muted("↳")} ${st.muted(calls.join(" · "))}`;
}

/**
 * One line: elapsed · step/agent · model calls and the current wait · tool budget as a bar · tokens ·
 * the last tool. There is no "remaining time": an agent decides when it is done; the bar shows how
 * much of its tool budget is used, which bounds the step.
 */
export function formatActivity(a: Activity, options: FormatOptions = {}): string {
  const st = options.paint ?? NO_PAINT;
  const parts: string[] = [st.muted(clock(a.elapsedMs))];
  if (a.step) {
    parts.push(
      `${st.name(a.step.id)}${st.muted(`#${a.step.iteration}`)}${a.step.agent ? ` ${st.muted(a.step.agent)}` : ""}`,
    );
    const avg = a.avgLatencyMs !== undefined ? `, avg ${clock(a.avgLatencyMs)}` : "";
    let wait = "";
    if (a.waitingMs !== undefined) {
      // with retries the wait spans several attempts; the retry reason says more than the clock
      const late = a.retrying
        ? ""
        : options.timeoutMs !== undefined && a.waitingMs > options.timeoutMs
          ? " — past the model timeout, retrying or hung"
          : a.avgLatencyMs !== undefined && a.waitingMs > 3 * a.avgLatencyMs && a.waitingMs > 60_000
            ? " — slower than usual"
            : "";
      const retry = a.retrying ? `, retry ${a.retrying.attempt} after ${a.retrying.reason}` : "";
      // a streamed answer shows that it is coming: "waiting 4:10" alone read as a hung gateway (pilot)
      const coming = a.receiving && !a.retrying ? `, ${receivingText(a.receiving)}` : "";
      wait = `, waiting ${clock(a.waitingMs)}${coming}${retry || (late && !coming) ? st.warn(`${retry}${coming ? "" : late}`) : ""}`;
    }
    // while waiting, name the call in flight: "0 calls, waiting 2:02" read as if nothing was asked (pilot)
    parts.push(
      a.waitingMs !== undefined
        ? `model call ${a.step.modelCalls + 1}${avg}${wait}`
        : `model ${a.step.modelCalls} call${a.step.modelCalls === 1 ? "" : "s"}${avg}`,
    );
    parts.push(
      a.step.maxToolCalls
        ? `tools ${a.step.toolCalls}/${a.step.maxToolCalls} ${bar(a.step.toolCalls, a.step.maxToolCalls)}`
        : `tools ${a.step.toolCalls}`,
    );
  }
  // the run's totals; the per-step caps are compared with the step's own use (pilot: "out 80k/60k")
  const caps = [
    options.stepInputTokens && a.step
      ? `in ${kilo(a.step.promptTokens ?? 0)}/${kilo(options.stepInputTokens)}`
      : "",
    options.stepOutputTokens && a.step
      ? `${kilo(a.step.outputTokens ?? 0)}/${kilo(options.stepOutputTokens)}`
      : "",
  ].filter(Boolean);
  const cap = caps.length > 0 ? ` ${st.muted(`(step ${caps.join(", ")})`)}` : "";
  parts.push(`tokens in ${kilo(a.promptTokens)} out ${kilo(a.outputTokens)}${cap}`);
  if (a.retries > 0) parts.push(st.warn(`${a.retries} retr${a.retries === 1 ? "y" : "ies"}`));
  if (a.lastTool && options.lastTool !== false) {
    const detail = a.lastTool.detail ? ` ${tail(a.lastTool.detail, 40)}` : "";
    parts.push(st.muted(`last ${a.lastTool.capability}${detail}`) + (a.lastTool.ok ? "" : ` ${st.bad("✗")}`));
  }
  return parts.join(st.muted(" · "));
}

/** `HH:MM:SS` in local time — notices sit in a terminal next to the clock on the wall. */
function wallClock(iso: string): string {
  const d = new Date(iso);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function traceOf(message: string): string | undefined {
  return /trace[-_ ]?id["':=\s]+([A-Za-z0-9-]{8,})/i.exec(message)?.[1];
}

/**
 * Lines that stay in the terminal (stderr) above the progress line: what a developer must know about a
 * failing provider without opening the log — every retry with the reason, how long the attempt took,
 * the provider's trace id, and the final failure. Pilot: the corporate gateway cut requests with HTTP
 * 500 after exactly five minutes, and nothing on screen said so.
 */
export function noticeOf(event: StoredEvent): string | undefined {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const message = str(p.message) ?? "";
  const reason = reasonOf(message);
  const took = num(p.attemptMs) > 0 ? ` after ${clock(num(p.attemptMs))}` : "";
  const trace = traceOf(message);
  const traceText = trace ? `; traceId ${trace}` : "";
  const model = str(p.modelId) ?? "model";
  if (event.kind === "model.retry") {
    const of = num(p.maxRetries) > 0 ? `/${num(p.maxRetries)}` : "";
    const delay = num(p.delayMs) > 0 ? ` in ${(num(p.delayMs) / 1000).toFixed(1)}s` : "";
    return `⚠ ${wallClock(event.ts)} ${model}: ${reason}${took} — retry ${num(p.attempt)}${of}${delay}${traceText}`;
  }
  if (event.kind === "model.error") {
    const attempts = num(p.retries) + 1;
    return `✗ ${wallClock(event.ts)} ${model}: ${reason}${took} — gave up after ${attempts} attempt${attempts === 1 ? "" : "s"}${traceText}`;
  }
  if (event.kind === "run.state") {
    const state = str(p.state);
    const why = str(p.reason);
    if (state === "FAILED" || state === "WAITING_BUDGET")
      return `${state === "FAILED" ? "✗" : "⏸"} ${wallClock(event.ts)} run ${state}${why ? `: ${why}` : ""}`;
  }
  return undefined;
}

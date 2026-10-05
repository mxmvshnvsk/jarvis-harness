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
  };
  /** Totals over the run. */
  readonly modelCalls: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly retries: number;
  readonly toolCalls: number;
  readonly avgLatencyMs?: number;
  readonly lastTool?: { readonly capability: string; readonly detail?: string; readonly ok: boolean };
  /** Inside an agent step: since when the agent waits for the model (the last thing that happened). */
  readonly waitingSince?: string;
  readonly waitingMs?: number;
  readonly lastRetry?: string;
  /** Retries of the call in flight: how many, and why the last attempt failed. */
  readonly retrying?: { readonly attempt: number; readonly reason: string };
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
  let finished = false;
  let step:
    | { -readonly [K in keyof NonNullable<Activity["step"]>]: NonNullable<Activity["step"]>[K] }
    | undefined;
  let modelCalls = 0;
  let promptTokens = 0;
  let outputTokens = 0;
  let retries = 0;
  let toolCalls = 0;
  let latency = 0;
  let lastTool: Activity["lastTool"];
  let agentActive = false;
  let waitingSince: string | undefined;
  let lastRetry: string | undefined;
  let retrying: { attempt: number; reason: string } | undefined;
  for (const e of events) {
    if (e.runId !== runId) continue;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    switch (e.kind) {
      case "step.start":
        step = {
          id: str(p.stepId) ?? e.stepId ?? "?",
          iteration: num(p.iteration) || (e.iteration ?? 1),
          startedAt: e.ts,
          modelCalls: 0,
          toolCalls: 0,
        };
        agentActive = false;
        waitingSince = undefined;
        break;
      case "step.finish":
        agentActive = false;
        waitingSince = undefined;
        break;
      case "agent.start":
        agentActive = true;
        waitingSince = e.ts;
        if (step) {
          const agent = str(p.agent);
          const modelId = str(p.modelId);
          if (agent) step.agent = agent;
          if (modelId) step.modelId = modelId;
          if (num(p.maxToolCalls) > 0) step.maxToolCalls = num(p.maxToolCalls);
          if (num(p.maxModelCalls) > 0) step.maxModelCalls = num(p.maxModelCalls);
          step.toolCalls = num(p.restoredToolCalls);
        }
        break;
      case "agent.finish":
        agentActive = false;
        waitingSince = undefined;
        break;
      case "model.call":
        modelCalls += 1;
        promptTokens += num(p.promptTokens);
        outputTokens += num(p.outputTokens);
        retries += num(p.retries);
        latency += num(p.latencyMs);
        if (step) step.modelCalls += 1;
        if (agentActive) waitingSince = e.ts;
        retrying = undefined;
        break;
      case "model.retry":
        // the wait keeps counting from the first attempt: the answer is still the same one
        lastRetry = str(p.message);
        retrying = { attempt: num(p.attempt) || (retrying?.attempt ?? 0) + 1, reason: reasonOf(lastRetry) };
        break;
      case "tool.call": {
        toolCalls += 1;
        if (step) step.toolCalls += 1;
        const capability = str(p.capability) ?? "?";
        const detail = detailOf(p.args);
        lastTool = { capability, ok: p.ok !== false, ...(detail ? { detail } : {}) };
        if (agentActive) waitingSince = e.ts;
        retrying = undefined;
        break;
      }
      case "run.state": {
        // the run left the step loop: finished, or parked for a human or a quota window
        const state = str(p.state);
        if (state !== "RUNNING") {
          agentActive = false;
          waitingSince = undefined;
        }
        if (state === "COMPLETED" || state === "FAILED" || state === "CANCELLED") finished = true;
        break;
      }
      default:
        break;
    }
  }
  const startedAt = first.ts;
  const waitingMs =
    !finished && agentActive && waitingSince
      ? Math.max(0, now.getTime() - Date.parse(waitingSince))
      : undefined;
  return {
    runId,
    startedAt,
    elapsedMs: Math.max(0, now.getTime() - Date.parse(startedAt)),
    finished,
    ...(step ? { step } : {}),
    modelCalls,
    promptTokens,
    outputTokens,
    retries,
    toolCalls,
    ...(modelCalls > 0 ? { avgLatencyMs: Math.round(latency / modelCalls) } : {}),
    ...(lastTool ? { lastTool } : {}),
    ...(waitingMs !== undefined && waitingSince ? { waitingSince, waitingMs } : {}),
    ...(lastRetry ? { lastRetry } : {}),
    ...(retrying && waitingMs !== undefined ? { retrying } : {}),
  };
}

/** "model x: provider error (500): {…}" → "provider error (500)". */
function reasonOf(message: string | undefined): string {
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

function kilo(n: number): string {
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

export interface FormatOptions {
  /** Model timeout: a wait past it is a hang, not a slow answer. */
  readonly timeoutMs?: number;
  /** Per-step output token cap (budget.perStep.outputTokens). */
  readonly stepOutputTokens?: number;
}

/**
 * One line: elapsed · step/agent · model calls and the current wait · tool budget as a bar · tokens ·
 * the last tool. There is no "remaining time": an agent decides when it is done; the bar shows how
 * much of its tool budget is used, which bounds the step.
 */
export function formatActivity(a: Activity, options: FormatOptions = {}): string {
  const parts: string[] = [clock(a.elapsedMs)];
  if (a.step) {
    parts.push(`${a.step.id}#${a.step.iteration}${a.step.agent ? ` ${a.step.agent}` : ""}`);
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
      wait = `, waiting ${clock(a.waitingMs)}${retry}${late}`;
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
  const cap = options.stepOutputTokens ? `/${kilo(options.stepOutputTokens)}` : "";
  parts.push(`tokens in ${kilo(a.promptTokens)} out ${kilo(a.outputTokens)}${cap}`);
  if (a.retries > 0) parts.push(`${a.retries} retr${a.retries === 1 ? "y" : "ies"}`);
  if (a.lastTool) {
    const detail = a.lastTool.detail ? ` ${tail(a.lastTool.detail, 40)}` : "";
    parts.push(`last ${a.lastTool.capability}${detail}${a.lastTool.ok ? "" : " ✗"}`);
  }
  return parts.join(" · ");
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

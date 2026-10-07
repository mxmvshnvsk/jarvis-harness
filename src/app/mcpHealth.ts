import type { ServerReport } from "../mcp/provider.ts";
import { networkAllowed } from "../security/policy/egress.ts";
import type { StoredEvent } from "../telemetry/events.ts";
import type { HealthState } from "./modelHealth.ts";
import { type Percentiles, percentiles } from "./modelStats.ts";
import type { Runtime } from "./runtime.ts";

/**
 * How each configured MCP server is doing, for the `mcp` indicator of `jarvis ui` (ADR-0023, ADR-0017):
 * what `jarvis mcp list` says (profile, network, exposed / denied / unmapped), whether it answered the
 * last check, and what the agents' calls to it did over the last half hour. Pilot: "did the agent not
 * look into Jira, or could it not?" was a question for `jarvis mcp list --refresh` in another terminal.
 */
export interface McpProbe {
  readonly at: string;
  readonly ok: boolean;
  readonly ms?: number;
  readonly tools?: number;
  readonly error?: string;
}

export interface McpCallStats {
  readonly minutes: number;
  readonly calls: number;
  readonly failed: number;
  /** Refused by policy before the call (`allow` / `deny`, network). */
  readonly denied: number;
  readonly latencyMs?: Percentiles;
  readonly lastCallAt?: string;
  readonly lastFailure?: { readonly at: string; readonly capability: string; readonly reason: string };
  /** Most used first. */
  readonly byCapability: ReadonlyArray<{
    readonly name: string;
    readonly calls: number;
    readonly failed: number;
  }>;
}

export interface McpServerHealth extends ServerReport {
  readonly state: HealthState;
  /** Why it is not simply fine, most important first; empty when it is. */
  readonly reasons: readonly string[];
  /** The project's dataClass lets the agents reach the server's network. */
  readonly egressAllowed: boolean;
  readonly probe?: McpProbe;
  /** A check is under way now. */
  readonly checking: boolean;
  readonly recent: McpCallStats;
}

export interface McpHealth {
  readonly state: HealthState;
  readonly servers: readonly McpServerHealth[];
  readonly at: string;
}

const RANK: Record<HealthState, number> = { idle: 0, ok: 1, busy: 2, down: 3 };
const RECENT_MINUTES = 30;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export interface McpHealthInput {
  readonly reports: readonly ServerReport[];
  readonly dataClass: Parameters<typeof networkAllowed>[0];
  readonly probes: ReadonlyMap<string, McpProbe>;
  readonly checking: ReadonlySet<string>;
  /** `tool.call` and `tool.denied` events of the window, any capability. */
  readonly events: readonly StoredEvent[];
  readonly now: Date;
}

/** The server a capability belongs to: a profile name it exposes, denies or lacks, or `mcp.<server>.<tool>`. */
function ownerOf(reports: readonly ServerReport[]): (capability: string) => string | undefined {
  const owner = new Map<string, string>();
  for (const r of reports)
    for (const name of [...r.exposed, ...r.denied, ...r.unmapped]) owner.set(name, r.id);
  return (capability) => owner.get(capability) ?? /^mcp\.([^.]+)\./.exec(capability)?.[1];
}

export function mcpHealth(input: McpHealthInput): McpHealth {
  const owner = ownerOf(input.reports);
  const byServer = new Map<string, StoredEvent[]>();
  for (const e of input.events) {
    const capability = str(e.payload?.capability);
    const id = capability ? owner(capability) : undefined;
    if (!id) continue;
    byServer.set(id, [...(byServer.get(id) ?? []), e]);
  }
  const servers = input.reports.map((r): McpServerHealth => {
    const events = byServer.get(r.id) ?? [];
    const calls = events.filter((e) => e.kind === "tool.call");
    const failedCalls = calls.filter((e) => e.payload?.ok === false);
    const counts = new Map<string, { calls: number; failed: number }>();
    for (const e of calls) {
      const name = str(e.payload?.capability) as string;
      const c = counts.get(name) ?? { calls: 0, failed: 0 };
      counts.set(name, { calls: c.calls + 1, failed: c.failed + (e.payload?.ok === false ? 1 : 0) });
    }
    const lastFailed = failedCalls.at(-1);
    const latency = percentiles(calls.map((e) => num(e.payload?.durationMs)).filter((v) => v !== undefined));
    const recent: McpCallStats = {
      minutes: RECENT_MINUTES,
      calls: calls.length,
      failed: failedCalls.length,
      denied: events.filter((e) => e.kind === "tool.denied").length,
      ...(latency ? { latencyMs: latency } : {}),
      ...(calls.at(-1) ? { lastCallAt: (calls.at(-1) as StoredEvent).ts } : {}),
      ...(lastFailed
        ? {
            lastFailure: {
              at: lastFailed.ts,
              capability: str(lastFailed.payload?.capability) ?? "?",
              reason: (str(lastFailed.payload?.error) ?? "failed").split("\n")[0]?.slice(0, 160) ?? "failed",
            },
          }
        : {}),
      byCapability: [...counts.entries()]
        .map(([name, c]) => ({ name, ...c }))
        .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    };
    const egressAllowed = networkAllowed(input.dataClass, r.network);
    const probe = input.probes.get(r.id);
    const down: string[] = [];
    const busy: string[] = [];
    if (r.error) down.push(r.error);
    if (!egressAllowed) down.push(`the project's dataClass does not allow the ${r.network} network`);
    if (probe && !probe.ok) down.push(`did not answer the check: ${probe.error ?? "error"}`);
    if (!r.discovered && !probe) busy.push("never discovered — its tools are unknown");
    if (r.unmapped.length > 0) busy.push(`the server lacks tools for ${r.unmapped.join(", ")}`);
    if (r.discovered && r.exposed.length === 0 && !r.error)
      busy.push("exposes nothing to agents (allow / deny)");
    if (recent.failed > 0)
      busy.push(`${recent.failed} of ${recent.calls} calls failed in ${RECENT_MINUTES} min`);
    const state: HealthState = down.length > 0 ? "down" : busy.length > 0 ? "busy" : "ok";
    return {
      ...r,
      state,
      reasons: [...down, ...busy],
      egressAllowed,
      ...(probe ? { probe } : {}),
      checking: input.checking.has(r.id),
      recent,
    };
  });
  const state = servers.reduce<HealthState>((w, s) => (RANK[s.state] > RANK[w] ? s.state : w), "idle");
  return { state: servers.length === 0 ? "idle" : state, servers, at: input.now.toISOString() };
}

/** The health of the configured servers from the runtime: reports, the checks so far, the journal. */
export function mcpHealthOf(
  runtime: Runtime,
  probes: ReadonlyMap<string, McpProbe>,
  checking: ReadonlySet<string> = new Set(),
  now: Date = new Date(),
): McpHealth {
  const since = new Date(now.getTime() - RECENT_MINUTES * 60_000).toISOString();
  const events = ["tool.call", "tool.denied"]
    .flatMap((kind) => runtime.events.list({ kind, since, limit: 20_000 }))
    .sort((a, b) => a.seq - b.seq);
  return mcpHealth({
    reports: runtime.mcp.provider.reports(),
    dataClass: runtime.loaded.config.dataClass,
    probes,
    checking,
    events,
    now,
  });
}

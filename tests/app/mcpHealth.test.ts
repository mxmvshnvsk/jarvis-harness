import { describe, expect, it } from "vitest";
import { type McpHealthInput, mcpHealth } from "../../src/app/mcpHealth.ts";
import type { ServerReport } from "../../src/mcp/provider.ts";
import type { StoredEvent } from "../../src/telemetry/events.ts";

/** ADR-0023, ADR-0017: one state per MCP server, the worst overall; what the agents' calls did. */
const NOW = new Date("2026-10-07T10:00:00Z");
const report = (over: Partial<ServerReport> = {}): ServerReport => ({
  id: "atlassian",
  transport: "stdio",
  target: "uvx mcp-atlassian",
  network: "intranet",
  profile: "atlassian",
  readOnly: false,
  discovered: { at: "2026-10-07T09:00:00Z", count: 42 },
  exposed: ["confluence.get", "jira.get"],
  denied: ["jira.comment"],
  unmapped: [],
  notAllowed: [],
  ...over,
});
let seq = 0;
const ev = (kind: string, payload: Record<string, unknown>, minute = 50): StoredEvent => ({
  kind,
  payload,
  seq: ++seq,
  ts: `2026-10-07T09:${String(minute).padStart(2, "0")}:00.000Z`,
});
const input = (over: Partial<McpHealthInput> = {}): McpHealthInput => ({
  reports: [report()],
  dataClass: "internal",
  probes: new Map(),
  checking: new Set(),
  events: [],
  now: NOW,
  ...over,
});

describe("mcpHealth", () => {
  it("a discovered server that answered and whose calls went fine is ok", () => {
    const h = mcpHealth(
      input({
        probes: new Map([["atlassian", { at: NOW.toISOString(), ok: true, ms: 900, tools: 42 }]]),
        events: [
          ev("tool.call", { capability: "jira.get", ok: true, durationMs: 300 }, 40),
          ev("tool.call", { capability: "jira.get", ok: true, durationMs: 500 }, 41),
          ev("tool.call", { capability: "confluence.get", ok: true, durationMs: 700 }, 42),
          ev("tool.call", { capability: "repo.read", ok: true, durationMs: 1 }, 43), // not MCP
        ],
      }),
    );
    expect(h.state).toBe("ok");
    const s = h.servers[0];
    expect(s?.reasons).toEqual([]);
    expect(s?.recent).toMatchObject({
      calls: 3,
      failed: 0,
      denied: 0,
      lastCallAt: "2026-10-07T09:42:00.000Z",
    });
    expect(s?.recent.latencyMs).toEqual({ p50: 500, p90: 700, max: 700 });
    expect(s?.recent.byCapability).toEqual([
      { name: "jira.get", calls: 2, failed: 0 },
      { name: "confluence.get", calls: 1, failed: 0 },
    ]);
  });

  it("failed calls make it busy and name the last failure; policy denials are counted apart", () => {
    const h = mcpHealth(
      input({
        events: [
          ev("tool.call", { capability: "jira.get", ok: true, durationMs: 300 }),
          ev("tool.call", {
            capability: "jira.get",
            ok: false,
            durationMs: 50,
            error: "401 Unauthorized\nbody",
          }),
          ev("tool.denied", { capability: "jira.comment", reason: "not in allow" }),
        ],
      }),
    );
    expect(h.state).toBe("busy");
    expect(h.servers[0]?.reasons).toEqual(["1 of 2 calls failed in 30 min"]);
    expect(h.servers[0]?.recent).toMatchObject({
      denied: 1,
      lastFailure: { capability: "jira.get", reason: "401 Unauthorized" },
    });
  });

  it("a check without an answer, a forbidden network or an unknown profile is down", () => {
    expect(
      mcpHealth(
        input({
          probes: new Map([["atlassian", { at: NOW.toISOString(), ok: false, error: "spawn uvx ENOENT" }]]),
        }),
      ).servers[0]?.reasons,
    ).toEqual(["did not answer the check: spawn uvx ENOENT"]);
    const restricted = mcpHealth(
      input({ dataClass: "confidential", reports: [report({ network: "internet" })] }),
    );
    expect(restricted.state).toBe("down");
    expect(restricted.servers[0]?.egressAllowed).toBe(false);
    // the project's exception: out of the data class's network on purpose, said, not a fault
    const excepted = mcpHealth(
      input({
        dataClass: "confidential",
        reports: [report({ network: "internet" })],
        exceptions: [{ server: "atlassian", reason: "agreed for reads" }],
      }),
    );
    expect(excepted.state).toBe("ok");
    expect(excepted.servers[0]).toMatchObject({ egressAllowed: true, egressException: "agreed for reads" });
    expect(mcpHealth(input({ reports: [report({ error: 'unknown profile "x"' })] })).state).toBe("down");
  });

  it("unmapped capabilities, nothing exposed, never discovered: busy, with why", () => {
    expect(
      mcpHealth(input({ reports: [report({ unmapped: ["jira.transition"] })] })).servers[0]?.reasons,
    ).toEqual(["the server lacks tools for jira.transition"]);
    expect(mcpHealth(input({ reports: [report({ exposed: [] })] })).servers[0]?.reasons).toEqual([
      "exposes nothing to agents (allow / deny)",
    ]);
    const { discovered: _, ...fresh } = report();
    const h = mcpHealth(input({ reports: [fresh], checking: new Set(["atlassian"]) }));
    expect(h.servers[0]?.state).toBe("busy");
    expect(h.servers[0]?.checking).toBe(true);
  });

  it("the worst server is the dot; none configured is idle; unprofiled tools find their server", () => {
    const h = mcpHealth(
      input({
        reports: [
          report(),
          (({ profile: _, ...r }) => r)(
            report({ id: "tracker", readOnly: true, exposed: ["mcp.tracker.search"], denied: [] }),
          ),
        ],
        probes: new Map([["tracker", { at: NOW.toISOString(), ok: false, error: "no answer in 60 s" }]]),
        events: [ev("tool.call", { capability: "mcp.tracker.search", ok: true, durationMs: 10 })],
      }),
    );
    expect(h.state).toBe("down");
    expect(h.servers.map((s) => [s.id, s.state, s.recent.calls])).toEqual([
      ["atlassian", "ok", 0],
      ["tracker", "down", 1],
    ]);
    expect(mcpHealth(input({ reports: [] })).state).toBe("idle");
  });
});

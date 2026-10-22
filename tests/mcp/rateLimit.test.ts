import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { McpRateLimiter, retryAfterOf, tooManyRequests } from "../../src/mcp/client/rateLimit.ts";
import { MIGRATIONS } from "../../src/storage/migrations/index.ts";

function db(): DatabaseSync {
  const d = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) d.exec(m.sql);
  return d;
}

describe("McpRateLimiter: calls per minute to a server", () => {
  it("lets rpm calls through, then waits until the oldest leaves the minute", async () => {
    let now = 1_000_000;
    const waits: number[] = [];
    const limiter = new McpRateLimiter(db(), {
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });
    for (let i = 0; i < 3; i += 1) {
      await limiter.acquire("jira", 3);
      now += 1_000;
    }
    const heard: number[] = [];
    await limiter.acquire("jira", 3, (ms) => heard.push(ms));
    expect(waits).toEqual([57_010]);
    expect(heard).toEqual([57_010]);
    // another server has a minute of its own; 0 — no limit
    await limiter.acquire("bitbucket", 1);
    await limiter.acquire("figma", 0);
    expect(waits).toHaveLength(1);
  });

  it("counts across limiters on one database: processes of one user", async () => {
    const shared = db();
    let now = 5_000_000;
    const a = new McpRateLimiter(shared, { now: () => now, sleep: async (ms) => void (now += ms) });
    const b = new McpRateLimiter(shared, { now: () => now, sleep: async (ms) => void (now += ms) });
    await a.acquire("jira", 1);
    const before = now;
    await b.acquire("jira", 1);
    expect(now - before).toBeGreaterThanOrEqual(60_000);
  });
});

describe("a 429 in an MCP answer", () => {
  it("is told by its code or wording; its Retry-After is read", () => {
    expect(tooManyRequests({ ok: false, text: "HTTP 429 Too Many Requests" })).toBe(true);
    expect(tooManyRequests({ ok: false, text: "Rate limit exceeded" })).toBe(true);
    expect(tooManyRequests({ ok: true, text: "429 issues" })).toBe(false);
    expect(retryAfterOf("Retry-After: 12")).toBe(12);
    expect(retryAfterOf('{"retry_after": 3.2}')).toBe(4);
    expect(retryAfterOf("nothing")).toBeUndefined();
  });
});

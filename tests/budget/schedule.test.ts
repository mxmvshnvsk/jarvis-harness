import { describe, expect, it } from "vitest";
import { BudgetManager } from "../../src/budget/admission.ts";
import {
  lastUnlimitedEnd,
  nextUnlimited,
  offsetMinutes,
  type Schedule,
  unlimitedAt,
  unlimitedUntil,
} from "../../src/budget/schedule.ts";
import { MemoryUsageStore } from "../../src/budget/usage.ts";
import { QuotaPoolSchema } from "../../src/core/config/schema.ts";

// UTC+2 all year: 22:00 there is 20:00Z
const TZ = "Europe/Kaliningrad";
const NIGHTS_AND_WEEKENDS: Schedule = {
  spans: [{ from: "22:00", to: "07:00" }, { days: ["sat", "sun"] }],
  timezone: TZ,
};
const z = (iso: string) => new Date(iso);

describe("unlimited hours of a pool", () => {
  it("knows the zone's offset", () => {
    expect(offsetMinutes(z("2026-10-07T12:00:00Z"), TZ)).toBe(120);
    expect(offsetMinutes(z("2026-10-07T12:00:00Z"), "UTC")).toBe(0);
  });

  it("weeknights over midnight; weekends whole; together Friday 22:00 to Monday 07:00", () => {
    const s = NIGHTS_AND_WEEKENDS;
    // Wednesday 2026-10-07
    expect(unlimitedAt(s, z("2026-10-07T15:00:00Z"))).toBe(false); // 17:00 local
    expect(unlimitedAt(s, z("2026-10-07T20:00:00Z"))).toBe(true); // 22:00
    expect(unlimitedAt(s, z("2026-10-08T04:59:00Z"))).toBe(true); // 06:59 Thursday
    expect(unlimitedAt(s, z("2026-10-08T05:00:00Z"))).toBe(false); // 07:00
    expect(nextUnlimited(s, z("2026-10-07T15:00:00Z"))?.toISOString()).toBe("2026-10-07T20:00:00.000Z");
    expect(unlimitedUntil(s, z("2026-10-07T21:00:00Z"))?.toISOString()).toBe("2026-10-08T05:00:00.000Z");
    // Friday evening runs on through the weekend to Monday morning
    expect(unlimitedUntil(s, z("2026-10-09T21:00:00Z"))?.toISOString()).toBe("2026-10-12T05:00:00.000Z");
    expect(unlimitedAt(s, z("2026-10-10T12:00:00Z"))).toBe(true); // Saturday noon
    // the night just over: what came before 07:00 is not counted in a 20-minute window
    expect(lastUnlimitedEnd(s, z("2026-10-08T05:10:00Z"), 20 * 60_000)?.toISOString()).toBe(
      "2026-10-08T05:00:00.000Z",
    );
    expect(lastUnlimitedEnd(s, z("2026-10-08T05:30:00Z"), 20 * 60_000)).toBeUndefined();
    expect(nextUnlimited({ spans: [] }, z("2026-10-07T15:00:00Z"))).toBeUndefined();
  });

  it("days on a span with hours: Friday night belongs to Friday", () => {
    const s: Schedule = { spans: [{ days: ["fri"], from: "23:00", to: "02:00" }], timezone: TZ };
    expect(unlimitedAt(s, z("2026-10-09T21:30:00Z"))).toBe(true); // Fri 23:30
    expect(unlimitedAt(s, z("2026-10-09T23:30:00Z"))).toBe(true); // Sat 01:30
    expect(unlimitedAt(s, z("2026-10-08T21:30:00Z"))).toBe(false); // Thu 23:30
  });
});

describe("admission with unlimited hours", () => {
  const pool = QuotaPoolSchema.parse({
    window: { minutes: 20 },
    limits: { inputTokens: 100_000 },
    unlimited: [{ from: "22:00", to: "07:00" }, { days: ["sat", "sun"] }],
    timezone: TZ,
  });
  const record = (usage: MemoryUsageStore, iso: string, promptTokens: number) =>
    usage.record({ pool: "p", model: "m", promptTokens, cachedTokens: 0, outputTokens: 10, ts: z(iso) });

  it("lets everything through at night, does not count the night after, and waits for the night when it is closer", () => {
    const usage = new MemoryUsageStore();
    let now = z("2026-10-08T04:55:00Z"); // 06:55 Thursday: unlimited
    const budget = new BudgetManager(usage, { p: pool }, () => now);
    record(usage, "2026-10-08T04:50:00Z", 150_000);
    expect(
      budget.admit({ pool: "p", estimatedOutputTokens: 10, estimatedPromptTokens: 50_000 }).allowed,
    ).toBe(true);
    expect(budget.unlimited("p")).toMatchObject({ now: true });

    // 07:05: the night's 150k are not in the window
    now = z("2026-10-08T05:05:00Z");
    expect(budget.windowUsage("p")?.promptTokens).toBe(0);
    record(usage, "2026-10-08T05:04:00Z", 90_000);
    expect(
      budget.admit({ pool: "p", estimatedOutputTokens: 10, estimatedPromptTokens: 50_000 }).allowed,
    ).toBe(false);

    // 21:55: the window frees at 22:14, the night begins at 22:00 — the run goes on then
    now = z("2026-10-08T19:55:00Z");
    record(usage, "2026-10-08T19:54:00Z", 90_000);
    const d = budget.admit({ pool: "p", estimatedOutputTokens: 10, estimatedPromptTokens: 50_000 });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.resetAt.toISOString()).toBe("2026-10-08T20:00:00.000Z");
      expect(d.reason).toContain("unlimited hours begin then");
    }
    expect(budget.unlimited("p")).toMatchObject({ now: false, next: z("2026-10-08T20:00:00Z") });
  });

  it("checks the spans and the zone when the configuration is read", () => {
    expect(
      QuotaPoolSchema.safeParse({ window: { minutes: 20 }, unlimited: [{ from: "25:00" }] }).success,
    ).toBe(false);
    expect(QuotaPoolSchema.safeParse({ window: { minutes: 20 }, unlimited: [{}] }).success).toBe(false);
    expect(QuotaPoolSchema.safeParse({ window: { minutes: 20 }, timezone: "Mars/Olympus" }).success).toBe(
      false,
    );
  });
});

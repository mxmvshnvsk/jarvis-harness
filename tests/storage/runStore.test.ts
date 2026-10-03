import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidTransitionError } from "../../src/core/domain/run.ts";
import { HeldLease } from "../../src/orchestration/lease.ts";
import { openDatabase } from "../../src/storage/db.ts";
import { LeaseLostError, SqliteRunStore, StaleStateError } from "../../src/storage/runStore.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let now: Date;
const clock = () => now;

beforeEach(() => {
  sb = sandbox();
  now = new Date("2026-10-03T12:00:00Z");
});
afterEach(() => sb.cleanup());

const input = {
  task: "ABC-123",
  workflow: "sdd",
  owner: { kind: "user" as const, id: "me@corp", verified: false },
  workspace: { mode: "worktree" as const, repoRoot: "/repo", path: "/wt", baseRef: "HEAD" },
  dataClass: "confidential" as const,
};

function open() {
  return openDatabase(join(sb.home, "jarvis.db"));
}

describe("SqliteRunStore", () => {
  it("creates, reads, resolves by prefix and lists non-terminal runs by default", () => {
    const db = open();
    const store = new SqliteRunStore(db.db, clock);
    const run = store.create(input);
    expect(run.state).toBe("CREATED");
    expect(run.id).toMatch(/^run_[0-9a-f]{20}$/);
    expect(store.resolve(run.id.slice(4, 10))?.id).toBe(run.id);
    expect(store.resolve("nope")).toBeUndefined();
    const done = store.create({ ...input, task: "DONE-1" });
    store.transition(done.id, "RUNNING");
    store.transition(done.id, "COMPLETED");
    expect(store.list().map((r) => r.id)).toEqual([run.id]);
    expect(store.list({ includeTerminal: true })).toHaveLength(2);
    expect(store.list({ state: "COMPLETED" }).map((r) => r.task)).toEqual(["DONE-1"]);
    db.close();
  });

  it("enforces the state machine and expected-state guards", () => {
    const db = open();
    const store = new SqliteRunStore(db.db, clock);
    const run = store.create(input);
    expect(() => store.transition(run.id, "COMPLETED")).toThrow(InvalidTransitionError);
    store.transition(run.id, "RUNNING");
    expect(() => store.transition(run.id, "WAITING_BUDGET", { expectedState: "CREATED" })).toThrow(
      StaleStateError,
    );
    const waiting = store.transition(run.id, "WAITING_BUDGET", { reason: "quota" });
    expect(waiting.stateReason).toBe("quota");
    expect(store.resumable().map((r) => r.id)).toEqual([run.id]);
    db.close();
  });

  it("updates step bookkeeping", () => {
    const db = open();
    const store = new SqliteRunStore(db.db, clock);
    const run = store.create(input);
    const updated = store.update(run.id, {
      currentStep: "impact",
      currentIteration: 2,
      iterations: { "impact->research#needs_research": 1 },
    });
    expect(updated.currentStep).toBe("impact");
    expect(updated.iterations).toEqual({ "impact->research#needs_research": 1 });
    db.close();
  });

  describe("lease", () => {
    it("is exclusive, expires, renews only for the holder and fences stale epochs", () => {
      const db = open();
      const store = new SqliteRunStore(db.db, clock);
      const run = store.create(input);
      const a = store.acquireLease(run.id, "cli:host:1", 90_000);
      expect(a.ok).toBe(true);
      const b = store.acquireLease(run.id, "daemon:host", 90_000);
      expect(b).toMatchObject({ ok: false, heldBy: "cli:host:1", epoch: 1 });
      expect(store.resumable()).toEqual([]);

      expect(store.renewLease(run.id, "daemon:host", 1, 90_000)).toBe(false);
      expect(store.renewLease(run.id, "cli:host:1", 1, 90_000)).toBe(true);
      expect(() => store.assertLease(run.id, "cli:host:1", 1)).not.toThrow();

      now = new Date(now.getTime() + 120_000);
      expect(() => store.assertLease(run.id, "cli:host:1", 1)).toThrow(LeaseLostError);
      const c = store.acquireLease(run.id, "daemon:host", 90_000);
      expect(c.ok && c.lease.epoch).toBe(2);
      expect(store.renewLease(run.id, "cli:host:1", 1, 90_000)).toBe(false);
      expect(() => store.assertLease(run.id, "cli:host:1", 1)).toThrow(/held by daemon:host/);
      db.close();
    });

    it("steal bumps the epoch; release only by the holder", () => {
      const db = open();
      const store = new SqliteRunStore(db.db, clock);
      const run = store.create(input);
      store.acquireLease(run.id, "cli:a", 90_000);
      const stolen = store.stealLease(run.id, "cli:b", 90_000);
      expect(stolen).toMatchObject({ owner: "cli:b", epoch: 2 });
      expect(store.releaseLease(run.id, "cli:a", 1)).toBe(false);
      expect(store.releaseLease(run.id, "cli:b", 2)).toBe(true);
      expect(store.get(run.id)?.lease).toBeUndefined();
      db.close();
    });

    it("works across two connections to the same database", () => {
      const path = join(sb.home, "jarvis.db");
      const one = openDatabase(path);
      const two = openDatabase(path);
      const s1 = new SqliteRunStore(one.db, clock);
      const s2 = new SqliteRunStore(two.db, clock);
      const run = s1.create(input);
      const l1 = HeldLease.acquire(s1, run.id, "cli:one", { heartbeatMs: 0 });
      expect(l1).toBeDefined();
      expect(HeldLease.acquire(s2, run.id, "daemon:two", { heartbeatMs: 0 })).toBeUndefined();
      const stolen = HeldLease.steal(s2, run.id, "daemon:two", { heartbeatMs: 0 });
      expect(() => l1?.check()).toThrow(LeaseLostError);
      expect(l1?.heartbeat()).toBe(false);
      expect(l1?.isLost).toBe(true);
      expect(() => stolen.check()).not.toThrow();
      stolen.release();
      one.close();
      two.close();
    });
  });

  it("cancels immediately without a live lease and marks the request otherwise", () => {
    const db = open();
    const store = new SqliteRunStore(db.db, clock);
    const idle = store.create(input);
    expect(store.requestCancel(idle.id).state).toBe("CANCELLED");
    const busy = store.create(input);
    store.transition(busy.id, "RUNNING");
    store.acquireLease(busy.id, "cli:x", 90_000);
    const flagged = store.requestCancel(busy.id);
    expect(flagged.state).toBe("RUNNING");
    expect(flagged.cancelRequested).toBe(true);
    db.close();
  });
});

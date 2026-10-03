import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobStore } from "../../src/artifacts/blobs.ts";
import { runEffect, UnresolvedEffectError } from "../../src/orchestration/effects.ts";
import { HeldLease } from "../../src/orchestration/lease.ts";
import { CheckpointStore, StepHistoryStore } from "../../src/storage/checkpoints.ts";
import { openDatabase } from "../../src/storage/db.ts";
import { EffectJournal, effectKey, effectMarker } from "../../src/storage/effects.ts";
import { LeaseLostError, SqliteRunStore } from "../../src/storage/runStore.ts";
import { MemoryEventStore } from "../../src/telemetry/events.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let db: ReturnType<typeof openDatabase>;
let runs: SqliteRunStore;
let journal: EffectJournal;
let events: MemoryEventStore;
let runId: string;

beforeEach(() => {
  sb = sandbox();
  db = openDatabase(join(sb.home, "jarvis.db"));
  runs = new SqliteRunStore(db.db);
  journal = new EffectJournal(db.db, new BlobStore(db.db, join(sb.home, "blobs")));
  events = new MemoryEventStore();
  runId = runs.create({
    task: "ABC-1",
    workflow: "sdd",
    owner: { kind: "user", id: "me", verified: false },
    workspace: { mode: "worktree", repoRoot: "/r", path: "/w", baseRef: "HEAD" },
    dataClass: "confidential",
  }).id;
});
afterEach(() => {
  db.close();
  sb.cleanup();
});

const ctx = (seq = 0) => ({
  runId,
  stepId: "implementation",
  iteration: 1,
  capability: "jira.comment",
  args: { issue: "ABC-1", body: "hi" },
  seq,
});

describe("EffectJournal", () => {
  it("keys are deterministic over canonical args and distinct per seq", () => {
    const k1 = effectKey({ ...ctx(), args: { body: "hi", issue: "ABC-1" } });
    expect(k1).toBe(effectKey(ctx()));
    expect(effectKey(ctx(1))).not.toBe(k1);
    expect(effectMarker(runId, k1)).toBe(`jarvis:run=${runId} effect=${k1.slice(0, 12)}`);
  });

  it("new → done → replayed from the journal", () => {
    const first = journal.begin({ ...ctx(), leaseEpoch: 1 });
    expect(first.status).toBe("new");
    journal.complete(first.record.id, { commentId: 42 });
    const again = journal.begin({ ...ctx(), leaseEpoch: 2 });
    expect(again.status).toBe("done");
    expect(again.status === "done" && again.result).toEqual({ commentId: 42 });
    expect(journal.byRun(runId)).toHaveLength(1);
    expect(journal.args(first.record)).toEqual({ body: "hi", issue: "ABC-1" });
  });

  it("an intended record without completion becomes unknown on resume; failed ones are retried", () => {
    const first = journal.begin({ ...ctx(), leaseEpoch: 1 });
    const resumed = journal.begin({ ...ctx(), leaseEpoch: 2 });
    expect(resumed.status).toBe("unknown");
    expect(resumed.record.id).toBe(first.record.id);
    journal.fail(first.record.id, "boom");
    const retried = journal.begin({ ...ctx(), leaseEpoch: 2 });
    expect(retried.status).toBe("new");
    expect(retried.record.id).not.toBe(first.record.id);
    expect(retried.record.leaseEpoch).toBe(2);
  });
});

describe("runEffect", () => {
  function lease() {
    const held = HeldLease.acquire(runs, runId, "cli:test", { heartbeatMs: 0 });
    if (!held) throw new Error("lease");
    return held;
  }

  it("executes once, then serves the journal on repeat", async () => {
    const held = lease();
    let calls = 0;
    const exec = { ...ctx(), execute: async () => ({ id: ++calls }) };
    const a = await runEffect(journal, held, events, exec);
    const b = await runEffect(journal, held, events, exec);
    expect(a).toMatchObject({ source: "executed", result: { id: 1 } });
    expect(b).toMatchObject({ source: "journal", result: { id: 1 } });
    expect(calls).toBe(1);
    expect(events.events.map((e) => e.kind)).toEqual(["effect.done", "effect.replayed"]);
    held.release();
  });

  it("verifies unknown outcomes by marker; undecidable → human decision", async () => {
    const held = lease();
    journal.begin({ ...ctx(), leaseEpoch: held.epoch }); // simulate crash after intended
    const found = await runEffect(journal, held, events, {
      ...ctx(),
      execute: async () => {
        throw new Error("must not execute");
      },
      verify: async () => ({ commentId: 7 }),
    });
    expect(found).toMatchObject({ source: "verified", result: { commentId: 7 } });

    journal.begin({ ...ctx(1), leaseEpoch: held.epoch });
    let executed = 0;
    const notFound = await runEffect(journal, held, events, {
      ...ctx(1),
      execute: async () => ({ executed: ++executed }),
      verify: async () => "not-found",
    });
    expect(notFound).toMatchObject({ source: "executed", result: { executed: 1 } });

    journal.begin({ ...ctx(2), leaseEpoch: held.epoch });
    await expect(
      runEffect(journal, held, events, { ...ctx(2), execute: async () => "x" }),
    ).rejects.toBeInstanceOf(UnresolvedEffectError);
    held.release();
  });

  it("records failures and refuses to run under a lost lease", async () => {
    const held = lease();
    await expect(
      runEffect(journal, held, events, {
        ...ctx(),
        execute: async () => {
          throw new Error("jira down");
        },
      }),
    ).rejects.toThrow("jira down");
    expect(journal.byRun(runId)[0]?.status).toBe("failed");

    HeldLease.steal(runs, runId, "daemon:x", { heartbeatMs: 0 });
    await expect(
      runEffect(journal, held, events, { ...ctx(3), execute: async () => "x" }),
    ).rejects.toBeInstanceOf(LeaseLostError);
  });
});

describe("CheckpointStore / StepHistoryStore", () => {
  it("saves and returns the latest checkpoint; records step iterations", () => {
    const checkpoints = new CheckpointStore(db.db);
    checkpoints.save({ runId, stepId: "research", iteration: 1, kind: "step", headCommit: "abc" });
    const latest = checkpoints.save({
      runId,
      stepId: "impact",
      iteration: 1,
      kind: "intra",
      state: { toolCalls: 3 },
    });
    expect(checkpoints.latest(runId)?.id).toBe(latest.id);
    expect(checkpoints.list(runId)).toHaveLength(2);

    const history = new StepHistoryStore(db.db);
    const id = history.start(runId, "impact", 1, ["art_1@2"]);
    history.finish(id, "success", "needs_research", ["art_2@1"]);
    expect(history.list(runId)).toMatchObject([
      {
        stepId: "impact",
        status: "success",
        outcome: "needs_research",
        inputs: ["art_1@2"],
        outputs: ["art_2@1"],
      },
    ]);
  });
});

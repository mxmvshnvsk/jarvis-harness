import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactStore,
  artifactIdFor,
  BlobStore,
  contentRefOf,
  unifiedDiff,
} from "../../src/artifacts/index.ts";
import type { Actor } from "../../src/core/domain/actor.ts";
import { openDatabase } from "../../src/storage/db.ts";
import { SqliteRunStore } from "../../src/storage/runStore.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
let db: ReturnType<typeof openDatabase>;
let blobs: BlobStore;
let store: ArtifactStore;
let runId: string;
const actor: Actor = { kind: "user", id: "me@corp", verified: false };

beforeEach(() => {
  sb = sandbox();
  db = openDatabase(join(sb.home, "jarvis.db"));
  blobs = new BlobStore(db.db, join(sb.home, "blobs"));
  store = new ArtifactStore(db.db, blobs);
  const runs = new SqliteRunStore(db.db);
  runId = runs.create({
    task: "ABC-1",
    workflow: "sdd",
    owner: actor,
    workspace: { mode: "worktree", repoRoot: "/r", path: "/w", baseRef: "HEAD" },
    dataClass: "confidential",
  }).id;
});
afterEach(() => {
  db.close();
  sb.cleanup();
});

describe("BlobStore", () => {
  it("is content-addressed and idempotent", () => {
    const a = blobs.put("hello", "text/plain");
    const b = blobs.put("hello");
    expect(a.contentRef).toBe(contentRefOf("hello"));
    expect(b.contentRef).toBe(a.contentRef);
    expect(existsSync(blobs.path(a.contentRef))).toBe(true);
    expect(blobs.getText(a.contentRef)).toBe("hello");
    expect(blobs.info(a.contentRef)).toMatchObject({ size: 5, mediaType: "text/plain" });
  });
});

describe("unifiedDiff", () => {
  it("produces hunks with context and reports no diff for identical input", () => {
    expect(unifiedDiff("a\nb", "a\nb")).toBe("");
    const d = unifiedDiff(
      "one\ntwo\nthree\nfour\nfive\nsix\nseven",
      "one\ntwo\nthree\nFOUR\nfive\nsix\nseven",
      "a",
      "b",
    );
    expect(d).toContain("--- a\n+++ b\n@@ -1,7 +1,7 @@");
    expect(d).toContain("-four\n+FOUR");
  });
});

describe("ArtifactStore", () => {
  it("creates immutable versions with a stable logical id and parent links", () => {
    const v1 = store.put({
      runId,
      type: "spec",
      name: "spec.md",
      content: "# v1",
      provenance: { kind: "agent", agentId: "spec" },
      stepId: "spec",
    });
    expect(v1.artifactId).toBe(artifactIdFor(runId, "spec", "spec.md"));
    expect(v1.version).toBe(1);
    const v2 = store.put({
      runId,
      type: "spec",
      name: "spec.md",
      content: "# v2",
      provenance: { kind: "agent", agentId: "spec" },
      iteration: 2,
    });
    expect(v2.version).toBe(2);
    expect(v2.parentVersion).toBe(1);
    expect(store.text(v1)).toBe("# v1");
    expect(store.text(v2)).toBe("# v2");
    expect(store.versions(v1.artifactId).map((v) => v.version)).toEqual([1, 2]);
    expect(store.listLatest(runId).map((a) => `${a.name}@${a.version}`)).toEqual(["spec.md@2"]);
    expect(store.find(runId, "spec", "spec.md")?.version).toBe(2);
  });

  it("records a human edit as a new version with provenance and diff; unchanged content is a no-op", () => {
    const v1 = store.put({
      runId,
      type: "spec",
      name: "spec.md",
      content: "a\nb\nc\n",
      provenance: { kind: "agent", agentId: "spec" },
    });
    const same = store.recordHumanEdit(v1.artifactId, "a\nb\nc\n", actor);
    expect(same.changed).toBe(false);
    expect(same.artifact.version).toBe(1);

    const edited = store.recordHumanEdit(v1.artifactId, "a\nB\nc\n", actor, "fixed B");
    expect(edited.changed).toBe(true);
    expect(edited.artifact.version).toBe(2);
    expect(edited.artifact.provenance).toMatchObject({ kind: "human", actor, comment: "fixed B" });
    expect(edited.diff).toContain("-b\n+B");
    const prov = edited.artifact.provenance;
    expect(prov.kind === "human" && prov.diffRef && blobs.getText(prov.diffRef)).toContain("+B");
  });

  it("binds approvals to the exact content and invalidates them on a new version", () => {
    const v1 = store.put({
      runId,
      type: "spec",
      name: "spec.md",
      content: "approved text",
      provenance: { kind: "agent", agentId: "spec" },
    });
    expect(store.isApproved(v1.artifactId).approved).toBe(false);
    store.approve({
      runId,
      stepId: "approve-spec",
      artifactId: v1.artifactId,
      version: 1,
      actor,
      decision: "approve",
    });
    expect(store.isApproved(v1.artifactId)).toMatchObject({
      approved: true,
      approval: { contentRef: v1.contentRef },
    });

    store.recordHumanEdit(v1.artifactId, "approved text, then edited", actor);
    expect(store.isApproved(v1.artifactId).approved).toBe(false);
    expect(store.pendingApprovals(runId, ["spec"]).map((a) => a.version)).toEqual([2]);

    store.approve({
      runId,
      stepId: "approve-spec",
      artifactId: v1.artifactId,
      version: 2,
      actor,
      decision: "request_changes",
      comment: "more",
    });
    expect(store.isApproved(v1.artifactId).approved).toBe(false);
    expect(store.approvalsFor(v1.artifactId)).toHaveLength(2);
  });
});

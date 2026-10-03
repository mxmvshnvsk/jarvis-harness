import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupDatabase,
  currentSchemaVersion,
  LATEST_SCHEMA_VERSION,
  openDatabase,
  SchemaTooNewError,
} from "../../src/storage/index.ts";
import { type Sandbox, sandbox } from "../helpers/tmp.ts";

let sb: Sandbox;
beforeEach(() => {
  sb = sandbox();
});
afterEach(() => {
  sb.cleanup();
});

describe("openDatabase", () => {
  it("creates the database and applies all migrations without a backup", () => {
    const path = join(sb.home, ".jarvis", "jarvis.db");
    const opened = openDatabase(path, { packageVersion: "0.0.1-test" });
    try {
      expect(opened.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      expect(opened.applied.map((m) => m.version)).toEqual([1, 2, 3]);
      expect(opened.backupPath).toBeUndefined();
      const tables = opened.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "runs",
          "step_history",
          "checkpoints",
          "blobs",
          "artifacts",
          "approvals",
          "interactions",
          "interaction_messages",
          "graph_snapshots",
          "graph_nodes",
          "graph_edges",
          "effects",
          "events",
          "usage_window",
          "schema_migrations",
        ]),
      );
      const row = opened.db
        .prepare("SELECT package_version FROM schema_migrations WHERE version = 1")
        .get() as {
        package_version: string;
      };
      expect(row.package_version).toBe("0.0.1-test");
    } finally {
      opened.close();
    }
  });

  it("is idempotent on reopen", () => {
    const path = join(sb.home, "jarvis.db");
    openDatabase(path).close();
    const again = openDatabase(path);
    expect(again.applied).toEqual([]);
    again.close();
  });

  it("does not back up a fresh (version 0) file even if it existed", () => {
    const path = join(sb.home, "jarvis.db");
    const seeded = new DatabaseSync(path);
    seeded.exec("CREATE TABLE legacy (x INTEGER)");
    seeded.close();
    openDatabase(path).close();
    expect(readdirSync(sb.home).filter((f) => f.includes(".bak-"))).toEqual([]);
  });

  it("backs up before migrating and keeps exactly one previous backup", () => {
    const path = join(sb.home, "jarvis.db");
    const opened = openDatabase(path);
    const first = backupDatabase(opened.db, path, 1);
    expect(existsSync(first)).toBe(true);
    const second = backupDatabase(opened.db, path, 2);
    opened.close();
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    expect(readdirSync(sb.home).filter((f) => f.includes(".bak-"))).toEqual(["jarvis.db.bak-2"]);
    const copy = new DatabaseSync(second, { readOnly: true });
    expect(currentSchemaVersion(copy)).toBe(LATEST_SCHEMA_VERSION);
    copy.close();
  });

  it("refuses a database from a newer jarvis", () => {
    const path = join(sb.home, "jarvis.db");
    openDatabase(path).close();
    const raw = new DatabaseSync(path);
    raw
      .prepare(
        "INSERT INTO schema_migrations (version, name, applied_at, package_version) VALUES (?, ?, ?, ?)",
      )
      .run(LATEST_SCHEMA_VERSION + 5, "future", new Date().toISOString(), "9.9.9");
    raw.close();
    expect(() => openDatabase(path)).toThrow(SchemaTooNewError);
    expect(existsSync(path)).toBe(true);
  });

  it("can open without migrating to report pending migrations", () => {
    const path = join(sb.home, "jarvis.db");
    const opened = openDatabase(path, { migrate: false });
    expect(opened.schemaVersion).toBe(0);
    expect(opened.applied).toEqual([]);
    opened.close();
  });
});

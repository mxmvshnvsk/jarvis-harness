import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { packageInfo } from "../version.ts";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from "./migrations/index.ts";

export class SchemaTooNewError extends Error {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(
      `database schema version ${found} is newer than this jarvis supports (${supported}); upgrade jarvis`,
    );
    this.name = "SchemaTooNewError";
    this.found = found;
    this.supported = supported;
  }
}

export interface OpenOptions {
  /** Apply pending migrations (default true). `doctor` opens read-only to report instead. */
  readonly migrate?: boolean;
  readonly packageVersion?: string;
}

export interface OpenedDatabase {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly schemaVersion: number;
  readonly applied: readonly Migration[];
  readonly backupPath?: string;
  close(): void;
}

interface MigrationRow {
  version: number;
}

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version         INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    applied_at      TEXT NOT NULL,
    package_version TEXT NOT NULL
  )`);
}

export function currentSchemaVersion(db: DatabaseSync): number {
  ensureMigrationsTable(db);
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as
    | MigrationRow
    | undefined;
  return row?.version ?? 0;
}

const BACKUP_PREFIX = ".bak-";

/** Keeps exactly one previous backup (ADR-0014 §4). */
export function backupDatabase(db: DatabaseSync, path: string, fromVersion: number): string {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const dir = dirname(path);
  const name = basename(path);
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(`${name}${BACKUP_PREFIX}`)) rmSync(join(dir, entry), { force: true });
  }
  const backupPath = `${path}${BACKUP_PREFIX}${fromVersion}`;
  copyFileSync(path, backupPath);
  return backupPath;
}

export function openDatabase(path: string, options: OpenOptions = {}): OpenedDatabase {
  const inMemory = path === ":memory:";
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const existed = inMemory ? false : existsSync(path);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  if (!inMemory) db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  const found = currentSchemaVersion(db);
  if (found > LATEST_SCHEMA_VERSION) {
    db.close();
    throw new SchemaTooNewError(found, LATEST_SCHEMA_VERSION);
  }

  const pending = MIGRATIONS.filter((m) => m.version > found);
  let backupPath: string | undefined;
  if (pending.length > 0 && options.migrate !== false) {
    if (existed && found > 0) backupPath = backupDatabase(db, path, found);
    const packageVersion = options.packageVersion ?? packageInfo().version;
    const insert = db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at, package_version) VALUES (?, ?, ?, ?)",
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const migration of pending) {
        db.exec(migration.sql);
        insert.run(migration.version, migration.name, new Date().toISOString(), packageVersion);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }

  const schemaVersion = options.migrate === false ? found : currentSchemaVersion(db);
  const opened: OpenedDatabase = {
    db,
    path,
    schemaVersion,
    applied: options.migrate === false ? [] : pending,
    close: () => db.close(),
    ...(backupPath ? { backupPath } : {}),
  };
  return opened;
}

export function pendingMigrations(db: DatabaseSync): readonly Migration[] {
  const found = currentSchemaVersion(db);
  return MIGRATIONS.filter((m) => m.version > found);
}

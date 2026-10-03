import { existsSync } from "node:fs";
import { jarvisHome } from "../../core/paths.ts";
import {
  backupDatabase,
  LATEST_SCHEMA_VERSION,
  openDatabase,
  pendingMigrations,
} from "../../storage/index.ts";
import type { CliContext } from "../context.ts";

export interface DbStatus {
  readonly path: string;
  readonly exists: boolean;
  readonly schemaVersion: number;
  readonly latest: number;
  readonly pending: readonly { version: number; name: string }[];
}

export function dbStatus(ctx: CliContext): DbStatus {
  const home = jarvisHome(ctx.env, ctx.homeDir);
  if (!existsSync(home.dbFile)) {
    return {
      path: home.dbFile,
      exists: false,
      schemaVersion: 0,
      latest: LATEST_SCHEMA_VERSION,
      pending: pendingMigrationsForFresh(),
    };
  }
  const opened = openDatabase(home.dbFile, { migrate: false });
  const pending = pendingMigrations(opened.db).map((m) => ({ version: m.version, name: m.name }));
  opened.close();
  return {
    path: home.dbFile,
    exists: true,
    schemaVersion: opened.schemaVersion,
    latest: LATEST_SCHEMA_VERSION,
    pending,
  };
}

function pendingMigrationsForFresh(): { version: number; name: string }[] {
  const opened = openDatabase(":memory:", { migrate: false });
  const pending = pendingMigrations(opened.db).map((m) => ({ version: m.version, name: m.name }));
  opened.close();
  return pending;
}

export function runDbStatus(ctx: CliContext): void {
  const status = dbStatus(ctx);
  ctx.out.result(status, () => {
    ctx.out.line(`database: ${status.path}${status.exists ? "" : " (missing)"}`);
    ctx.out.line(`schema:   v${status.schemaVersion} (latest v${status.latest})`);
    if (status.pending.length > 0) {
      ctx.out.line(`pending:  ${status.pending.map((m) => `${m.version}-${m.name}`).join(", ")}`);
    }
  });
}

export function runDbMigrate(ctx: CliContext): void {
  const home = jarvisHome(ctx.env, ctx.homeDir);
  const opened = openDatabase(home.dbFile);
  const result = {
    path: home.dbFile,
    schemaVersion: opened.schemaVersion,
    applied: opened.applied.map((m) => `${m.version}-${m.name}`),
    backup: opened.backupPath,
  };
  opened.close();
  ctx.out.result(result, () => {
    if (result.applied.length === 0) ctx.out.line(`database is up to date (schema v${result.schemaVersion})`);
    else ctx.out.line(`applied ${result.applied.join(", ")} → schema v${result.schemaVersion}`);
    if (result.backup) ctx.out.line(`backup: ${result.backup}`);
  });
}

export function runDbBackup(ctx: CliContext): void {
  const home = jarvisHome(ctx.env, ctx.homeDir);
  const opened = openDatabase(home.dbFile, { migrate: false });
  const path = backupDatabase(opened.db, home.dbFile, opened.schemaVersion);
  opened.close();
  ctx.out.result({ backup: path }, () => ctx.out.line(`backup: ${path}`));
}

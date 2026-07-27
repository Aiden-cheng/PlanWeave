import type { SqliteDatabase } from "./sqlite.js";
import { migrations } from "./migrations/registry.js";

export const latestCentralSchemaVersion = Math.max(
  ...migrations.map((migration) => migration.version)
);

function assertSchemaCompatible(database: SqliteDatabase): void {
  const found = centralSchemaVersion(database);
  if (found > latestCentralSchemaVersion) {
    throw new Error(`server_schema_version_unsupported:${found}:${latestCentralSchemaVersion}`);
  }
}

export function applyMigrations(database: SqliteDatabase): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  assertSchemaCompatible(database);
  for (const migration of migrations) {
    const disableForeignKeys = migration.disableForeignKeys === true;
    if (disableForeignKeys) database.exec("PRAGMA foreign_keys = OFF");
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        assertSchemaCompatible(database);
        const alreadyApplied = database
          .prepare("SELECT 1 FROM schema_migrations WHERE version=?")
          .get(migration.version);
        if (!alreadyApplied) {
          migration.before?.(database);
          database.exec(migration.sql);
          migration.after?.(database);
          if (disableForeignKeys) {
            const violations = database.prepare("PRAGMA foreign_key_check").all();
            if (violations.length > 0) throw new Error("migration_foreign_key_violation");
          }
          database
            .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
            .run(migration.version, new Date().toISOString());
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      if (disableForeignKeys) database.exec("PRAGMA foreign_keys = ON");
    }
  }
  const found = Number(
    database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version ?? 0
  );
  if (found !== latestCentralSchemaVersion) {
    throw new Error(`server_schema_version_incomplete:${found}:${latestCentralSchemaVersion}`);
  }
}

export function centralSchemaVersion(database: SqliteDatabase): number {
  const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    | { version: number | null }
    | undefined;
  return Number(row?.version ?? 0);
}

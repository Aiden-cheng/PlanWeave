import type { SqliteDatabase } from "./sqlite.js";

const migration1 = `
CREATE TABLE server_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
const migrations = [{ version: 1, sql: migration1 }] as const;

export function applyMigrations(database: SqliteDatabase): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  const applied = new Set(
    database
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => Number(row.version))
  );
  for (const migration of migrations)
    if (!applied.has(migration.version)) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(migration.sql);
        database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  const latest = Math.max(...migrations.map((migration) => migration.version));
  const found = Number(
    database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version ?? 0
  );
  if (found < latest)
    throw new Error(`Unsupported schema version ${found}; expected at least ${latest}.`);
}

export function centralSchemaVersion(database: SqliteDatabase): number {
  const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    | { version: number | null }
    | undefined;
  return Number(row?.version ?? 0);
}

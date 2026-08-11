import type { SqliteDatabase } from "../sqlite.js";
import { columnExists, tableExists } from "./schemaIntrospection.js";
import type { Migration } from "./types.js";

function addColumn(
  database: SqliteDatabase,
  table: string,
  column: string,
  definition: string
): void {
  if (!tableExists(database, table) || columnExists(database, table, column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function ensureHostCredentialLifecycle(database: SqliteDatabase): void {
  addColumn(
    database,
    "agent_hosts",
    "credential_lifetime_days",
    "INTEGER CHECK(credential_lifetime_days IN (30,90,180,365))"
  );
  addColumn(database, "agent_hosts", "credential_renewal_requested_at", "TEXT");
  addColumn(database, "agent_hosts", "previous_credential_hash", "TEXT");
  addColumn(database, "agent_hosts", "previous_credential_grace_expires_at", "TEXT");
  addColumn(
    database,
    "agent_host_enrollment_grants",
    "credential_lifetime_days",
    "INTEGER CHECK(credential_lifetime_days IN (30,90,180,365))"
  );

  if (!tableExists(database, "agent_hosts")) return;
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_host_credential_rotations (
      host_id TEXT PRIMARY KEY REFERENCES agent_hosts(id) ON DELETE CASCADE,
      rotation_id TEXT NOT NULL UNIQUE,
      credential_hash TEXT NOT NULL,
      credential_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_hosts_credential_renewal_requested
      ON agent_hosts(credential_renewal_requested_at)
      WHERE credential_renewal_requested_at IS NOT NULL;
  `);
}

/** Adds renewable Host credential policy and crash-safe pending rotation state. */
export const hostCredentialLifecycleMigration: Migration = {
  version: 47,
  sql: "SELECT 1;",
  before: ensureHostCredentialLifecycle
};

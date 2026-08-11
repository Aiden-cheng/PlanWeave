import type { SqliteDatabase } from "../sqlite.js";
import { columnExists, tableExists } from "./schemaIntrospection.js";
import type { Migration } from "./types.js";

function ensureHostInstallationIdentity(database: SqliteDatabase): void {
  if (!tableExists(database, "agent_hosts")) return;
  if (!columnExists(database, "agent_hosts", "installation_id")) {
    database.exec("ALTER TABLE agent_hosts ADD COLUMN installation_id TEXT");
  }
  if (!columnExists(database, "agent_hosts", "superseded_at")) {
    database.exec("ALTER TABLE agent_hosts ADD COLUMN superseded_at TEXT");
  }
  if (!columnExists(database, "agent_hosts", "superseded_by_host_id")) {
    database.exec("ALTER TABLE agent_hosts ADD COLUMN superseded_by_host_id TEXT");
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_hosts_current_installation
      ON agent_hosts(installation_id)
      WHERE installation_id IS NOT NULL AND superseded_at IS NULL;
  `);
}

/** Separates stable Host installations from replaceable execution/credential generations. */
export const hostInstallationIdentityMigration: Migration = {
  version: 48,
  sql: "SELECT 1;",
  before: ensureHostInstallationIdentity
};

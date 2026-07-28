import type { SqliteDatabase } from "../sqlite.js";
import type { Migration } from "./types.js";

function ensureHostReadinessColumn(database: SqliteDatabase): void {
  const columns = database.prepare("PRAGMA table_info(agent_hosts)").all() as Array<{
    name: string;
  }>;
  if (columns.length === 0 || columns.some((column) => column.name === "readiness_json")) return;
  database.exec("ALTER TABLE agent_hosts ADD COLUMN readiness_json TEXT");
}

/** Retains only redacted Host-local readiness observations for operator views. */
export const hostReadinessMigration: Migration = {
  version: 36,
  sql: "SELECT 1;",
  before: ensureHostReadinessColumn
};

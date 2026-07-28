import type { Migration } from "./types.js";

/** Retains only redacted Host-local readiness observations for operator views. */
export const hostReadinessMigration: Migration = {
  version: 36,
  sql: "ALTER TABLE agent_hosts ADD COLUMN readiness_json TEXT;"
};

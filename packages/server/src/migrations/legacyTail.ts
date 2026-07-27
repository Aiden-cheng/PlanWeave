import { artifactMediaTypeSchema } from "../artifactMediaType.js";
import { capabilitiesSchema } from "../protocol.js";
import type { SqliteDatabase } from "../sqlite.js";

export const migration26 = `
CREATE TABLE human_observer_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  previous_cursor INTEGER NOT NULL CHECK(previous_cursor >= 0),
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_human_observer_project_cursor
  ON human_observer_events(project_id,cursor);
`;

export function ensureServerInstanceAndRemoteActionClaims(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS server_instance_ownership (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      owner_token TEXT NOT NULL,
      process_id INTEGER NOT NULL CHECK(process_id > 0),
      hostname TEXT NOT NULL,
      acquired_at TEXT NOT NULL
    );
  `);
  if (!tableExists(database, "remote_execution_actions")) return;
  const columns = database.prepare("PRAGMA table_info(remote_execution_actions)").all();
  if (!columns.some((column) => column.name === "application_owner_token")) {
    database.exec("ALTER TABLE remote_execution_actions ADD COLUMN application_owner_token TEXT");
  }
  if (!columns.some((column) => column.name === "application_claimed_at")) {
    database.exec("ALTER TABLE remote_execution_actions ADD COLUMN application_claimed_at TEXT");
  }
  if (!columns.some((column) => column.name === "application_decision_json")) {
    database.exec("ALTER TABLE remote_execution_actions ADD COLUMN application_decision_json TEXT");
  }
}

export function ensureHostSelectionColumn(database: SqliteDatabase): void {
  if (!tableExists(database, "remote_operations")) return;
  const hasColumn = database
    .prepare(
      "SELECT 1 AS present FROM pragma_table_info('remote_operations') WHERE name='host_selection_json'"
    )
    .get();
  if (hasColumn) return;
  // Nullable column: existing non-terminal rows keep NULL without blocking migration.
  database.exec("ALTER TABLE remote_operations ADD COLUMN host_selection_json TEXT");
}

export function validateRemoteAttemptIdentities(database: SqliteDatabase): void {
  const duplicateDispatch = database
    .prepare(
      `SELECT dispatch_id FROM remote_execution_attempts
       GROUP BY dispatch_id HAVING COUNT(*)>1 LIMIT 1`
    )
    .get();
  if (duplicateDispatch) throw new Error("migration_duplicate_remote_attempt_dispatch_identity");
  const duplicateLease = database
    .prepare(
      `SELECT lease_id FROM remote_execution_attempts WHERE lease_id IS NOT NULL
       GROUP BY lease_id HAVING COUNT(*)>1 LIMIT 1`
    )
    .get();
  if (duplicateLease) throw new Error("migration_duplicate_remote_attempt_lease_identity");
}

export function backfillMailboxPredecessors(database: SqliteDatabase): void {
  for (const row of database
    .prepare("SELECT sequence,host_id FROM mailbox_messages ORDER BY sequence ASC")
    .all()) {
    const prior = database
      .prepare(
        "SELECT MAX(sequence) AS sequence FROM mailbox_messages WHERE host_id=? AND sequence<?"
      )
      .get(row.host_id, row.sequence);
    database
      .prepare("UPDATE mailbox_messages SET previous_sequence=? WHERE sequence=?")
      .run(Number(prior?.sequence ?? 0), row.sequence);
  }
}

export const migration8 = "SELECT 1;";

export function tableExists(database: SqliteDatabase, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  );
}

export function validateArtifactMediaTypes(database: SqliteDatabase): void {
  const table = tableExists(database, "artifact_blobs") ? "artifact_blobs" : "artifacts";
  for (const row of database.prepare(`SELECT ref,media_type FROM ${table}`).all()) {
    const parsed = artifactMediaTypeSchema.safeParse(row.media_type);
    if (!parsed.success) {
      throw new Error("migration_invalid_artifact_media_type");
    }
    if (parsed.data !== row.media_type) {
      database.prepare(`UPDATE ${table} SET media_type=? WHERE ref=?`).run(parsed.data, row.ref);
    }
  }
  if (!tableExists(database, "artifact_grants")) return;
  for (const row of database
    .prepare(
      "SELECT grant_id,expected_media_type FROM artifact_grants WHERE expected_media_type IS NOT NULL"
    )
    .all()) {
    const parsed = artifactMediaTypeSchema.safeParse(row.expected_media_type);
    if (!parsed.success) {
      throw new Error("migration_invalid_artifact_media_type");
    }
    if (parsed.data !== row.expected_media_type) {
      database
        .prepare("UPDATE artifact_grants SET expected_media_type=? WHERE grant_id=?")
        .run(parsed.data, row.grant_id);
    }
  }
}

export function validateArtifactLinkGrantTuples(database: SqliteDatabase): void {
  const mismatch = database
    .prepare(
      `SELECT 1 FROM dispatch_artifact_links l
       LEFT JOIN artifact_grants g ON g.grant_id=l.grant_id
       LEFT JOIN dispatches d ON d.id=l.dispatch_id
       WHERE g.grant_id IS NULL OR d.id IS NULL
         OR g.project_id<>d.project_id OR g.host_id<>d.host_id
         OR l.dispatch_id<>g.dispatch_id OR l.lease_id<>g.lease_id
         OR l.execution_attempt_id<>g.execution_attempt_id OR l.artifact_ref<>g.artifact_ref
         OR (l.purpose='input' AND g.permission<>'input_read')
         OR (l.purpose='report' AND g.permission<>'report_write')
         OR (l.purpose='output' AND g.permission<>'output_write')
         OR (l.purpose IN ('report','output') AND l.produced_by_host_id<>g.host_id)
       LIMIT 1`
    )
    .get();
  if (mismatch) throw new Error("migration_artifact_link_grant_mismatch");
}

export function validateAgentHostsForReservations(database: SqliteDatabase): void {
  for (const row of database
    .prepare("SELECT id,capabilities_json,capacity FROM agent_hosts")
    .all()) {
    try {
      if (typeof row.id !== "string" || row.id.length === 0) {
        throw new Error("invalid_host_id");
      }
      const capabilities = JSON.parse(String(row.capabilities_json));
      capabilitiesSchema.parse(capabilities);
      const capacity = Number(row.capacity);
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 128) {
        throw new Error("invalid_host_capacity");
      }
    } catch (error) {
      throw new Error("migration_invalid_agent_host_row", { cause: error });
    }
  }
}

/**
 * Drop residual dispatches.package_ref when present. Portable package identity is
 * ExecutionEnvelope + remote operation rows. Incomplete upgrade fixtures may omit the column.
 * Historical migrations 1–20 still create package_ref for real upgrade paths.
 */
export function dropDispatchPackageRefColumn(database: SqliteDatabase): void {
  const hasTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dispatches'")
    .get();
  if (!hasTable) throw new Error("migration_dispatches_table_missing");
  const columns = database.prepare("PRAGMA table_info(dispatches)").all();
  if (!columns.some((row) => row.name === "package_ref")) {
    throw new Error("migration_dispatches_package_ref_missing");
  }
  database.exec("ALTER TABLE dispatches DROP COLUMN package_ref");
}

export function ensureMembershipRevision(database: SqliteDatabase): void {
  const hasTable = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_memberships'")
    .get();
  if (!hasTable) return;
  const columns = database.prepare("PRAGMA table_info(project_memberships)").all();
  if (columns.some((row) => row.name === "revision")) return;
  database.exec(
    "ALTER TABLE project_memberships ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1)"
  );
}

export function ensureActivityRetentionIndexes(database: SqliteDatabase): void {
  if (tableExists(database, "activity_records")) {
    database.exec(
      "CREATE INDEX IF NOT EXISTS idx_activity_records_retention ON activity_records(occurred_at, activity_id)"
    );
  }
  if (!tableExists(database, "activity_projection_outbox")) return;
  const columns = database.prepare("PRAGMA table_info(activity_projection_outbox)").all();
  if (!columns.some((row) => row.name === "activity_occurred_at")) {
    database.exec("ALTER TABLE activity_projection_outbox ADD COLUMN activity_occurred_at TEXT");
  }
  if (columns.some((row) => row.name === "activity_json")) {
    database.exec(`
      UPDATE activity_projection_outbox
      SET activity_occurred_at=json_extract(activity_json, '$.occurredAt')
      WHERE activity_occurred_at IS NULL
    `);
  }
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_activity_outbox_retention ON activity_projection_outbox(activity_occurred_at, outbox_id)"
  );
}

import type { Migration } from "./types.js";

/**
 * OSS-004 B-002: durable server-authoritative Canvas command journal, CAS head,
 * operation-id idempotency outcomes, and bounded snapshot metadata.
 *
 * Presence remains ephemeral and is never stored here.
 */
export const canvasCommandMigrationSql = `
CREATE TABLE IF NOT EXISTS canvas_command_heads (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=64),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, project_id, canvas_id)
);

CREATE TABLE IF NOT EXISTS canvas_command_operations (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  intent_digest TEXT NOT NULL CHECK(length(intent_digest)=64),
  intent_json TEXT NOT NULL,
  outcome_json TEXT NOT NULL,
  accepted INTEGER NOT NULL CHECK(accepted IN (0,1)),
  revision INTEGER,
  journal_entry_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, project_id, canvas_id, operation_id)
);
CREATE INDEX IF NOT EXISTS idx_canvas_command_operations_revision
  ON canvas_command_operations(workspace_id, project_id, canvas_id, revision);

CREATE TABLE IF NOT EXISTS canvas_command_journal (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  previous_revision INTEGER NOT NULL CHECK(previous_revision >= 0),
  operation_id TEXT NOT NULL,
  intent_json TEXT NOT NULL,
  intent_digest TEXT NOT NULL CHECK(length(intent_digest)=64),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=64),
  actor_kind TEXT NOT NULL CHECK(actor_kind IN ('human','local_admin','system')),
  actor_id TEXT NOT NULL,
  actor_display_name TEXT,
  accepted_at TEXT NOT NULL,
  entry_json TEXT NOT NULL,
  PRIMARY KEY(workspace_id, project_id, canvas_id, revision),
  UNIQUE(workspace_id, project_id, canvas_id, entry_id),
  UNIQUE(workspace_id, project_id, canvas_id, operation_id),
  CHECK(revision = previous_revision + 1)
);
CREATE INDEX IF NOT EXISTS idx_canvas_command_journal_operation
  ON canvas_command_journal(workspace_id, project_id, canvas_id, operation_id);

CREATE TABLE IF NOT EXISTS canvas_command_snapshots (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=64),
  created_at TEXT NOT NULL,
  package_snapshot_id TEXT,
  digest_manifest_json TEXT,
  size_bytes INTEGER,
  encoding TEXT NOT NULL CHECK(encoding IN ('package_snapshot_ref','digest_manifest_only','content_version_ref')),
  integrity TEXT NOT NULL CHECK(integrity IN ('verified','corrupt','pending')),
  PRIMARY KEY(workspace_id, project_id, canvas_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_canvas_command_snapshots_head
  ON canvas_command_snapshots(workspace_id, project_id, canvas_id, revision DESC);

CREATE TABLE IF NOT EXISTS canvas_command_pending (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  intent_json TEXT NOT NULL,
  intent_digest TEXT NOT NULL CHECK(length(intent_digest)=64),
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_display_name TEXT,
  reserved_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('applying','needs_recovery')),
  PRIMARY KEY(workspace_id, project_id, canvas_id, operation_id)
);
`;

export const canvasCommandMigration: Migration = {
  version: 30,
  sql: canvasCommandMigrationSql
};

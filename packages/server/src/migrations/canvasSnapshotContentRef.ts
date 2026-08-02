import type { Migration } from "./types.js";

/**
 * Snapshot bodies moved to the immutable content-version authority. Rebuild the
 * SQLite table because its former CHECK constraint excluded the reference-only
 * encoding. A historical digest is only a valid reference when the scoped
 * immutable content object exists; unrecoverable rows are intentionally dropped.
 */
export const canvasSnapshotContentRefMigration: Migration = {
  version: 42,
  sql: `
ALTER TABLE canvas_command_snapshots RENAME TO canvas_command_snapshots_legacy;

CREATE TABLE canvas_command_snapshots (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=64),
  created_at TEXT NOT NULL,
  package_snapshot_id TEXT,
  digest_manifest_json TEXT,
  size_bytes INTEGER,
  encoding TEXT NOT NULL CHECK(encoding = 'content_version_ref'),
  integrity TEXT NOT NULL CHECK(integrity IN ('verified','corrupt','pending')),
  PRIMARY KEY(workspace_id, project_id, canvas_id, revision)
);

INSERT INTO canvas_command_snapshots(
  workspace_id,project_id,canvas_id,revision,content_digest,created_at,
  package_snapshot_id,digest_manifest_json,size_bytes,encoding,integrity
)
SELECT
  legacy.workspace_id,legacy.project_id,legacy.canvas_id,legacy.revision,legacy.content_digest,legacy.created_at,
  legacy.package_snapshot_id,legacy.digest_manifest_json,legacy.size_bytes,'content_version_ref',legacy.integrity
FROM canvas_command_snapshots_legacy legacy
JOIN canvas_content_versions version
  ON version.workspace_id=legacy.workspace_id
 AND version.project_id=legacy.project_id
 AND version.canvas_id=legacy.canvas_id
 AND version.version_id='version-' || legacy.content_digest
 AND version.canonical_digest=legacy.content_digest;

DROP TABLE canvas_command_snapshots_legacy;

CREATE INDEX idx_canvas_command_snapshots_head
  ON canvas_command_snapshots(workspace_id, project_id, canvas_id, revision DESC);
`
};

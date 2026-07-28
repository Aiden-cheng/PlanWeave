import type { Migration } from "./types.js";

/** Immutable authoritative package content. No filesystem, Git, runtime-state, or result paths are stored. */
export const contentVersionMigration: Migration = {
  version: 33,
  sql: `
CREATE TABLE IF NOT EXISTS canvas_content_versions (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  canonical_digest TEXT NOT NULL CHECK(length(canonical_digest)=64),
  total_bytes INTEGER NOT NULL CHECK(total_bytes > 0),
  created_at TEXT NOT NULL,
  creator_kind TEXT NOT NULL CHECK(creator_kind IN ('human','local_admin','system')),
  creator_id TEXT NOT NULL,
  creator_display_name TEXT,
  PRIMARY KEY(workspace_id, project_id, canvas_id, version_id),
  UNIQUE(workspace_id, project_id, canvas_id, canonical_digest)
);
CREATE TABLE IF NOT EXISTS canvas_content_version_members (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  member_path TEXT NOT NULL,
  member_kind TEXT NOT NULL CHECK(member_kind IN ('manifest','task_prompt','block_prompt','desktop_layout')),
  content TEXT NOT NULL,
  digest_sha256 TEXT NOT NULL CHECK(length(digest_sha256)=64),
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  PRIMARY KEY(workspace_id, project_id, canvas_id, version_id, member_path),
  FOREIGN KEY(workspace_id, project_id, canvas_id, version_id)
    REFERENCES canvas_content_versions(workspace_id, project_id, canvas_id, version_id) ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS canvas_content_heads (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 0),
  version_id TEXT,
  canonical_digest TEXT,
  advanced_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, project_id, canvas_id),
  CHECK((revision = 0 AND version_id IS NULL AND canonical_digest IS NULL) OR
        (revision > 0 AND version_id IS NOT NULL AND canonical_digest IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS canvas_content_journal (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  previous_revision INTEGER NOT NULL CHECK(previous_revision >= 0),
  version_id TEXT NOT NULL,
  canonical_digest TEXT NOT NULL CHECK(length(canonical_digest)=64),
  accepted_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, project_id, canvas_id, revision),
  CHECK(revision = previous_revision + 1)
);
CREATE TABLE IF NOT EXISTS canvas_content_acknowledgements (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  device_session_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  canonical_digest TEXT NOT NULL CHECK(length(canonical_digest)=64),
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, project_id, canvas_id, device_session_id)
);
`
};

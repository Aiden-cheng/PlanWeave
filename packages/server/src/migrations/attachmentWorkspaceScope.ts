import type { SqliteDatabase } from "../sqlite.js";
import type { Migration } from "./types.js";

function tableColumns(database: SqliteDatabase, table: string): Set<string> {
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
}

function recreatePendingUploads(database: SqliteDatabase): void {
  const columns = tableColumns(database, "comment_pending_uploads");
  if (columns.size === 0) return;
  if (columns.has("workspace_id")) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_comment_pending_uploads_workspace_project_status_expires
        ON comment_pending_uploads(workspace_id,project_id,status,expires_at);
      CREATE TABLE IF NOT EXISTS comment_pending_uploads_unscoped_legacy (
        pending_upload_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        quarantined_at TEXT NOT NULL
      );
    `);
    return;
  }

  const quarantinedAt = new Date().toISOString();
  database.exec(`
    ALTER TABLE comment_pending_uploads RENAME TO comment_pending_uploads_legacy_v39;
    DROP INDEX IF EXISTS idx_comment_pending_uploads_project_status_expires;
    DROP INDEX IF EXISTS idx_comment_pending_uploads_digest;
    CREATE TABLE comment_pending_uploads (
      pending_upload_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      uploader_human_principal_id TEXT NOT NULL,
      expected_digest_sha256 TEXT,
      expected_size_bytes INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      file_name TEXT,
      comment_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','uploaded','finalized','expired','aborted')),
      digest_sha256 TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      uploaded_at TEXT,
      finalized_at TEXT,
      PRIMARY KEY(workspace_id,project_id,pending_upload_id)
    );
    CREATE INDEX idx_comment_pending_uploads_workspace_project_status_expires
      ON comment_pending_uploads(workspace_id,project_id,status,expires_at);
    CREATE INDEX idx_comment_pending_uploads_digest
      ON comment_pending_uploads(digest_sha256)
      WHERE digest_sha256 IS NOT NULL;
    CREATE TABLE comment_pending_uploads_unscoped_legacy (
      pending_upload_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      quarantined_at TEXT NOT NULL
    );
  `);
  database
    .prepare(
      `INSERT INTO comment_pending_uploads(
        pending_upload_id,workspace_id,project_id,uploader_human_principal_id,
        expected_digest_sha256,expected_size_bytes,media_type,file_name,comment_id,status,
        digest_sha256,created_at,expires_at,uploaded_at,finalized_at
      )
      SELECT legacy.pending_upload_id,scopes.workspace_id,legacy.project_id,
             legacy.uploader_human_principal_id,legacy.expected_digest_sha256,
             legacy.expected_size_bytes,legacy.media_type,legacy.file_name,legacy.comment_id,
             legacy.status,legacy.digest_sha256,legacy.created_at,legacy.expires_at,
             legacy.uploaded_at,legacy.finalized_at
      FROM comment_pending_uploads_legacy_v39 legacy
      JOIN (
        SELECT project_id,MIN(workspace_id) AS workspace_id
        FROM project_registry
        WHERE revoked_at IS NULL
        GROUP BY project_id
        HAVING COUNT(DISTINCT workspace_id)=1
      ) scopes ON scopes.project_id=legacy.project_id`
    )
    .run();
  database
    .prepare(
      `INSERT INTO comment_pending_uploads_unscoped_legacy(
        pending_upload_id,project_id,payload_json,quarantined_at
      )
      SELECT legacy.pending_upload_id,legacy.project_id,
             json_object(
               'uploaderHumanPrincipalId',legacy.uploader_human_principal_id,
               'expectedDigestSha256',legacy.expected_digest_sha256,
               'expectedSizeBytes',legacy.expected_size_bytes,
               'mediaType',legacy.media_type,
               'fileName',legacy.file_name,
               'commentId',legacy.comment_id,
               'status',legacy.status,
               'digestSha256',legacy.digest_sha256,
               'createdAt',legacy.created_at,
               'expiresAt',legacy.expires_at,
               'uploadedAt',legacy.uploaded_at,
               'finalizedAt',legacy.finalized_at
             ),?
      FROM comment_pending_uploads_legacy_v39 legacy
      LEFT JOIN (
        SELECT project_id
        FROM project_registry
        WHERE revoked_at IS NULL
        GROUP BY project_id
        HAVING COUNT(DISTINCT workspace_id)=1
      ) scopes ON scopes.project_id=legacy.project_id
      WHERE scopes.project_id IS NULL`
    )
    .run(quarantinedAt);
  database.exec("DROP TABLE comment_pending_uploads_legacy_v39");
}

function recreateBindings(database: SqliteDatabase): void {
  const columns = tableColumns(database, "comment_attachment_bindings");
  if (columns.size === 0) return;
  if (columns.has("workspace_id")) {
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_comment_attachment_bindings_workspace_project_digest
        ON comment_attachment_bindings(workspace_id,project_id,digest_sha256);
      CREATE TABLE IF NOT EXISTS comment_attachment_bindings_unscoped_legacy (
        project_id TEXT NOT NULL,
        comment_id TEXT NOT NULL,
        digest_sha256 TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        quarantined_at TEXT NOT NULL,
        PRIMARY KEY(project_id,comment_id,digest_sha256)
      );
    `);
    return;
  }

  const quarantinedAt = new Date().toISOString();
  database.exec(`
    ALTER TABLE comment_attachment_bindings RENAME TO comment_attachment_bindings_legacy_v39;
    DROP INDEX IF EXISTS idx_comment_attachment_bindings_project_digest;
    CREATE TABLE comment_attachment_bindings (
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      digest_sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      file_name TEXT,
      created_at TEXT NOT NULL,
      comment_tombstoned_at TEXT,
      PRIMARY KEY(workspace_id,project_id,comment_id,digest_sha256)
    );
    CREATE INDEX idx_comment_attachment_bindings_workspace_project_digest
      ON comment_attachment_bindings(workspace_id,project_id,digest_sha256);
    CREATE TABLE comment_attachment_bindings_unscoped_legacy (
      project_id TEXT NOT NULL,
      comment_id TEXT NOT NULL,
      digest_sha256 TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      quarantined_at TEXT NOT NULL,
      PRIMARY KEY(project_id,comment_id,digest_sha256)
    );
  `);
  database
    .prepare(
      `INSERT INTO comment_attachment_bindings(
        workspace_id,project_id,comment_id,digest_sha256,size_bytes,media_type,file_name,
        created_at,comment_tombstoned_at
      )
      SELECT scopes.workspace_id,legacy.project_id,legacy.comment_id,legacy.digest_sha256,
             legacy.size_bytes,legacy.media_type,legacy.file_name,legacy.created_at,
             legacy.comment_tombstoned_at
      FROM comment_attachment_bindings_legacy_v39 legacy
      JOIN (
        SELECT project_id,MIN(workspace_id) AS workspace_id
        FROM project_registry
        WHERE revoked_at IS NULL
        GROUP BY project_id
        HAVING COUNT(DISTINCT workspace_id)=1
      ) scopes ON scopes.project_id=legacy.project_id`
    )
    .run();
  database
    .prepare(
      `INSERT INTO comment_attachment_bindings_unscoped_legacy(
        project_id,comment_id,digest_sha256,payload_json,quarantined_at
      )
      SELECT legacy.project_id,legacy.comment_id,legacy.digest_sha256,
             json_object(
               'sizeBytes',legacy.size_bytes,
               'mediaType',legacy.media_type,
               'fileName',legacy.file_name,
               'createdAt',legacy.created_at,
               'commentTombstonedAt',legacy.comment_tombstoned_at
             ),?
      FROM comment_attachment_bindings_legacy_v39 legacy
      LEFT JOIN (
        SELECT project_id
        FROM project_registry
        WHERE revoked_at IS NULL
        GROUP BY project_id
        HAVING COUNT(DISTINCT workspace_id)=1
      ) scopes ON scopes.project_id=legacy.project_id
      WHERE scopes.project_id IS NULL`
    )
    .run(quarantinedAt);
  database.exec("DROP TABLE comment_attachment_bindings_legacy_v39");
}

export const attachmentWorkspaceScopeMigration: Migration = {
  version: 39,
  sql: "SELECT 1;",
  before(database) {
    recreatePendingUploads(database);
    recreateBindings(database);
  }
};

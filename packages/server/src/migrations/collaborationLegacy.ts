/**
 * Work assignment coordination store (HC-002#B-002).
 * Keyed by project + exact WorkItemRef (kind/canvas/key). Target is normalized columns only —
 * never task titles, prompts, Block lifecycle, Host presence, or capability copies.
 * Unassign keeps a durable row with target_kind='unassigned' (revision advances; no silent delete).
 */
import type { Migration } from "./types.js";
import type { SqliteDatabase } from "../sqlite.js";
import { tableExists } from "./legacyTail.js";

export const migration17 = `
CREATE TABLE work_assignments (
  project_id TEXT NOT NULL CHECK(
    length(project_id) BETWEEN 1 AND 128
    AND project_id GLOB '[A-Za-z0-9]*'
    AND project_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  canvas_id TEXT NOT NULL CHECK(
    length(canvas_id) BETWEEN 1 AND 128
    AND canvas_id GLOB '[A-Za-z0-9]*'
    AND canvas_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  work_item_kind TEXT NOT NULL CHECK(work_item_kind IN ('task','block')),
  work_item_key TEXT NOT NULL CHECK(length(work_item_key) BETWEEN 1 AND 256),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('unassigned','human','exact_host','automatic_host')),
  target_human_principal_id TEXT CHECK(
    target_human_principal_id IS NULL
    OR (
      length(target_human_principal_id) BETWEEN 1 AND 128
      AND target_human_principal_id GLOB '[A-Za-z0-9]*'
      AND target_human_principal_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  target_host_id TEXT CHECK(
    target_host_id IS NULL
    OR (
      length(target_host_id) BETWEEN 1 AND 128
      AND target_host_id GLOB '[A-Za-z0-9]*'
      AND target_host_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_by_kind TEXT NOT NULL CHECK(updated_by_kind IN ('human','local_admin','system')),
  updated_by_id TEXT NOT NULL CHECK(
    length(updated_by_id) BETWEEN 1 AND 128
    AND updated_by_id GLOB '[A-Za-z0-9]*'
    AND updated_by_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  updated_by_display_name TEXT CHECK(
    updated_by_display_name IS NULL OR length(updated_by_display_name) BETWEEN 1 AND 128
  ),
  updated_at TEXT NOT NULL,
  reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 512),
  PRIMARY KEY (project_id, canvas_id, work_item_kind, work_item_key),
  CHECK(
    (target_kind = 'unassigned' AND target_human_principal_id IS NULL AND target_host_id IS NULL)
    OR (target_kind = 'human' AND target_human_principal_id IS NOT NULL AND target_host_id IS NULL)
    OR (target_kind = 'exact_host' AND target_host_id IS NOT NULL AND target_human_principal_id IS NULL)
    OR (target_kind = 'automatic_host' AND target_human_principal_id IS NULL AND target_host_id IS NULL)
  ),
  CHECK(
    (work_item_kind = 'task' AND target_kind IN ('unassigned','human'))
    OR work_item_kind = 'block'
  )
);

CREATE INDEX idx_work_assignments_project_canvas
  ON work_assignments(project_id, canvas_id, updated_at);

CREATE INDEX idx_work_assignments_project_target_human
  ON work_assignments(project_id, target_human_principal_id)
  WHERE target_kind = 'human';

CREATE INDEX idx_work_assignments_project_target_host
  ON work_assignments(project_id, target_host_id)
  WHERE target_kind = 'exact_host';
`;

/**
 * Durable Host selection fingerprint authorized at dispatch begin.
 * Restart/recovery must use this snapshot — never re-resolve from a later assignment
 * while a snapshot exists. Partial upgrade fixtures may lack remote_operations
 * (table created in v10); skip then.
 *
 * Pre-v18 pending rows upgrade with host_selection_json NULL. That is intentional:
 * inventing a fingerprint from a later assignment or reserved host would silently
 * retarget. Startup reconciliation recovers NULL once via current-assignment
 * revalidation + persist (see RemoteBlockCoordinator.resolvePreferredHostId).
 */
export const migration18 = "SELECT 1;";

/**
 * Human comment attachment staged uploads + content-addressed blobs + comment bindings.
 * Separate from dispatch artifact_blobs/artifact_grants — Host grants never authorize these rows.
 */
export const migration19 = `
CREATE TABLE comment_attachment_blobs (
  digest_sha256 TEXT PRIMARY KEY CHECK(
    length(digest_sha256) = 64 AND digest_sha256 GLOB '[0-9a-f]*'
  ),
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 1 AND size_bytes <= 8388608),
  media_type TEXT NOT NULL CHECK(
    media_type IN (
      'image/png','image/jpeg','image/webp','image/gif',
      'application/pdf','text/plain','text/markdown'
    )
  ),
  relative_path TEXT NOT NULL CHECK(
    length(relative_path) = 67
    AND relative_path GLOB '[0-9a-f][0-9a-f]/[0-9a-f]*'
  ),
  created_at TEXT NOT NULL
);

CREATE TABLE comment_pending_uploads (
  pending_upload_id TEXT PRIMARY KEY CHECK(
    length(pending_upload_id) BETWEEN 1 AND 128
    AND pending_upload_id GLOB '[A-Za-z0-9]*'
    AND pending_upload_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  project_id TEXT NOT NULL CHECK(
    length(project_id) BETWEEN 1 AND 128
    AND project_id GLOB '[A-Za-z0-9]*'
    AND project_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  uploader_human_principal_id TEXT NOT NULL CHECK(
    length(uploader_human_principal_id) BETWEEN 1 AND 128
    AND uploader_human_principal_id GLOB '[A-Za-z0-9]*'
    AND uploader_human_principal_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  expected_digest_sha256 TEXT CHECK(
    expected_digest_sha256 IS NULL
    OR (length(expected_digest_sha256) = 64 AND expected_digest_sha256 GLOB '[0-9a-f]*')
  ),
  expected_size_bytes INTEGER NOT NULL CHECK(expected_size_bytes >= 1 AND expected_size_bytes <= 8388608),
  media_type TEXT NOT NULL CHECK(
    media_type IN (
      'image/png','image/jpeg','image/webp','image/gif',
      'application/pdf','text/plain','text/markdown'
    )
  ),
  file_name TEXT CHECK(
    file_name IS NULL
    OR (
      length(file_name) BETWEEN 1 AND 255
      AND file_name NOT GLOB '*[/\\]*'
      AND file_name NOT IN ('.','..')
    )
  ),
  comment_id TEXT CHECK(
    comment_id IS NULL
    OR (
      length(comment_id) BETWEEN 1 AND 128
      AND comment_id GLOB '[A-Za-z0-9]*'
      AND comment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  status TEXT NOT NULL CHECK(status IN ('pending','uploaded','finalized','expired','aborted')),
  digest_sha256 TEXT CHECK(
    digest_sha256 IS NULL
    OR (length(digest_sha256) = 64 AND digest_sha256 GLOB '[0-9a-f]*')
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  uploaded_at TEXT,
  finalized_at TEXT,
  CHECK(
    (status = 'pending' AND digest_sha256 IS NULL AND uploaded_at IS NULL AND finalized_at IS NULL)
    OR (status = 'uploaded' AND digest_sha256 IS NOT NULL AND uploaded_at IS NOT NULL AND finalized_at IS NULL)
    OR (status = 'finalized' AND digest_sha256 IS NOT NULL AND uploaded_at IS NOT NULL AND finalized_at IS NOT NULL)
    OR (status IN ('expired','aborted'))
  )
);

CREATE INDEX idx_comment_pending_uploads_project_status_expires
  ON comment_pending_uploads(project_id, status, expires_at);

CREATE INDEX idx_comment_pending_uploads_digest
  ON comment_pending_uploads(digest_sha256)
  WHERE digest_sha256 IS NOT NULL;

CREATE TABLE comment_attachment_bindings (
  project_id TEXT NOT NULL CHECK(
    length(project_id) BETWEEN 1 AND 128
    AND project_id GLOB '[A-Za-z0-9]*'
    AND project_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  comment_id TEXT NOT NULL CHECK(
    length(comment_id) BETWEEN 1 AND 128
    AND comment_id GLOB '[A-Za-z0-9]*'
    AND comment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  digest_sha256 TEXT NOT NULL CHECK(
    length(digest_sha256) = 64 AND digest_sha256 GLOB '[0-9a-f]*'
  ),
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 1 AND size_bytes <= 8388608),
  media_type TEXT NOT NULL CHECK(
    media_type IN (
      'image/png','image/jpeg','image/webp','image/gif',
      'application/pdf','text/plain','text/markdown'
    )
  ),
  file_name TEXT CHECK(
    file_name IS NULL
    OR (
      length(file_name) BETWEEN 1 AND 255
      AND file_name NOT GLOB '*[/\\]*'
      AND file_name NOT IN ('.','..')
    )
  ),
  created_at TEXT NOT NULL,
  comment_tombstoned_at TEXT,
  PRIMARY KEY (project_id, comment_id, digest_sha256)
);

CREATE INDEX idx_comment_attachment_bindings_project_digest
  ON comment_attachment_bindings(project_id, digest_sha256);
`;

/**
 * Scoped comments + append-only activity projection (HC-003#B-003).
 * Comments annotate WorkItemRefs; activity is a bounded read projection with source-action
 * idempotency. Outbox supports reconciliation when projection is deferred or interrupted.
 */
export const migration20 = `
CREATE TABLE comments (
  comment_id TEXT PRIMARY KEY CHECK(
    length(comment_id) BETWEEN 1 AND 128
    AND comment_id GLOB '[A-Za-z0-9]*'
    AND comment_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  project_id TEXT NOT NULL CHECK(
    length(project_id) BETWEEN 1 AND 128
    AND project_id GLOB '[A-Za-z0-9]*'
    AND project_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  canvas_id TEXT NOT NULL CHECK(
    length(canvas_id) BETWEEN 1 AND 128
    AND canvas_id GLOB '[A-Za-z0-9]*'
    AND canvas_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  work_item_kind TEXT NOT NULL CHECK(work_item_kind IN ('task','block')),
  work_item_key TEXT NOT NULL CHECK(length(work_item_key) BETWEEN 1 AND 256),
  author_human_principal_id TEXT NOT NULL CHECK(
    length(author_human_principal_id) BETWEEN 1 AND 128
    AND author_human_principal_id GLOB '[A-Za-z0-9]*'
    AND author_human_principal_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 16384),
  body_format TEXT NOT NULL CHECK(body_format = 'markdown'),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  attachments_json TEXT NOT NULL CHECK(json_valid(attachments_json)),
  tombstoned_at TEXT,
  tombstoned_by_kind TEXT CHECK(
    tombstoned_by_kind IS NULL
    OR tombstoned_by_kind IN ('human','local_admin','system')
  ),
  tombstoned_by_id TEXT CHECK(
    tombstoned_by_id IS NULL
    OR (
      length(tombstoned_by_id) BETWEEN 1 AND 128
      AND tombstoned_by_id GLOB '[A-Za-z0-9]*'
      AND tombstoned_by_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  tombstoned_by_display_name TEXT CHECK(
    tombstoned_by_display_name IS NULL
    OR length(tombstoned_by_display_name) BETWEEN 1 AND 128
  ),
  tombstone_reason TEXT CHECK(
    tombstone_reason IS NULL OR length(tombstone_reason) BETWEEN 1 AND 512
  ),
  CHECK(
    (tombstoned_at IS NULL AND tombstoned_by_kind IS NULL AND tombstoned_by_id IS NULL
      AND tombstoned_by_display_name IS NULL AND tombstone_reason IS NULL)
    OR (tombstoned_at IS NOT NULL AND tombstoned_by_kind IS NOT NULL AND tombstoned_by_id IS NOT NULL)
  )
);

CREATE INDEX idx_comments_project_work_item_created
  ON comments(project_id, canvas_id, work_item_kind, work_item_key, created_at, comment_id);

CREATE INDEX idx_comments_project_author
  ON comments(project_id, author_human_principal_id, created_at);

CREATE TABLE activity_records (
  activity_id TEXT PRIMARY KEY CHECK(
    length(activity_id) BETWEEN 1 AND 128
    AND activity_id GLOB '[A-Za-z0-9]*'
    AND activity_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  project_id TEXT NOT NULL CHECK(
    length(project_id) BETWEEN 1 AND 128
    AND project_id GLOB '[A-Za-z0-9]*'
    AND project_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  type TEXT NOT NULL CHECK(type IN (
    'member_joined','member_left','member_removed','owner_promoted','owner_demoted',
    'assignment_updated',
    'comment_created','comment_edited','comment_tombstoned',
    'remote_run_started','remote_run_succeeded','remote_run_failed','remote_run_interrupted'
  )),
  source_kind TEXT NOT NULL CHECK(source_kind IN (
    'membership','assignment','comment','remote_run'
  )),
  source_id TEXT NOT NULL CHECK(
    length(source_id) BETWEEN 1 AND 128
    AND source_id GLOB '[A-Za-z0-9]*'
    AND source_id NOT GLOB '*[^A-Za-z0-9._:#-]*'
  ),
  summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
  subjects_json TEXT NOT NULL CHECK(json_valid(subjects_json)),
  canvas_id TEXT CHECK(
    canvas_id IS NULL
    OR (
      length(canvas_id) BETWEEN 1 AND 128
      AND canvas_id GLOB '[A-Za-z0-9]*'
      AND canvas_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  work_item_kind TEXT CHECK(work_item_kind IS NULL OR work_item_kind IN ('task','block')),
  work_item_key TEXT CHECK(work_item_key IS NULL OR length(work_item_key) BETWEEN 1 AND 256),
  occurred_at TEXT NOT NULL,
  UNIQUE(project_id, source_kind, source_id),
  CHECK(
    (canvas_id IS NULL AND work_item_kind IS NULL AND work_item_key IS NULL)
    OR (canvas_id IS NOT NULL AND work_item_kind IS NOT NULL AND work_item_key IS NOT NULL)
  )
);

CREATE INDEX idx_activity_records_project_occurred
  ON activity_records(project_id, occurred_at DESC, activity_id DESC);

CREATE INDEX idx_activity_records_project_work_item
  ON activity_records(project_id, canvas_id, work_item_kind, work_item_key, occurred_at DESC, activity_id DESC)
  WHERE canvas_id IS NOT NULL;

CREATE TABLE activity_projection_outbox (
  outbox_id TEXT PRIMARY KEY CHECK(
    length(outbox_id) BETWEEN 1 AND 128
    AND outbox_id GLOB '[A-Za-z0-9]*'
    AND outbox_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  project_id TEXT NOT NULL CHECK(
    length(project_id) BETWEEN 1 AND 128
    AND project_id GLOB '[A-Za-z0-9]*'
    AND project_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  source_kind TEXT NOT NULL CHECK(source_kind IN (
    'membership','assignment','comment','remote_run'
  )),
  source_id TEXT NOT NULL CHECK(
    length(source_id) BETWEEN 1 AND 128
    AND source_id GLOB '[A-Za-z0-9]*'
    AND source_id NOT GLOB '*[^A-Za-z0-9._:#-]*'
  ),
  activity_json TEXT NOT NULL CHECK(json_valid(activity_json)),
  created_at TEXT NOT NULL,
  projected_at TEXT,
  UNIQUE(project_id, source_kind, source_id)
);

CREATE INDEX idx_activity_projection_outbox_pending
  ON activity_projection_outbox(created_at)
  WHERE projected_at IS NULL;
`;

export function ensureRemoteActionRejectionState(database: SqliteDatabase): void {
  if (!tableExists(database, "remote_execution_actions")) return;
  const hasRejectedAt = database
    .prepare(
      "SELECT 1 AS present FROM pragma_table_info('remote_execution_actions') WHERE name='rejected_at'"
    )
    .get();
  if (hasRejectedAt) return;
  database.exec(`
    CREATE TABLE remote_execution_actions_v22 (
      action_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES remote_operations(id),
      dispatch_id TEXT NOT NULL,
      execution_attempt_id TEXT NOT NULL REFERENCES remote_execution_attempts(execution_attempt_id),
      kind TEXT NOT NULL CHECK(kind IN ('resume_same_session','retry_new_attempt','fail','block','cancel')),
      request_fingerprint TEXT NOT NULL CHECK(
        length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^a-f0-9]*'
      ),
      request_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('recorded','delivered','acknowledged','settled','rejected')),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      acknowledged_at TEXT,
      settled_at TEXT,
      rejected_at TEXT,
      rejection_code TEXT CHECK(
        rejection_code IS NULL OR rejection_code='work_not_agent_assigned'
      ),
      CHECK(
        (state='recorded' AND delivered_at IS NULL AND acknowledged_at IS NULL
          AND settled_at IS NULL AND rejected_at IS NULL AND rejection_code IS NULL)
        OR (state='delivered' AND delivered_at IS NOT NULL AND acknowledged_at IS NULL
          AND settled_at IS NULL AND rejected_at IS NULL AND rejection_code IS NULL)
        OR (state='acknowledged' AND delivered_at IS NOT NULL AND acknowledged_at IS NOT NULL
          AND settled_at IS NULL AND rejected_at IS NULL AND rejection_code IS NULL)
        OR (state='settled' AND settled_at IS NOT NULL
          AND rejected_at IS NULL AND rejection_code IS NULL)
        OR (state='rejected' AND delivered_at IS NULL AND acknowledged_at IS NULL
          AND settled_at IS NULL AND rejected_at IS NOT NULL AND rejection_code IS NOT NULL)
      )
    );

    INSERT INTO remote_execution_actions_v22(
      action_id,operation_id,dispatch_id,execution_attempt_id,kind,
      request_fingerprint,request_json,state,created_at,delivered_at,acknowledged_at,settled_at,
      rejected_at,rejection_code
    )
    SELECT
      action_id,operation_id,dispatch_id,execution_attempt_id,kind,
      request_fingerprint,request_json,state,created_at,delivered_at,acknowledged_at,settled_at,
      NULL,NULL
    FROM remote_execution_actions;

    DROP INDEX idx_remote_execution_actions_operation_state;
    DROP TABLE remote_execution_actions;
    ALTER TABLE remote_execution_actions_v22 RENAME TO remote_execution_actions;
    CREATE INDEX idx_remote_execution_actions_operation_state
      ON remote_execution_actions(operation_id,state,created_at);
  `);
}

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

import type { SqliteDatabase } from "../sqlite.js";
import type { Migration } from "./types.js";

function tableColumns(database: SqliteDatabase, table: string): Set<string> {
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
}

function workspaceBackfillExpression(database: SqliteDatabase, tableAlias: string): string {
  const hasProjectRegistry = tableColumns(database, "project_registry").size > 0;
  if (!hasProjectRegistry) return "'legacy'";
  return `COALESCE(
    (SELECT MIN(pr.workspace_id) FROM project_registry pr
     WHERE pr.project_id=${tableAlias}.project_id
     HAVING COUNT(*)=1),
    'legacy'
  )`;
}

function migrateComments(database: SqliteDatabase): void {
  const columns = tableColumns(database, "comments");
  if (columns.size === 0) return;
  if (!columns.has("workspace_id")) {
    database.exec("ALTER TABLE comments ADD COLUMN workspace_id TEXT");
  }
  database.exec(`
UPDATE comments
SET workspace_id=${workspaceBackfillExpression(database, "comments")}
WHERE workspace_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_comments_workspace_project_work_item_created
  ON comments(workspace_id,project_id,canvas_id,work_item_kind,work_item_key,created_at,comment_id);
`);
}

function migrateActivityRecords(database: SqliteDatabase): void {
  const columns = tableColumns(database, "activity_records");
  if (columns.size === 0) return;
  const workspaceExpression = columns.has("workspace_id")
    ? `COALESCE(activity_records_v34.workspace_id, ${workspaceBackfillExpression(
        database,
        "activity_records_v34"
      )})`
    : workspaceBackfillExpression(database, "activity_records_v34");

  database.exec(`
ALTER TABLE activity_records RENAME TO activity_records_v34;
CREATE TABLE activity_records (
  activity_id TEXT PRIMARY KEY CHECK(
    length(activity_id) BETWEEN 1 AND 128
    AND activity_id GLOB '[A-Za-z0-9]*'
    AND activity_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  workspace_id TEXT NOT NULL,
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
  UNIQUE(workspace_id, project_id, source_kind, source_id),
  CHECK(
    (canvas_id IS NULL AND work_item_kind IS NULL AND work_item_key IS NULL)
    OR (canvas_id IS NOT NULL AND work_item_kind IS NOT NULL AND work_item_key IS NOT NULL)
  )
);
INSERT INTO activity_records(
  activity_id,workspace_id,project_id,type,source_kind,source_id,summary_json,subjects_json,
  canvas_id,work_item_kind,work_item_key,occurred_at
)
SELECT
  activity_id,${workspaceExpression},project_id,type,source_kind,source_id,summary_json,subjects_json,
  canvas_id,work_item_kind,work_item_key,occurred_at
FROM activity_records_v34;
DROP TABLE activity_records_v34;
CREATE INDEX idx_activity_records_project_occurred
  ON activity_records(project_id, occurred_at DESC, activity_id DESC);
CREATE INDEX idx_activity_records_project_work_item
  ON activity_records(project_id, canvas_id, work_item_kind, work_item_key, occurred_at DESC, activity_id DESC)
  WHERE canvas_id IS NOT NULL;
CREATE INDEX idx_activity_records_retention
  ON activity_records(occurred_at, activity_id);
CREATE INDEX idx_activity_workspace_project_occurred
  ON activity_records(workspace_id,project_id,occurred_at DESC,activity_id DESC);
`);
}

function migrateActivityOutbox(database: SqliteDatabase): void {
  const columns = tableColumns(database, "activity_projection_outbox");
  if (columns.size === 0) return;
  const workspaceExpression = columns.has("workspace_id")
    ? `COALESCE(activity_projection_outbox_v34.workspace_id, ${workspaceBackfillExpression(
        database,
        "activity_projection_outbox_v34"
      )})`
    : workspaceBackfillExpression(database, "activity_projection_outbox_v34");
  const occurredAtExpression = columns.has("activity_occurred_at")
    ? "activity_occurred_at"
    : "json_extract(activity_json, '$.occurredAt')";

  database.exec(`
ALTER TABLE activity_projection_outbox RENAME TO activity_projection_outbox_v34;
CREATE TABLE activity_projection_outbox (
  outbox_id TEXT PRIMARY KEY CHECK(
    length(outbox_id) BETWEEN 1 AND 128
    AND outbox_id GLOB '[A-Za-z0-9]*'
    AND outbox_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  workspace_id TEXT NOT NULL,
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
  activity_occurred_at TEXT,
  created_at TEXT NOT NULL,
  projected_at TEXT,
  UNIQUE(workspace_id, project_id, source_kind, source_id)
);
INSERT INTO activity_projection_outbox(
  outbox_id,workspace_id,project_id,source_kind,source_id,activity_json,activity_occurred_at,
  created_at,projected_at
)
SELECT
  outbox_id,${workspaceExpression},project_id,source_kind,source_id,activity_json,
  ${occurredAtExpression},created_at,projected_at
FROM activity_projection_outbox_v34;
DROP TABLE activity_projection_outbox_v34;
CREATE INDEX idx_activity_projection_outbox_pending
  ON activity_projection_outbox(created_at)
  WHERE projected_at IS NULL;
CREATE INDEX idx_activity_outbox_retention
  ON activity_projection_outbox(activity_occurred_at, outbox_id);
CREATE INDEX idx_activity_outbox_workspace_source
  ON activity_projection_outbox(workspace_id,project_id,source_kind,source_id);
`);
}

export const commentWorkspaceScopeMigration: Migration = {
  version: 35,
  sql: "",
  before(database) {
    migrateComments(database);
    migrateActivityRecords(database);
    migrateActivityOutbox(database);
  }
};

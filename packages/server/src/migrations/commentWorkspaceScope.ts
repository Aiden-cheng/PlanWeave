import type { SqliteDatabase } from "../sqlite.js";
import type { Migration } from "./types.js";

function ensureWorkspaceColumn(database: SqliteDatabase, table: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.length === 0) return false;
  if (!columns.some((column) => column.name === "workspace_id")) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN workspace_id TEXT`);
  }
  return true;
}

export const commentWorkspaceScopeMigration: Migration = {
  version: 35,
  sql: "",
  before(database) {
    if (ensureWorkspaceColumn(database, "comments")) {
      database.exec(`
UPDATE comments
SET workspace_id=COALESCE(
  (SELECT MIN(pr.workspace_id) FROM project_registry pr
   WHERE pr.project_id=comments.project_id
   HAVING COUNT(*)=1),
  'legacy'
);
CREATE INDEX IF NOT EXISTS idx_comments_workspace_project_work_item_created
  ON comments(workspace_id,project_id,canvas_id,work_item_kind,work_item_key,created_at,comment_id);
`);
    }
    if (ensureWorkspaceColumn(database, "activity_records")) {
      database.exec(`
UPDATE activity_records
SET workspace_id=COALESCE(
  (SELECT MIN(pr.workspace_id) FROM project_registry pr
   WHERE pr.project_id=activity_records.project_id
   HAVING COUNT(*)=1),
  'legacy'
);
CREATE INDEX IF NOT EXISTS idx_activity_workspace_project_occurred
  ON activity_records(workspace_id,project_id,occurred_at DESC,activity_id DESC);
`);
    }
    if (ensureWorkspaceColumn(database, "activity_projection_outbox")) {
      database.exec(`
UPDATE activity_projection_outbox
SET workspace_id=COALESCE(
  (SELECT MIN(pr.workspace_id) FROM project_registry pr
   WHERE pr.project_id=activity_projection_outbox.project_id
   HAVING COUNT(*)=1),
  'legacy'
);
CREATE INDEX IF NOT EXISTS idx_activity_outbox_workspace_source
  ON activity_projection_outbox(workspace_id,project_id,source_kind,source_id);
`);
    }
  }
};

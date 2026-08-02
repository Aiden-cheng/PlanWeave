import type { SqliteDatabase } from "../sqlite.js";
import type { Migration } from "./types.js";

type JournalIntentRow = {
  workspace_id: string;
  project_id: string;
  canvas_id: string;
  intent_json: string;
};

function requiresBaselineRebuild(intentJson: string): boolean {
  let intent: unknown;
  try {
    intent = JSON.parse(intentJson);
  } catch {
    return false;
  }
  if (typeof intent !== "object" || intent === null) return false;
  const record = intent as Record<string, unknown>;
  if (record.kind === "update_layout") return typeof record.updatedAt !== "string";
  return (
    record.kind === "add_task" &&
    record.layout !== undefined &&
    typeof record.layoutUpdatedAt !== "string"
  );
}

export function markLegacyCanvasBaselines(database: SqliteDatabase): void {
  const rows = database
    .prepare(
      `SELECT workspace_id,project_id,canvas_id,intent_json
         FROM canvas_command_journal
        ORDER BY workspace_id,project_id,canvas_id,revision`
    )
    .all() as JournalIntentRow[];
  const insert = database.prepare(
    `INSERT INTO canvas_command_baseline_rebases(
       workspace_id,project_id,canvas_id,source_revision,source_content_digest,
       status,reason,detected_at,completed_at,replacement_content_digest
     )
     SELECT h.workspace_id,h.project_id,h.canvas_id,h.revision,h.content_digest,
            'pending','legacy_nondeterministic_layout',h.updated_at,NULL,NULL
       FROM canvas_command_heads h
      WHERE h.workspace_id=? AND h.project_id=? AND h.canvas_id=?
     ON CONFLICT(workspace_id,project_id,canvas_id) DO NOTHING`
  );
  const marked = new Set<string>();
  for (const row of rows) {
    if (!requiresBaselineRebuild(row.intent_json)) continue;
    const key = `${row.workspace_id}\0${row.project_id}\0${row.canvas_id}`;
    if (marked.has(key)) continue;
    marked.add(key);
    insert.run(row.workspace_id, row.project_id, row.canvas_id);
  }
}

export const canvasBaselineMigration: Migration = {
  version: 41,
  sql: `
CREATE TABLE IF NOT EXISTS canvas_command_baseline_rebases (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK(source_revision >= 0),
  source_content_digest TEXT NOT NULL CHECK(length(source_content_digest)=64),
  status TEXT NOT NULL CHECK(status IN ('pending','completed')),
  reason TEXT NOT NULL CHECK(reason IN ('legacy_nondeterministic_layout')),
  detected_at TEXT NOT NULL,
  completed_at TEXT,
  replacement_content_digest TEXT CHECK(
    replacement_content_digest IS NULL OR length(replacement_content_digest)=64
  ),
  PRIMARY KEY(workspace_id, project_id, canvas_id)
);

CREATE TABLE IF NOT EXISTS canvas_command_legacy_archive (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK(record_kind IN ('journal','operation','snapshot','pending')),
  record_key TEXT NOT NULL,
  record_json TEXT NOT NULL,
  archived_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('legacy_nondeterministic_layout')),
  PRIMARY KEY(workspace_id, project_id, canvas_id, record_kind, record_key)
);
`,
  after: markLegacyCanvasBaselines
};

import type { Migration } from "./types.js";

/**
 * Legacy assignment rows were keyed only by project. Rebuild the table with an
 * explicit workspace key, copying only rows with one deterministic legacy
 * project mapping. Unmapped rows remain quarantined and cannot be read by the
 * scoped repository.
 */
export const assignmentWorkspaceScopeMigration: Migration = {
  version: 37,
  sql: `
CREATE TABLE work_assignments_unscoped_legacy (
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  work_item_kind TEXT NOT NULL,
  work_item_key TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_human_principal_id TEXT,
  target_host_id TEXT,
  revision INTEGER NOT NULL,
  updated_by_kind TEXT NOT NULL,
  updated_by_id TEXT NOT NULL,
  updated_by_display_name TEXT,
  updated_at TEXT NOT NULL,
  reason TEXT,
  quarantined_at TEXT NOT NULL
);

CREATE TABLE work_assignments_scoped (
  workspace_id TEXT NOT NULL CHECK(
    length(workspace_id) BETWEEN 1 AND 128
    AND workspace_id GLOB '[A-Za-z0-9]*'
    AND workspace_id NOT GLOB '*[^A-Za-z0-9._:-]*'
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
  target_kind TEXT NOT NULL CHECK(target_kind IN ('unassigned','human','exact_host','automatic_host')),
  target_human_principal_id TEXT,
  target_host_id TEXT,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_by_kind TEXT NOT NULL CHECK(updated_by_kind IN ('human','local_admin','system')),
  updated_by_id TEXT NOT NULL,
  updated_by_display_name TEXT,
  updated_at TEXT NOT NULL,
  reason TEXT,
  PRIMARY KEY (workspace_id, project_id, canvas_id, work_item_kind, work_item_key),
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

INSERT INTO work_assignments_scoped(
  workspace_id,project_id,canvas_id,work_item_kind,work_item_key,
  target_kind,target_human_principal_id,target_host_id,revision,
  updated_by_kind,updated_by_id,updated_by_display_name,updated_at,reason
)
SELECT map.workspace_id,legacy.project_id,legacy.canvas_id,legacy.work_item_kind,legacy.work_item_key,
       legacy.target_kind,legacy.target_human_principal_id,legacy.target_host_id,legacy.revision,
       legacy.updated_by_kind,legacy.updated_by_id,legacy.updated_by_display_name,legacy.updated_at,legacy.reason
FROM work_assignments legacy
JOIN legacy_project_workspace_mappings map ON map.legacy_project_id=legacy.project_id;

INSERT INTO work_assignments_unscoped_legacy(
  project_id,canvas_id,work_item_kind,work_item_key,target_kind,target_human_principal_id,target_host_id,
  revision,updated_by_kind,updated_by_id,updated_by_display_name,updated_at,reason,quarantined_at
)
SELECT legacy.project_id,legacy.canvas_id,legacy.work_item_kind,legacy.work_item_key,legacy.target_kind,
       legacy.target_human_principal_id,legacy.target_host_id,legacy.revision,legacy.updated_by_kind,
       legacy.updated_by_id,legacy.updated_by_display_name,legacy.updated_at,legacy.reason,datetime('now')
FROM work_assignments legacy
LEFT JOIN legacy_project_workspace_mappings map ON map.legacy_project_id=legacy.project_id
WHERE map.workspace_id IS NULL;

DROP TABLE work_assignments;
ALTER TABLE work_assignments_scoped RENAME TO work_assignments;

CREATE INDEX idx_work_assignments_project_canvas
  ON work_assignments(workspace_id, project_id, canvas_id, updated_at);
CREATE INDEX idx_work_assignments_project_target_human
  ON work_assignments(workspace_id, project_id, target_human_principal_id)
  WHERE target_kind = 'human';
CREATE INDEX idx_work_assignments_project_target_host
  ON work_assignments(workspace_id, project_id, target_host_id)
  WHERE target_kind = 'exact_host';
`
};

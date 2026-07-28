import type { SqliteDatabase } from "../sqlite.js";
import type { Migration } from "./types.js";
import { tableExists } from "./legacyTail.js";

/**
 * OSS-003 assignment cutover.  The legacy `work_assignments` row mixed three
 * unrelated authorities.  The new tables deliberately have separate keys and
 * revisions so a responsibility/reviewer change cannot rewrite Host intent.
 */
export const assignmentAuthorityMigrationSql = `
CREATE TABLE IF NOT EXISTS responsibility_records (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('task','block')),
  scope_key TEXT NOT NULL,
  principal_id TEXT,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_by_kind TEXT NOT NULL CHECK(updated_by_kind IN ('human','local_admin','system')),
  updated_by_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, project_id, canvas_id, scope_kind, scope_key),
  CHECK((scope_kind='task' AND length(scope_key) BETWEEN 1 AND 256) OR
        (scope_kind='block' AND instr(scope_key, '#') > 1))
);
CREATE INDEX IF NOT EXISTS idx_responsibility_scope
  ON responsibility_records(workspace_id, project_id, canvas_id, scope_kind, scope_key);

CREATE TABLE IF NOT EXISTS review_assignment_records (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('task','block')),
  scope_key TEXT NOT NULL,
  principal_id TEXT,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_by_kind TEXT NOT NULL CHECK(updated_by_kind IN ('human','local_admin','system')),
  updated_by_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, project_id, canvas_id, scope_kind, scope_key),
  CHECK((scope_kind='task' AND length(scope_key) BETWEEN 1 AND 256) OR
        (scope_kind='block' AND instr(scope_key, '#') > 1))
);
CREATE INDEX IF NOT EXISTS idx_review_assignment_scope
  ON review_assignment_records(workspace_id, project_id, canvas_id, scope_kind, scope_key);

CREATE TABLE IF NOT EXISTS execution_target_records (
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  block_ref TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('unassigned','exact_host','automatic_host')),
  host_id TEXT,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_by_kind TEXT NOT NULL CHECK(updated_by_kind IN ('human','local_admin','system')),
  updated_by_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, project_id, canvas_id, block_ref),
  CHECK((target_kind='exact_host' AND host_id IS NOT NULL) OR
        (target_kind<>'exact_host' AND host_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_execution_target_scope
  ON execution_target_records(workspace_id, project_id, canvas_id, block_ref);

CREATE TABLE IF NOT EXISTS assignment_authority_migrations (
  migration_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  marker TEXT NOT NULL CHECK(marker IN ('pending','cutover_complete','repair_required')),
  status TEXT NOT NULL CHECK(status IN ('pending','completed','repair_required')),
  authoritative_read_version TEXT NOT NULL CHECK(authoritative_read_version IN ('legacy_assignment','oss003_authorities')),
  failure_code TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, project_id),
  CHECK((status='repair_required') = (failure_code IS NOT NULL)),
  CHECK((marker='cutover_complete') = (status='completed' AND authoritative_read_version='oss003_authorities'))
);
`;

function now(): string {
  return new Date().toISOString();
}

function migrationId(workspaceId: string, projectId: string): string {
  return `assignment-authority-${workspaceId}-${projectId}`;
}

type LegacyRow = {
  project_id: string;
  canvas_id: string;
  work_item_kind: string;
  work_item_key: string;
  target_kind: string;
  target_human_principal_id: string | null;
  target_host_id: string | null;
  revision: number;
  updated_by_kind: string;
  updated_by_id: string;
  updated_at: string;
};

/**
 * Backfill is intentionally fail-closed.  A Host target on a Task or an
 * unknown legacy kind makes the project `repair_required`; no new authority is
 * made authoritative and no Host identity is ever mapped to a human.
 */
export function migrateLegacyAssignments(database: SqliteDatabase, projectId?: string): void {
  if (!tableExists(database, "work_assignments")) return;
  const rows: readonly LegacyRow[] = (projectId
    ? database
        .prepare(
          "SELECT * FROM work_assignments WHERE project_id=? ORDER BY project_id,canvas_id,work_item_key"
        )
        .all(projectId)
    : database
        .prepare("SELECT * FROM work_assignments ORDER BY project_id,canvas_id,work_item_key")
        .all()) as LegacyRow[];
  const projects = new Map<string, { workspaceId: string; projectId: string; invalid?: string }>();
  for (const row of rows) {
    const workspace = database
      .prepare(
        "SELECT workspace_id FROM legacy_project_workspace_mappings WHERE legacy_project_id=?"
      )
      .get(row.project_id) as { workspace_id: string } | undefined;
    if (!workspace) throw new Error(`assignment_migration_workspace_unmapped:${row.project_id}`);
    const workspaceId = String(workspace.workspace_id);
    const project = projects.get(row.project_id) ?? { workspaceId, projectId: row.project_id };
    if (
      row.target_kind !== "unassigned" &&
      row.target_kind !== "human" &&
      row.target_kind !== "exact_host" &&
      row.target_kind !== "automatic_host"
    ) {
      project.invalid = "unknown_legacy_assignment_target";
    }
    if (
      (row.target_kind === "exact_host" || row.target_kind === "automatic_host") &&
      row.work_item_kind !== "block"
    ) {
      project.invalid = "legacy_task_host_target_requires_repair";
    }
    projects.set(row.project_id, project);
  }
  const assertSame = (
    table: string,
    keyColumns: readonly string[],
    keyValues: readonly unknown[],
    expected: Record<string, unknown>
  ) => {
    const row = database
      .prepare(`SELECT * FROM ${table} WHERE ${keyColumns.map((key) => `${key}=?`).join(" AND ")}`)
      .get(...keyValues) as Record<string, unknown> | undefined;
    if (!row) return false;
    for (const [key, value] of Object.entries(expected))
      if ((row[key] ?? null) !== (value ?? null))
        throw new Error(`assignment_migration_conflict:${table}`);
    return true;
  };
  const insertResponsibility = (values: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    scopeKind: string;
    scopeKey: string;
    principalId: string | null;
    revision: number;
    updatedByKind: string;
    updatedById: string;
    updatedAt: string;
  }) => {
    const keys = [
      values.workspaceId,
      values.projectId,
      values.canvasId,
      values.scopeKind,
      values.scopeKey
    ];
    if (
      assertSame(
        "responsibility_records",
        ["workspace_id", "project_id", "canvas_id", "scope_kind", "scope_key"],
        keys,
        {
          workspace_id: values.workspaceId,
          project_id: values.projectId,
          canvas_id: values.canvasId,
          scope_kind: values.scopeKind,
          scope_key: values.scopeKey,
          principal_id: values.principalId,
          revision: values.revision,
          updated_by_kind: values.updatedByKind,
          updated_by_id: values.updatedById,
          updated_at: values.updatedAt
        }
      )
    )
      return;
    database
      .prepare(
        `INSERT INTO responsibility_records(workspace_id,project_id,canvas_id,scope_kind,scope_key,principal_id,revision,updated_by_kind,updated_by_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        values.workspaceId,
        values.projectId,
        values.canvasId,
        values.scopeKind,
        values.scopeKey,
        values.principalId,
        values.revision,
        values.updatedByKind,
        values.updatedById,
        values.updatedAt
      );
  };
  const insertExecutionTarget = (values: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    blockRef: string;
    targetKind: string;
    hostId: string | null;
    revision: number;
    updatedByKind: string;
    updatedById: string;
    updatedAt: string;
  }) => {
    const keys = [values.workspaceId, values.projectId, values.canvasId, values.blockRef];
    if (
      assertSame(
        "execution_target_records",
        ["workspace_id", "project_id", "canvas_id", "block_ref"],
        keys,
        {
          workspace_id: values.workspaceId,
          project_id: values.projectId,
          canvas_id: values.canvasId,
          block_ref: values.blockRef,
          target_kind: values.targetKind,
          host_id: values.hostId,
          revision: values.revision,
          updated_by_kind: values.updatedByKind,
          updated_by_id: values.updatedById,
          updated_at: values.updatedAt
        }
      )
    )
      return;
    database
      .prepare(
        `INSERT INTO execution_target_records(workspace_id,project_id,canvas_id,block_ref,target_kind,host_id,revision,updated_by_kind,updated_by_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        values.workspaceId,
        values.projectId,
        values.canvasId,
        values.blockRef,
        values.targetKind,
        values.hostId,
        values.revision,
        values.updatedByKind,
        values.updatedById,
        values.updatedAt
      );
  };
  for (const row of rows) {
    const workspace = database
      .prepare(
        "SELECT workspace_id FROM legacy_project_workspace_mappings WHERE legacy_project_id=?"
      )
      .get(row.project_id) as { workspace_id: string } | undefined;
    if (!workspace) throw new Error(`assignment_migration_workspace_unmapped:${row.project_id}`);
    const invalid = projects.get(row.project_id)?.invalid;
    if (invalid) continue;
    const workspaceId = String(workspace.workspace_id);
    if (row.target_kind === "human") {
      insertResponsibility({
        workspaceId,
        projectId: row.project_id,
        canvasId: row.canvas_id,
        scopeKind: row.work_item_kind,
        scopeKey: row.work_item_key,
        principalId: row.target_human_principal_id,
        revision: row.revision,
        updatedByKind: row.updated_by_kind,
        updatedById: row.updated_by_id,
        updatedAt: row.updated_at
      });
    } else if (row.work_item_kind === "block") {
      insertExecutionTarget({
        workspaceId,
        projectId: row.project_id,
        canvasId: row.canvas_id,
        blockRef: row.work_item_key,
        targetKind: row.target_kind,
        hostId: row.target_kind === "exact_host" ? row.target_host_id : null,
        revision: row.revision,
        updatedByKind: row.updated_by_kind,
        updatedById: row.updated_by_id,
        updatedAt: row.updated_at
      });
      if (row.target_kind === "unassigned") {
        insertResponsibility({
          workspaceId,
          projectId: row.project_id,
          canvasId: row.canvas_id,
          scopeKind: row.work_item_kind,
          scopeKey: row.work_item_key,
          principalId: null,
          revision: row.revision,
          updatedByKind: row.updated_by_kind,
          updatedById: row.updated_by_id,
          updatedAt: row.updated_at
        });
      }
    } else if (row.target_kind === "unassigned") {
      insertResponsibility({
        workspaceId,
        projectId: row.project_id,
        canvasId: row.canvas_id,
        scopeKind: row.work_item_kind,
        scopeKey: row.work_item_key,
        principalId: null,
        revision: row.revision,
        updatedByKind: row.updated_by_kind,
        updatedById: row.updated_by_id,
        updatedAt: row.updated_at
      });
    }
  }
  for (const project of projects.values()) {
    const at = now();
    if (project.invalid) {
      database
        .prepare(
          `INSERT INTO assignment_authority_migrations(migration_id,workspace_id,project_id,marker,status,authoritative_read_version,failure_code,updated_at) VALUES(?,?,?,'repair_required','repair_required','legacy_assignment',?,?) ON CONFLICT(workspace_id,project_id) DO UPDATE SET marker='repair_required',status='repair_required',authoritative_read_version='legacy_assignment',failure_code=excluded.failure_code,updated_at=excluded.updated_at`
        )
        .run(
          migrationId(project.workspaceId, project.projectId),
          project.workspaceId,
          project.projectId,
          project.invalid,
          at
        );
    } else {
      database
        .prepare(
          `INSERT INTO assignment_authority_migrations(migration_id,workspace_id,project_id,marker,status,authoritative_read_version,failure_code,updated_at) VALUES(?,?,?,'cutover_complete','completed','oss003_authorities',NULL,?) ON CONFLICT(workspace_id,project_id) DO UPDATE SET marker='cutover_complete',status='completed',authoritative_read_version='oss003_authorities',failure_code=NULL,updated_at=excluded.updated_at`
        )
        .run(
          migrationId(project.workspaceId, project.projectId),
          project.workspaceId,
          project.projectId,
          at
        );
    }
  }
}

export const assignmentAuthorityMigration: Migration = {
  version: 29,
  sql: assignmentAuthorityMigrationSql,
  after: migrateLegacyAssignments
};

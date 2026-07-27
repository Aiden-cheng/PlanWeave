import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../sqlite.js";
import type { Migration } from "./types.js";

/**
 * The ACL registry is deliberately independent from the runtime filesystem.
 * Migration SQL only creates durable state and backfills rows whose workspace
 * binding is already explicit in the v27 projection.  Trusted project roots
 * are attached later by the composition bootstrap, never guessed here.
 */
export const migration28Sql = `
CREATE TABLE IF NOT EXISTS project_registry (
  project_registry_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  project_id TEXT NOT NULL,
  project_root_internal TEXT,
  visibility TEXT NOT NULL CHECK(visibility IN ('private','shared')),
  owner_human_principal_id TEXT,
  acl_revision INTEGER NOT NULL CHECK(acl_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(workspace_id,project_id),
  UNIQUE(workspace_id,project_registry_id),
  UNIQUE(workspace_id,project_id,project_registry_id),
  FOREIGN KEY(workspace_id,owner_human_principal_id)
    REFERENCES workspace_principals(workspace_id,human_principal_id)
);

CREATE TABLE IF NOT EXISTS canvas_registry (
  canvas_registry_id TEXT PRIMARY KEY,
  project_registry_id TEXT NOT NULL REFERENCES project_registry(project_registry_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  package_dir_internal TEXT,
  visibility TEXT NOT NULL CHECK(visibility IN ('private','shared')),
  owner_human_principal_id TEXT,
  acl_revision INTEGER NOT NULL CHECK(acl_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(workspace_id,project_id,canvas_id),
  UNIQUE(workspace_id,project_id,canvas_id,canvas_registry_id),
  FOREIGN KEY(workspace_id,project_id,project_registry_id)
    REFERENCES project_registry(workspace_id,project_id,project_registry_id),
  FOREIGN KEY(workspace_id,owner_human_principal_id)
    REFERENCES workspace_principals(workspace_id,human_principal_id)
);

CREATE TABLE IF NOT EXISTS project_access_grants (
  grant_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  project_registry_id TEXT NOT NULL REFERENCES project_registry(project_registry_id),
  project_id TEXT NOT NULL,
  canvas_registry_id TEXT REFERENCES canvas_registry(canvas_registry_id),
  canvas_id TEXT,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('project','canvas')),
  human_principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),
  acl_revision INTEGER NOT NULL CHECK(acl_revision >= 0),
  granted_by_kind TEXT NOT NULL CHECK(granted_by_kind IN ('human','local_admin','system')),
  granted_by_id TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK((scope_kind='project') = (canvas_registry_id IS NULL AND canvas_id IS NULL)),
  CHECK((scope_kind='canvas') = (canvas_registry_id IS NOT NULL AND canvas_id IS NOT NULL)),
  FOREIGN KEY(workspace_id,project_id)
    REFERENCES project_registry(workspace_id,project_id),
  FOREIGN KEY(workspace_id,project_id,canvas_id,canvas_registry_id)
    REFERENCES canvas_registry(workspace_id,project_id,canvas_id,canvas_registry_id),
  FOREIGN KEY(workspace_id,human_principal_id)
    REFERENCES workspace_principals(workspace_id,human_principal_id),
  FOREIGN KEY(workspace_id,project_id,project_registry_id)
    REFERENCES project_registry(workspace_id,project_id,project_registry_id)
);

CREATE INDEX IF NOT EXISTS idx_project_access_grants_scope
  ON project_access_grants(workspace_id,project_registry_id,canvas_registry_id,human_principal_id,revoked_at);
CREATE INDEX IF NOT EXISTS idx_project_access_grants_project
  ON project_access_grants(workspace_id,project_id,scope_kind,human_principal_id,revoked_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_access_grants_active_unique
  ON project_access_grants(workspace_id,project_registry_id,human_principal_id)
  WHERE revoked_at IS NULL AND scope_kind='project';
CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_access_grants_active_unique
  ON project_access_grants(workspace_id,canvas_registry_id,human_principal_id)
  WHERE revoked_at IS NULL AND scope_kind='canvas';

CREATE TABLE IF NOT EXISTS acl_registry_migrations (
  migration_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  project_id TEXT NOT NULL,
  canvas_id TEXT,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('legacy_project','trusted_project','trusted_canvas')),
  marker TEXT NOT NULL CHECK(marker IN ('none','project_registered','canvas_registered','path_bound','cutover_complete','migration_failed')),
  status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed','interrupted','repair_required','rolled_back')),
  failure_code TEXT,
  updated_at TEXT NOT NULL,
  CHECK((status IN ('interrupted','repair_required')) = (failure_code IS NOT NULL)),
  CHECK((status='completed') = (marker='cutover_complete'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_acl_registry_migrations_project
  ON acl_registry_migrations(workspace_id,project_id,source_kind)
  WHERE canvas_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_acl_registry_migrations_canvas
  ON acl_registry_migrations(workspace_id,project_id,canvas_id,source_kind)
  WHERE canvas_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS package_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  project_registry_id TEXT NOT NULL REFERENCES project_registry(project_registry_id),
  canvas_registry_id TEXT NOT NULL REFERENCES canvas_registry(canvas_registry_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  digest_manifest_json TEXT NOT NULL CHECK(json_valid(digest_manifest_json)),
  digest_fingerprint TEXT NOT NULL CHECK(length(digest_fingerprint)=64 AND digest_fingerprint NOT GLOB '*[^a-f0-9]*'),
  content_root_internal TEXT NOT NULL,
  creator_kind TEXT NOT NULL CHECK(creator_kind IN ('human','local_admin','system')),
  creator_id TEXT NOT NULL,
  migration_marker TEXT NOT NULL CHECK(migration_marker IN ('none','legacy_package_mapped','canvas_registry_created','snapshot_registered','digest_verified','migration_failed')),
  state TEXT NOT NULL CHECK(state IN ('available','missing','revoked','stale','malformed')),
  acl_revision INTEGER NOT NULL CHECK(acl_revision >= 0),
  project_visibility TEXT NOT NULL CHECK(project_visibility IN ('private','shared')),
  canvas_visibility TEXT NOT NULL CHECK(canvas_visibility IN ('private','shared')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  retention_order INTEGER CHECK(retention_order IS NULL OR retention_order > 0),
  restore_marker TEXT NOT NULL CHECK(restore_marker IN ('none','restore_pending','restore_complete')),
  UNIQUE(canvas_registry_id,source_revision,digest_fingerprint),
  FOREIGN KEY(workspace_id,project_id,canvas_id,canvas_registry_id)
    REFERENCES canvas_registry(workspace_id,project_id,canvas_id,canvas_registry_id),
  FOREIGN KEY(workspace_id,project_id,project_registry_id)
    REFERENCES project_registry(workspace_id,project_id,project_registry_id),
  CHECK((state='revoked') = (revoked_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_package_snapshots_canvas_retention
  ON package_snapshots(canvas_registry_id,state,retention_order,created_at);
`;

export const aclRegistryMigration: Migration = {
  version: 28,
  sql: migration28Sql,
  after: backfillLegacyAclRegistry
};

function deterministicId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
  return `${prefix}-${digest}`;
}

export function projectRegistryIdFor(workspaceId: string, projectId: string): string {
  return deterministicId("registry-project", workspaceId, projectId);
}

export function canvasRegistryIdFor(
  workspaceId: string,
  projectId: string,
  canvasId: string
): string {
  return deterministicId("registry-canvas", workspaceId, projectId, canvasId);
}

export function aclMigrationIdFor(
  sourceKind: "legacy_project" | "trusted_project" | "trusted_canvas",
  workspaceId: string,
  projectId: string,
  canvasId?: string
): string {
  return deterministicId("acl-migration", sourceKind, workspaceId, projectId, canvasId ?? "");
}

function nowIso(): string {
  return new Date().toISOString();
}

function tableExists(database: SqliteDatabase, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  );
}

/** Backfill only project identities that v27 mapped explicitly to a workspace. */
function backfillLegacyAclRegistry(database: SqliteDatabase): void {
  if (!tableExists(database, "legacy_project_workspace_mappings")) return;
  const projectRows = database
    .prepare(
      `SELECT legacy_project_id,workspace_id
       FROM legacy_project_workspace_mappings ORDER BY legacy_project_id`
    )
    .all() as Array<{ legacy_project_id: string; workspace_id: string }>;
  const at = nowIso();
  for (const row of projectRows) {
    const projectRegistryId = projectRegistryIdFor(row.workspace_id, row.legacy_project_id);
    const owner = tableExists(database, "project_memberships")
      ? database
          .prepare(
            `SELECT human_principal_id FROM project_memberships
             WHERE project_id=? AND role='owner' AND revoked_at IS NULL
             ORDER BY membership_id LIMIT 1`
          )
          .get(row.legacy_project_id)?.human_principal_id
      : undefined;
    const existingProject = database
      .prepare(
        "SELECT project_registry_id,workspace_id,project_id,project_root_internal,visibility,owner_human_principal_id,revoked_at FROM project_registry WHERE workspace_id=? AND project_id=?"
      )
      .get(row.workspace_id, row.legacy_project_id) as Record<string, unknown> | undefined;
    if (existingProject) {
      if (
        existingProject.project_registry_id !== projectRegistryId ||
        existingProject.project_root_internal !== null ||
        existingProject.visibility !== "private" ||
        existingProject.owner_human_principal_id !== (owner ? String(owner) : null) ||
        existingProject.revoked_at !== null
      ) {
        throw new Error("acl_registry_legacy_project_conflict");
      }
    } else {
      database
        .prepare(
          `INSERT INTO project_registry(
            project_registry_id,workspace_id,project_id,project_root_internal,visibility,
            owner_human_principal_id,acl_revision,created_at,updated_at,revoked_at
          ) VALUES(?,?,?,NULL,'private',?,0,?,?,NULL)`
        )
        .run(
          projectRegistryId,
          row.workspace_id,
          row.legacy_project_id,
          owner ? String(owner) : null,
          at,
          at
        );
    }
    upsertAclRegistryMigration(database, {
      migrationId: aclMigrationIdFor("legacy_project", row.workspace_id, row.legacy_project_id),
      workspaceId: row.workspace_id,
      projectId: row.legacy_project_id,
      canvasId: null,
      sourceKind: "legacy_project",
      marker: "project_registered",
      status: "pending",
      failureCode: null,
      updatedAt: at
    });
    if (tableExists(database, "project_memberships")) {
      const members = database
        .prepare(
          `SELECT membership_id,human_principal_id,role,created_at,updated_at
         FROM project_memberships WHERE project_id=? AND revoked_at IS NULL ORDER BY membership_id`
        )
        .all(row.legacy_project_id) as Array<Record<string, unknown>>;
      let scopeRevision = 0;
      for (const member of members) {
        if (member.role === "owner") continue;
        scopeRevision += 1;
        if (
          !database
            .prepare(
              "SELECT 1 FROM workspace_principals WHERE workspace_id=? AND human_principal_id=?"
            )
            .get(row.workspace_id, member.human_principal_id)
        ) {
          throw new Error("acl_registry_legacy_principal_missing");
        }
        const grantId = deterministicId(
          "grant",
          row.workspace_id,
          row.legacy_project_id,
          String(member.human_principal_id),
          String(scopeRevision)
        );
        const existingGrant = database
          .prepare(
            "SELECT workspace_id,project_registry_id,project_id,canvas_registry_id,canvas_id,scope_kind,human_principal_id,role,acl_revision,granted_by_kind,granted_by_id,granted_at,revoked_at FROM project_access_grants WHERE grant_id=?"
          )
          .get(grantId) as Record<string, unknown> | undefined;
        const expectedGrant = {
          workspace_id: row.workspace_id,
          project_registry_id: projectRegistryId,
          project_id: row.legacy_project_id,
          canvas_registry_id: null,
          canvas_id: null,
          scope_kind: "project",
          human_principal_id: String(member.human_principal_id),
          role: "editor",
          acl_revision: scopeRevision,
          granted_by_kind: "system",
          granted_by_id: "migration",
          granted_at: String(member.created_at ?? at),
          revoked_at: null
        };
        if (existingGrant) {
          for (const [key, value] of Object.entries(expectedGrant))
            if ((existingGrant[key] ?? null) !== (value ?? null))
              throw new Error("acl_registry_legacy_grant_conflict");
        } else {
          database
            .prepare(
              `INSERT INTO project_access_grants(
              grant_id,workspace_id,project_registry_id,project_id,canvas_registry_id,canvas_id,
              scope_kind,human_principal_id,role,acl_revision,granted_by_kind,granted_by_id,granted_at,revoked_at
            ) VALUES(?,?,?,?,NULL,NULL,'project',?,'editor',?,?,?, ?,NULL)`
            )
            .run(
              grantId,
              row.workspace_id,
              projectRegistryId,
              row.legacy_project_id,
              String(member.human_principal_id),
              scopeRevision,
              "system",
              "migration",
              String(member.created_at ?? at)
            );
        }
      }
      database
        .prepare(
          "UPDATE project_registry SET acl_revision=?,updated_at=? WHERE project_registry_id=?"
        )
        .run(scopeRevision, at, projectRegistryId);
    }
  }
}

export type AclRegistryMigrationState = {
  migrationId: string;
  workspaceId: string;
  projectId: string;
  canvasId: string | null;
  sourceKind: "legacy_project" | "trusted_project" | "trusted_canvas";
  marker:
    | "none"
    | "project_registered"
    | "canvas_registered"
    | "path_bound"
    | "cutover_complete"
    | "migration_failed";
  status:
    | "pending"
    | "in_progress"
    | "completed"
    | "interrupted"
    | "repair_required"
    | "rolled_back";
  failureCode: string | null;
  updatedAt: string;
};

export function readAclRegistryMigration(
  database: SqliteDatabase,
  input: {
    workspaceId: string;
    projectId: string;
    canvasId?: string | null;
    sourceKind: AclRegistryMigrationState["sourceKind"];
  }
): AclRegistryMigrationState | undefined {
  const row = database
    .prepare(
      `SELECT migration_id,workspace_id,project_id,canvas_id,source_kind,marker,status,failure_code,updated_at
       FROM acl_registry_migrations
       WHERE workspace_id=? AND project_id=? AND ((canvas_id IS NULL AND ? IS NULL) OR canvas_id=?) AND source_kind=?`
    )
    .get(
      input.workspaceId,
      input.projectId,
      input.canvasId ?? null,
      input.canvasId ?? null,
      input.sourceKind
    ) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    migrationId: String(row.migration_id),
    workspaceId: String(row.workspace_id),
    projectId: String(row.project_id),
    canvasId: row.canvas_id === null ? null : String(row.canvas_id),
    sourceKind: row.source_kind as AclRegistryMigrationState["sourceKind"],
    marker: row.marker as AclRegistryMigrationState["marker"],
    status: row.status as AclRegistryMigrationState["status"],
    failureCode: row.failure_code === null ? null : String(row.failure_code),
    updatedAt: String(row.updated_at)
  };
}

export function upsertAclRegistryMigration(
  database: SqliteDatabase,
  input: Omit<AclRegistryMigrationState, "updatedAt"> & { updatedAt?: string }
): void {
  const at = input.updatedAt ?? nowIso();
  const prior = readAclRegistryMigration(database, input);
  const byId = database
    .prepare(
      "SELECT migration_id,workspace_id,project_id,canvas_id,source_kind FROM acl_registry_migrations WHERE migration_id=?"
    )
    .get(input.migrationId) as Record<string, unknown> | undefined;
  if (
    byId &&
    (String(byId.workspace_id) !== input.workspaceId ||
      String(byId.project_id) !== input.projectId ||
      (byId.canvas_id === null ? null : String(byId.canvas_id)) !== (input.canvasId ?? null) ||
      String(byId.source_kind) !== input.sourceKind)
  ) {
    throw new Error("acl_registry_migration_conflict");
  }
  if (
    prior &&
    (prior.migrationId !== input.migrationId ||
      prior.workspaceId !== input.workspaceId ||
      prior.projectId !== input.projectId ||
      prior.canvasId !== (input.canvasId ?? null) ||
      prior.sourceKind !== input.sourceKind)
  ) {
    throw new Error("acl_registry_migration_conflict");
  }
  if (prior?.status === "completed") {
    if (input.status !== "completed" || input.marker !== "cutover_complete")
      throw new Error("acl_registry_completed_cutover_immutable");
    return;
  }
  database
    .prepare(
      `INSERT INTO acl_registry_migrations(
        migration_id,workspace_id,project_id,canvas_id,source_kind,marker,status,failure_code,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(migration_id) DO UPDATE SET
        migration_id=excluded.migration_id,marker=excluded.marker,status=excluded.status,
        failure_code=excluded.failure_code,updated_at=excluded.updated_at`
    )
    .run(
      input.migrationId,
      input.workspaceId,
      input.projectId,
      input.canvasId,
      input.sourceKind,
      input.marker,
      input.status,
      input.failureCode,
      at
    );
}

export function retryAclRegistryMigration(
  database: SqliteDatabase,
  input: {
    workspaceId: string;
    projectId: string;
    canvasId?: string | null;
    sourceKind: AclRegistryMigrationState["sourceKind"];
  }
): AclRegistryMigrationState | undefined {
  const prior = readAclRegistryMigration(database, input);
  if (!prior) return undefined;
  if (prior.status === "completed") return prior;
  upsertAclRegistryMigration(database, {
    ...prior,
    marker: prior.marker === "migration_failed" ? "none" : prior.marker,
    status: "pending",
    failureCode: null
  });
  return readAclRegistryMigration(database, input);
}

export function rollbackAclRegistryMigration(
  database: SqliteDatabase,
  input: {
    workspaceId: string;
    projectId: string;
    canvasId?: string | null;
    sourceKind: AclRegistryMigrationState["sourceKind"];
  }
): void {
  const prior = readAclRegistryMigration(database, input);
  if (!prior || prior.status === "completed") return;
  upsertAclRegistryMigration(database, {
    ...prior,
    marker: "none",
    status: "rolled_back",
    failureCode: null
  });
}

export function repairAclRegistryMigration(
  database: SqliteDatabase,
  input: {
    workspaceId: string;
    projectId: string;
    canvasId?: string | null;
    sourceKind: AclRegistryMigrationState["sourceKind"];
  }
): AclRegistryMigrationState | undefined {
  const prior = readAclRegistryMigration(database, input);
  if (!prior) return undefined;
  if (prior.status === "completed") return prior;
  upsertAclRegistryMigration(database, {
    ...prior,
    status: "repair_required",
    failureCode: prior.failureCode ?? "acl_registry_repair_required"
  });
  return readAclRegistryMigration(database, input);
}

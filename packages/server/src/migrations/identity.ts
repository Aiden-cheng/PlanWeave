import { createHash } from "node:crypto";
import type { Migration } from "./types.js";
import type { SqliteDatabase } from "../sqlite.js";
import { tableExists } from "./legacyTail.js";

const migration27Sql = `
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS legacy_project_workspace_mappings (
  legacy_project_id TEXT PRIMARY KEY,
  normalized_legacy_project_identity TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  mapped_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_identity_migrations (
  migration_id TEXT PRIMARY KEY,
  legacy_project_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  from_version INTEGER NOT NULL CHECK(from_version >= 0),
  to_version INTEGER NOT NULL CHECK(to_version = 1),
  step TEXT NOT NULL CHECK(step IN (
    'create_workspace','map_legacy_project','backfill_principals','backfill_memberships',
    'backfill_devices','backfill_hosts','cutover_authoritative_reads','verify_cutover'
  )),
  status TEXT NOT NULL CHECK(status IN (
    'pending','in_progress','completed','interrupted','repair_required','rolled_back'
  )),
  interruption_marker TEXT NOT NULL CHECK(interruption_marker IN (
    'none','workspace_created','mapping_written','principals_backfilled',
    'memberships_backfilled','devices_backfilled','hosts_backfilled',
    'read_cutover_pending','read_cutover_complete','partial_backfill_failed',
    'rollback_complete'
  )),
  authoritative_read_version TEXT NOT NULL CHECK(authoritative_read_version='workspace-identity/v1'),
  failure_code TEXT,
  updated_at TEXT NOT NULL,
  CHECK((status IN ('interrupted','repair_required')) = (failure_code IS NOT NULL)),
  CHECK((status <> 'completed') OR interruption_marker='read_cutover_complete'),
  CHECK((status <> 'rolled_back') OR interruption_marker='rollback_complete')
);

CREATE TABLE IF NOT EXISTS workspace_principals (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  human_principal_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(workspace_id,human_principal_id)
);

CREATE TABLE IF NOT EXISTS workspace_memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  membership_id TEXT NOT NULL,
  human_principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(workspace_id,membership_id),
  FOREIGN KEY(workspace_id,human_principal_id)
    REFERENCES workspace_principals(workspace_id,human_principal_id)
);

CREATE TABLE IF NOT EXISTS workspace_device_sessions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  device_session_id TEXT NOT NULL,
  human_principal_id TEXT NOT NULL,
  credential_sha256 TEXT NOT NULL CHECK(length(credential_sha256)=64 AND credential_sha256 NOT GLOB '*[^a-f0-9]*'),
  issued_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  PRIMARY KEY(workspace_id,device_session_id),
  UNIQUE(credential_sha256),
  FOREIGN KEY(workspace_id,human_principal_id)
    REFERENCES workspace_principals(workspace_id,human_principal_id)
);

CREATE TABLE IF NOT EXISTS workspace_operator_sessions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  operator_session_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  credential_sha256 TEXT NOT NULL CHECK(length(credential_sha256)=64 AND credential_sha256 NOT GLOB '*[^a-f0-9]*'),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY(workspace_id,operator_session_id),
  UNIQUE(credential_sha256)
);

CREATE TABLE IF NOT EXISTS workspace_agent_hosts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  host_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
  capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 128),
  credential_sha256 TEXT NOT NULL CHECK(length(credential_sha256)=64 AND credential_sha256 NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  credential_expires_at TEXT,
  revoked_at TEXT,
  PRIMARY KEY(workspace_id,host_id),
  UNIQUE(workspace_id,credential_sha256)
);

CREATE TABLE IF NOT EXISTS workspace_host_enrollments (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  enrollment_id TEXT NOT NULL,
  enrollment_code_sha256 TEXT NOT NULL CHECK(length(enrollment_code_sha256)=64 AND enrollment_code_sha256 NOT GLOB '*[^a-f0-9]*'),
  credential_expires_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  host_id TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,enrollment_id),
  UNIQUE(workspace_id,enrollment_code_sha256),
  FOREIGN KEY(workspace_id,host_id) REFERENCES workspace_agent_hosts(workspace_id,host_id),
  CHECK((used_at IS NULL) = (host_id IS NULL)),
  CHECK(expires_at < credential_expires_at)
);

CREATE TABLE IF NOT EXISTS workspace_identity_revocations (
  revocation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('human_principal','device_session','operator_session','agent_host','enrollment')),
  subject_id TEXT NOT NULL,
  revoked_at TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_identity_repairs (
  repair_id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('human_principal','device_session','agent_host','enrollment')),
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status='repair_required'),
  reason TEXT NOT NULL CHECK(reason IN (
    'human_principal_requires_reenrollment',
    'device_session_requires_reenrollment',
    'host_requires_reenrollment',
    'enrollment_requires_reenrollment',
    'enrollment_requires_workspace_binding'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(subject_kind,subject_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_identity_repairs_status
  ON workspace_identity_repairs(status,subject_kind,subject_id);
`;

function workspaceIdForLegacyProject(projectId: string): string {
  return `workspace-legacy-${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}`;
}

function migrationIdForLegacyProject(projectId: string): string {
  return `identity-migration-${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function legacyProjectIds(database: SqliteDatabase): string[] {
  const selects: string[] = [];
  if (tableExists(database, "project_memberships")) {
    selects.push("SELECT project_id AS project_id FROM project_memberships");
  }
  if (tableExists(database, "project_invitations")) {
    selects.push("SELECT project_id AS project_id FROM project_invitations");
  }
  if (tableExists(database, "human_device_credentials")) {
    selects.push("SELECT minted_for_project_id AS project_id FROM human_device_credentials");
  }
  if (selects.length === 0) return [];
  const rows = database.prepare(`${selects.join(" UNION ")} ORDER BY project_id`).all();
  return rows.map((row) => String(row.project_id));
}

function ensureWorkspaceForProject(
  database: SqliteDatabase,
  projectId: string,
  at: string
): string {
  const existing = database
    .prepare("SELECT workspace_id FROM legacy_project_workspace_mappings WHERE legacy_project_id=?")
    .get(projectId);
  if (existing) return String(existing.workspace_id);
  const workspaceId = workspaceIdForLegacyProject(projectId);
  database
    .prepare(
      `INSERT OR IGNORE INTO workspaces(workspace_id,display_name,created_at,archived_at)
       VALUES(?,?,?,NULL)`
    )
    .run(workspaceId, `Legacy workspace ${projectId}`, at);
  database
    .prepare(
      `INSERT OR IGNORE INTO legacy_project_workspace_mappings(
        legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at
      ) VALUES(?,?,?,?)`
    )
    .run(projectId, `legacy-project:${projectId}`, workspaceId, at);
  database
    .prepare(
      `INSERT OR IGNORE INTO workspace_identity_migrations(
        migration_id,legacy_project_id,workspace_id,from_version,to_version,step,status,
        interruption_marker,authoritative_read_version,failure_code,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      migrationIdForLegacyProject(projectId),
      projectId,
      workspaceId,
      0,
      1,
      "create_workspace",
      "in_progress",
      "workspace_created",
      "workspace-identity/v1",
      null,
      at
    );
  return workspaceId;
}

function backfillProjectIdentity(
  database: SqliteDatabase,
  projectId: string,
  workspaceId: string,
  at: string
): boolean {
  if (!tableExists(database, "human_principals") || !tableExists(database, "project_memberships")) {
    return false;
  }
  const principals = database
    .prepare(
      `SELECT DISTINCT p.human_principal_id,p.display_name,p.created_at
       FROM human_principals p JOIN project_memberships m
         ON m.human_principal_id=p.human_principal_id WHERE m.project_id=?`
    )
    .all(projectId);
  const conflictingPrincipals = new Set<string>();
  for (const principal of principals) {
    const existingWorkspaces = database
      .prepare(
        "SELECT workspace_id FROM workspace_principals WHERE human_principal_id=? ORDER BY workspace_id"
      )
      .all(principal.human_principal_id)
      .map((row) => String(row.workspace_id));
    if (existingWorkspaces.some((candidate) => candidate !== workspaceId)) {
      conflictingPrincipals.add(String(principal.human_principal_id));
      recordIdentityRepair(
        database,
        "human_principal",
        String(principal.human_principal_id),
        "human_principal_requires_reenrollment",
        at
      );
      continue;
    }
    database
      .prepare(
        `INSERT OR IGNORE INTO workspace_principals(
          workspace_id,human_principal_id,display_name,created_at,revoked_at
        ) VALUES(?,?,?,?,NULL)`
      )
      .run(workspaceId, principal.human_principal_id, principal.display_name, principal.created_at);
  }

  const memberships = database
    .prepare("SELECT * FROM project_memberships WHERE project_id=? ORDER BY membership_id")
    .all(projectId);
  for (const membership of memberships) {
    if (conflictingPrincipals.has(String(membership.human_principal_id))) continue;
    database
      .prepare(
        `INSERT OR IGNORE INTO workspace_memberships(
          workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at
        ) VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(
        workspaceId,
        membership.membership_id,
        membership.human_principal_id,
        membership.role,
        Number(membership.revision ?? 1),
        membership.created_at,
        membership.updated_at,
        membership.revoked_at
      );
  }

  const devices = tableExists(database, "human_device_credentials")
    ? database
        .prepare(
          "SELECT * FROM human_device_credentials WHERE minted_for_project_id=? ORDER BY device_credential_id"
        )
        .all(projectId)
    : [];
  for (const device of devices) {
    if (conflictingPrincipals.has(String(device.human_principal_id))) {
      recordIdentityRepair(
        database,
        "device_session",
        String(device.device_credential_id),
        "device_session_requires_reenrollment",
        at
      );
      continue;
    }
    database
      .prepare(
        `INSERT OR IGNORE INTO workspace_device_sessions(
          workspace_id,device_session_id,human_principal_id,credential_sha256,issued_at,expires_at,revoked_at,last_used_at
        ) VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(
        workspaceId,
        device.device_credential_id,
        device.human_principal_id,
        device.token_sha256,
        device.created_at,
        device.expires_at,
        device.revoked_at,
        device.last_used_at
      );
  }

  if (conflictingPrincipals.size > 0) {
    database
      .prepare(
        `UPDATE workspace_identity_migrations
         SET step='verify_cutover',status='repair_required',interruption_marker='partial_backfill_failed',
             failure_code='human_principal_workspace_conflict',updated_at=? WHERE legacy_project_id=?`
      )
      .run(at, projectId);
    return true;
  }
  const state = database
    .prepare("SELECT status FROM workspace_identity_migrations WHERE legacy_project_id=?")
    .get(projectId);
  if (state?.status !== "repair_required") {
    database
      .prepare(
        `UPDATE workspace_identity_migrations
         SET step='verify_cutover',status='completed',interruption_marker='read_cutover_complete',
             failure_code=NULL,updated_at=? WHERE legacy_project_id=?`
      )
      .run(at, projectId);
  }
  return false;
}

function repairIdForSubject(
  subjectKind: "human_principal" | "device_session" | "agent_host" | "enrollment",
  subjectId: string
): string {
  return `identity-repair-${createHash("sha256")
    .update(`${subjectKind}:${subjectId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function enrollmentSubjectId(codeHash: string): string {
  return `legacy-enrollment-${createHash("sha256").update(codeHash).digest("hex").slice(0, 32)}`;
}

function recordIdentityRepair(
  database: SqliteDatabase,
  subjectKind: "human_principal" | "device_session" | "agent_host" | "enrollment",
  subjectId: string,
  reason:
    | "human_principal_requires_reenrollment"
    | "device_session_requires_reenrollment"
    | "host_requires_reenrollment"
    | "enrollment_requires_reenrollment"
    | "enrollment_requires_workspace_binding",
  at: string
): void {
  database
    .prepare(
      `INSERT INTO workspace_identity_repairs(
        repair_id,subject_kind,subject_id,status,reason,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(subject_kind,subject_id) DO UPDATE SET
        status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at`
    )
    .run(
      repairIdForSubject(subjectKind, subjectId),
      subjectKind,
      subjectId,
      "repair_required",
      reason,
      at,
      at
    );
}

/**
 * Legacy Host credentials have no persisted Workspace binding. Dispatch history
 * is execution history only, so it cannot authorize a Host or enrollment grant.
 * Keep every legacy identity unbound and leave an explicit repair marker for the
 * later Server Admin enrollment/bind flow.
 */
function recordHostIdentityRepairs(database: SqliteDatabase, at: string): void {
  if (tableExists(database, "agent_hosts")) {
    const hosts = database.prepare("SELECT id FROM agent_hosts ORDER BY id").all();
    for (const host of hosts) {
      recordIdentityRepair(
        database,
        "agent_host",
        String(host.id),
        "host_requires_reenrollment",
        at
      );
    }
  }

  if (!tableExists(database, "agent_host_enrollment_grants")) return;
  const grants = database
    .prepare("SELECT code_hash,used_at FROM agent_host_enrollment_grants ORDER BY code_hash")
    .all();
  for (const grant of grants) {
    const subjectId = enrollmentSubjectId(String(grant.code_hash));
    const reason = grant.used_at
      ? "enrollment_requires_reenrollment"
      : "enrollment_requires_workspace_binding";
    recordIdentityRepair(database, "enrollment", subjectId, reason, at);
  }
}

export function backfillWorkspaceIdentity(database: SqliteDatabase): void {
  const at = nowIso();
  for (const projectId of legacyProjectIds(database)) {
    const workspaceId = ensureWorkspaceForProject(database, projectId, at);
    backfillProjectIdentity(database, projectId, workspaceId, at);
  }
  recordHostIdentityRepairs(database, at);
}

export const identityMigrations: readonly Migration[] = [
  { version: 27, sql: migration27Sql, after: backfillWorkspaceIdentity }
];

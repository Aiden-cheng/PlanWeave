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
  workspace_id TEXT REFERENCES workspaces(workspace_id),
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
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_identity_repairs_status
  ON workspace_identity_repairs(status,subject_kind,subject_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_identity_repairs_workspace_subject
  ON workspace_identity_repairs(workspace_id,subject_kind,subject_id)
  WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_identity_repairs_unbound_subject
  ON workspace_identity_repairs(subject_kind,subject_id)
  WHERE workspace_id IS NULL;
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

export type WorkspaceIdentityBackfillOptions = {
  /** Test-only fault injection at a named durable step. */
  failAtStep?:
    | "create_workspace"
    | "map_legacy_project"
    | "backfill_principals"
    | "backfill_memberships"
    | "backfill_devices"
    | "backfill_hosts"
    | "cutover_authoritative_reads"
    | "verify_cutover";
  now?: () => string;
};

export type WorkspaceIdentityRecoveryResult = {
  legacyProjectId: string;
  workspaceId: string;
  status:
    | "pending"
    | "in_progress"
    | "completed"
    | "interrupted"
    | "repair_required"
    | "rolled_back";
  outcome:
    | "retry_idempotent"
    | "resume_from_marker"
    | "repair_required"
    | "rollback_to_legacy"
    | "fail_closed";
};

export class WorkspaceIdentityMigrationFailure extends Error {
  constructor(
    readonly code: string,
    readonly marker:
      | "workspace_created"
      | "mapping_written"
      | "principals_backfilled"
      | "memberships_backfilled"
      | "devices_backfilled"
      | "hosts_backfilled"
      | "read_cutover_pending"
      | "partial_backfill_failed",
    readonly repairRequired = false
  ) {
    super(code);
    this.name = "WorkspaceIdentityMigrationFailure";
  }
}

function stepMarker(
  step: NonNullable<WorkspaceIdentityBackfillOptions["failAtStep"]>
): WorkspaceIdentityMigrationFailure["marker"] {
  switch (step) {
    case "create_workspace":
      return "workspace_created";
    case "map_legacy_project":
      return "workspace_created";
    case "backfill_principals":
      return "mapping_written";
    case "backfill_memberships":
      return "principals_backfilled";
    case "backfill_devices":
      return "memberships_backfilled";
    case "backfill_hosts":
      return "devices_backfilled";
    case "cutover_authoritative_reads":
      return "read_cutover_pending";
    case "verify_cutover":
      return "devices_backfilled";
  }
}

function ensureNoInjectedFailure(
  options: WorkspaceIdentityBackfillOptions,
  step: NonNullable<WorkspaceIdentityBackfillOptions["failAtStep"]>
): void {
  if (options.failAtStep === step) {
    throw new WorkspaceIdentityMigrationFailure(`injected_${step}_failure`, stepMarker(step));
  }
}

function assertEqualRow(
  row: Record<string, unknown>,
  expected: Record<string, unknown>,
  code: string
): void {
  for (const [column, value] of Object.entries(expected)) {
    if ((row[column] ?? null) !== (value ?? null)) {
      throw new WorkspaceIdentityMigrationFailure(code, "partial_backfill_failed", true);
    }
  }
}

function insertOrVerify(
  database: SqliteDatabase,
  selectSql: string,
  insertSql: string,
  keyValues: readonly unknown[],
  insertValues: readonly unknown[],
  expected: Record<string, unknown>,
  conflictCode: string
): void {
  const existing = database.prepare(selectSql).get(...keyValues);
  if (existing) {
    assertEqualRow(existing, expected, conflictCode);
    return;
  }
  try {
    database.prepare(insertSql).run(...insertValues);
  } catch (error) {
    const row = database.prepare(selectSql).get(...keyValues);
    if (row) {
      assertEqualRow(row, expected, conflictCode);
      return;
    }
    throw error;
  }
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
  const workspaceId = workspaceIdForLegacyProject(projectId);
  const existing = database
    .prepare(
      `SELECT legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at
       FROM legacy_project_workspace_mappings WHERE legacy_project_id=?`
    )
    .get(projectId);
  if (existing) {
    assertEqualRow(
      existing,
      {
        legacy_project_id: projectId,
        normalized_legacy_project_identity: `legacy-project:${projectId}`,
        workspace_id: workspaceId
      },
      "legacy_project_workspace_mapping_conflict"
    );
  } else {
    insertOrVerify(
      database,
      "SELECT workspace_id,display_name,created_at,archived_at FROM workspaces WHERE workspace_id=?",
      "INSERT INTO workspaces(workspace_id,display_name,created_at,archived_at) VALUES(?,?,?,NULL)",
      [workspaceId],
      [workspaceId, `Legacy workspace ${projectId}`, at],
      {
        workspace_id: workspaceId,
        display_name: `Legacy workspace ${projectId}`,
        archived_at: null
      },
      "workspace_projection_conflict"
    );
    database
      .prepare(
        `INSERT INTO legacy_project_workspace_mappings(
          legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at
        ) VALUES(?,?,?,?)`
      )
      .run(projectId, `legacy-project:${projectId}`, workspaceId, at);
  }

  const state = database
    .prepare(
      "SELECT migration_id,legacy_project_id,workspace_id,from_version,to_version,authoritative_read_version FROM workspace_identity_migrations WHERE legacy_project_id=?"
    )
    .get(projectId);
  if (state) {
    assertEqualRow(
      state,
      {
        migration_id: migrationIdForLegacyProject(projectId),
        legacy_project_id: projectId,
        workspace_id: workspaceId,
        from_version: 0,
        to_version: 1,
        authoritative_read_version: "workspace-identity/v1"
      },
      "workspace_identity_migration_conflict"
    );
  } else {
    database
      .prepare(
        `INSERT INTO workspace_identity_migrations(
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
  }
  return workspaceId;
}

function updateMigrationStep(
  database: SqliteDatabase,
  projectId: string,
  step:
    | "create_workspace"
    | "map_legacy_project"
    | "backfill_principals"
    | "backfill_memberships"
    | "backfill_devices"
    | "backfill_hosts"
    | "cutover_authoritative_reads"
    | "verify_cutover",
  marker:
    | "workspace_created"
    | "mapping_written"
    | "principals_backfilled"
    | "memberships_backfilled"
    | "devices_backfilled"
    | "hosts_backfilled"
    | "read_cutover_pending"
    | "read_cutover_complete",
  at: string
): void {
  database
    .prepare(
      `UPDATE workspace_identity_migrations
     SET step=?,status='in_progress',interruption_marker=?,failure_code=NULL,updated_at=?
     WHERE legacy_project_id=?`
    )
    .run(step, marker, at, projectId);
}

export function recordMigrationFailure(
  database: SqliteDatabase,
  projectId: string,
  failure: WorkspaceIdentityMigrationFailure,
  at: string
): void {
  database
    .prepare(
      `UPDATE workspace_identity_migrations
     SET step='verify_cutover',status=?,interruption_marker=?,failure_code=?,updated_at=?
     WHERE legacy_project_id=?`
    )
    .run(
      failure.repairRequired ? "repair_required" : "interrupted",
      failure.marker,
      failure.code,
      at,
      projectId
    );
}

export function backfillProjectIdentity(
  database: SqliteDatabase,
  projectId: string,
  workspaceId: string,
  at: string,
  options: WorkspaceIdentityBackfillOptions
): void {
  const memberships = tableExists(database, "project_memberships")
    ? database
        .prepare("SELECT * FROM project_memberships WHERE project_id=? ORDER BY membership_id")
        .all(projectId)
    : [];
  const principals =
    tableExists(database, "human_principals") && memberships.length > 0
      ? database
          .prepare(
            `SELECT DISTINCT p.human_principal_id,p.display_name,p.created_at
         FROM human_principals p JOIN project_memberships m
           ON m.human_principal_id=p.human_principal_id WHERE m.project_id=?`
          )
          .all(projectId)
      : [];
  updateMigrationStep(database, projectId, "backfill_principals", "mapping_written", at);
  ensureNoInjectedFailure(options, "backfill_principals");
  const conflictingPrincipals = new Set<string>();
  let unresolvedSourceIdentity = false;
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
        at,
        workspaceId
      );
      continue;
    }
    insertOrVerify(
      database,
      "SELECT workspace_id,human_principal_id,display_name,created_at,revoked_at FROM workspace_principals WHERE workspace_id=? AND human_principal_id=?",
      `INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES(?,?,?,?,NULL)`,
      [workspaceId, principal.human_principal_id],
      [workspaceId, principal.human_principal_id, principal.display_name, principal.created_at],
      {
        workspace_id: workspaceId,
        human_principal_id: principal.human_principal_id,
        display_name: principal.display_name,
        created_at: principal.created_at,
        revoked_at: null
      },
      "workspace_principal_projection_conflict"
    );
  }
  updateMigrationStep(database, projectId, "backfill_principals", "principals_backfilled", at);

  updateMigrationStep(database, projectId, "backfill_memberships", "principals_backfilled", at);
  ensureNoInjectedFailure(options, "backfill_memberships");
  for (const membership of memberships) {
    if (conflictingPrincipals.has(String(membership.human_principal_id))) continue;
    if (
      !principals.some(
        (principal) =>
          String(principal.human_principal_id) === String(membership.human_principal_id)
      )
    ) {
      unresolvedSourceIdentity = true;
      continue;
    }
    insertOrVerify(
      database,
      "SELECT workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at FROM workspace_memberships WHERE workspace_id=? AND membership_id=?",
      `INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES(?,?,?,?,?,?,?,?)`,
      [workspaceId, membership.membership_id],
      [
        workspaceId,
        membership.membership_id,
        membership.human_principal_id,
        membership.role,
        Number(membership.revision ?? 1),
        membership.created_at,
        membership.updated_at,
        membership.revoked_at
      ],
      {
        workspace_id: workspaceId,
        membership_id: membership.membership_id,
        human_principal_id: membership.human_principal_id,
        role: membership.role,
        revision: Number(membership.revision ?? 1),
        created_at: membership.created_at,
        updated_at: membership.updated_at,
        revoked_at: membership.revoked_at
      },
      "workspace_membership_projection_conflict"
    );
  }
  updateMigrationStep(database, projectId, "backfill_memberships", "memberships_backfilled", at);

  updateMigrationStep(database, projectId, "backfill_devices", "memberships_backfilled", at);
  ensureNoInjectedFailure(options, "backfill_devices");
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
        at,
        workspaceId
      );
      continue;
    }
    if (
      !principals.some(
        (principal) => String(principal.human_principal_id) === String(device.human_principal_id)
      )
    ) {
      unresolvedSourceIdentity = true;
      continue;
    }
    const credentialOwner = database
      .prepare(
        "SELECT workspace_id,device_session_id FROM workspace_device_sessions WHERE credential_sha256=?"
      )
      .get(device.token_sha256);
    if (credentialOwner && String(credentialOwner.workspace_id) !== workspaceId) {
      recordIdentityRepair(
        database,
        "device_session",
        String(device.device_credential_id),
        "device_session_requires_reenrollment",
        at,
        workspaceId
      );
      throw new WorkspaceIdentityMigrationFailure(
        "device_credential_workspace_conflict",
        "partial_backfill_failed",
        true
      );
    }
    insertOrVerify(
      database,
      "SELECT workspace_id,device_session_id,human_principal_id,credential_sha256,issued_at,expires_at,revoked_at,last_used_at FROM workspace_device_sessions WHERE workspace_id=? AND device_session_id=?",
      `INSERT INTO workspace_device_sessions(workspace_id,device_session_id,human_principal_id,credential_sha256,issued_at,expires_at,revoked_at,last_used_at) VALUES(?,?,?,?,?,?,?,?)`,
      [workspaceId, device.device_credential_id],
      [
        workspaceId,
        device.device_credential_id,
        device.human_principal_id,
        device.token_sha256,
        device.created_at,
        device.expires_at,
        device.revoked_at,
        device.last_used_at
      ],
      {
        workspace_id: workspaceId,
        device_session_id: device.device_credential_id,
        human_principal_id: device.human_principal_id,
        credential_sha256: device.token_sha256,
        issued_at: device.created_at,
        expires_at: device.expires_at,
        revoked_at: device.revoked_at,
        last_used_at: device.last_used_at
      },
      "workspace_device_projection_conflict"
    );
  }
  updateMigrationStep(database, projectId, "backfill_devices", "devices_backfilled", at);

  if (conflictingPrincipals.size > 0) {
    throw new WorkspaceIdentityMigrationFailure(
      "human_principal_workspace_conflict",
      "partial_backfill_failed",
      true
    );
  }
  if (unresolvedSourceIdentity) {
    throw new WorkspaceIdentityMigrationFailure(
      "identity_projection_parity_mismatch",
      "partial_backfill_failed",
      true
    );
  }

  updateMigrationStep(database, projectId, "verify_cutover", "devices_backfilled", at);
  ensureNoInjectedFailure(options, "verify_cutover");
  assertProjectParity(database, projectId, workspaceId);
  updateMigrationStep(
    database,
    projectId,
    "cutover_authoritative_reads",
    "read_cutover_pending",
    at
  );
  ensureNoInjectedFailure(options, "cutover_authoritative_reads");
  updateMigrationStep(database, projectId, "verify_cutover", "read_cutover_complete", at);
  database
    .prepare(
      `UPDATE workspace_identity_migrations SET status='completed',failure_code=NULL,updated_at=? WHERE legacy_project_id=?`
    )
    .run(at, projectId);
}

function repairIdForSubject(
  subjectKind: "human_principal" | "device_session" | "agent_host" | "enrollment",
  subjectId: string,
  workspaceId: string | null = null
): string {
  const identity =
    workspaceId === null
      ? `${subjectKind}:${subjectId}`
      : `${workspaceId}:${subjectKind}:${subjectId}`;
  return `identity-repair-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
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
  at: string,
  workspaceId: string | null = null
): void {
  const existing =
    workspaceId === null
      ? database
          .prepare(
            "SELECT repair_id,workspace_id,subject_kind,subject_id,status,reason FROM workspace_identity_repairs WHERE workspace_id IS NULL AND subject_kind=? AND subject_id=?"
          )
          .get(subjectKind, subjectId)
      : database
          .prepare(
            "SELECT repair_id,workspace_id,subject_kind,subject_id,status,reason FROM workspace_identity_repairs WHERE workspace_id=? AND subject_kind=? AND subject_id=?"
          )
          .get(workspaceId, subjectKind, subjectId);
  if (existing) {
    assertEqualRow(
      existing,
      {
        repair_id: repairIdForSubject(subjectKind, subjectId, workspaceId),
        workspace_id: workspaceId,
        subject_kind: subjectKind,
        subject_id: subjectId,
        status: "repair_required"
      },
      "workspace_identity_repair_conflict"
    );
    if (existing.reason !== reason) {
      database
        .prepare("UPDATE workspace_identity_repairs SET reason=?,updated_at=? WHERE repair_id=?")
        .run(reason, at, existing.repair_id);
    }
    return;
  }
  database
    .prepare(
      `INSERT INTO workspace_identity_repairs(
      repair_id,workspace_id,subject_kind,subject_id,status,reason,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?)`
    )
    .run(
      repairIdForSubject(subjectKind, subjectId, workspaceId),
      workspaceId,
      subjectKind,
      subjectId,
      "repair_required",
      reason,
      at,
      at
    );
}

function assertProjectParity(
  database: SqliteDatabase,
  projectId: string,
  workspaceId: string
): void {
  const sourceMemberships = tableExists(database, "project_memberships")
    ? database
        .prepare("SELECT * FROM project_memberships WHERE project_id=? ORDER BY membership_id")
        .all(projectId)
    : [];
  const sourcePrincipals =
    tableExists(database, "human_principals") && sourceMemberships.length > 0
      ? database
          .prepare(
            `SELECT DISTINCT p.human_principal_id,p.display_name,p.created_at
         FROM human_principals p JOIN project_memberships m
           ON m.human_principal_id=p.human_principal_id WHERE m.project_id=? ORDER BY p.human_principal_id`
          )
          .all(projectId)
      : [];
  const sourceDevices = tableExists(database, "human_device_credentials")
    ? database
        .prepare(
          "SELECT * FROM human_device_credentials WHERE minted_for_project_id=? ORDER BY device_credential_id"
        )
        .all(projectId)
    : [];
  const projectedPrincipalCount = database
    .prepare("SELECT COUNT(*) AS count FROM workspace_principals WHERE workspace_id=?")
    .get(workspaceId);
  const projectedMembershipCount = database
    .prepare(
      "SELECT COUNT(*) AS count FROM workspace_memberships WHERE workspace_id=? AND membership_id IN (SELECT membership_id FROM project_memberships WHERE project_id=?)"
    )
    .get(workspaceId, projectId);
  const projectedDeviceCount = database
    .prepare(
      "SELECT COUNT(*) AS count FROM workspace_device_sessions WHERE workspace_id=? AND device_session_id IN (SELECT device_credential_id FROM human_device_credentials WHERE minted_for_project_id=?)"
    )
    .get(workspaceId, projectId);
  if (
    Number(projectedPrincipalCount?.count ?? 0) !== sourcePrincipals.length ||
    Number(projectedMembershipCount?.count ?? 0) !== sourceMemberships.length ||
    Number(projectedDeviceCount?.count ?? 0) !== sourceDevices.length
  ) {
    throw new WorkspaceIdentityMigrationFailure(
      "identity_projection_parity_mismatch",
      "partial_backfill_failed",
      true
    );
  }
  for (const principal of sourcePrincipals) {
    const row = database
      .prepare(
        "SELECT display_name,created_at,revoked_at FROM workspace_principals WHERE workspace_id=? AND human_principal_id=?"
      )
      .get(workspaceId, principal.human_principal_id);
    if (!row)
      throw new WorkspaceIdentityMigrationFailure(
        "identity_projection_parity_mismatch",
        "partial_backfill_failed",
        true
      );
    assertEqualRow(
      row,
      { display_name: principal.display_name, created_at: principal.created_at, revoked_at: null },
      "identity_projection_parity_mismatch"
    );
  }
  for (const membership of sourceMemberships) {
    const row = database
      .prepare(
        "SELECT human_principal_id,role,revision,created_at,updated_at,revoked_at FROM workspace_memberships WHERE workspace_id=? AND membership_id=?"
      )
      .get(workspaceId, membership.membership_id);
    if (!row)
      throw new WorkspaceIdentityMigrationFailure(
        "identity_projection_parity_mismatch",
        "partial_backfill_failed",
        true
      );
    assertEqualRow(
      row,
      {
        human_principal_id: membership.human_principal_id,
        role: membership.role,
        revision: Number(membership.revision ?? 1),
        created_at: membership.created_at,
        updated_at: membership.updated_at,
        revoked_at: membership.revoked_at
      },
      "identity_projection_parity_mismatch"
    );
  }
  for (const device of sourceDevices) {
    const row = database
      .prepare(
        "SELECT human_principal_id,credential_sha256,issued_at,expires_at,revoked_at,last_used_at FROM workspace_device_sessions WHERE workspace_id=? AND device_session_id=?"
      )
      .get(workspaceId, device.device_credential_id);
    if (!row)
      throw new WorkspaceIdentityMigrationFailure(
        "identity_projection_parity_mismatch",
        "partial_backfill_failed",
        true
      );
    assertEqualRow(
      row,
      {
        human_principal_id: device.human_principal_id,
        credential_sha256: device.token_sha256,
        issued_at: device.created_at,
        expires_at: device.expires_at,
        revoked_at: device.revoked_at,
        last_used_at: device.last_used_at
      },
      "identity_projection_parity_mismatch"
    );
  }
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
  runWorkspaceIdentityBackfill(database, {});
}

function runWorkspaceIdentityBackfill(
  database: SqliteDatabase,
  options: WorkspaceIdentityBackfillOptions
): void {
  const at = options.now?.() ?? nowIso();
  for (const projectId of legacyProjectIds(database)) {
    let workspaceId: string | undefined;
    try {
      workspaceId = ensureWorkspaceForProject(database, projectId, at);
      updateMigrationStep(database, projectId, "create_workspace", "workspace_created", at);
      ensureNoInjectedFailure(options, "create_workspace");
      updateMigrationStep(database, projectId, "map_legacy_project", "mapping_written", at);
      ensureNoInjectedFailure(options, "map_legacy_project");
      backfillProjectIdentity(database, projectId, workspaceId, at, options);
    } catch (error) {
      if (!(error instanceof WorkspaceIdentityMigrationFailure)) throw error;
      if (!workspaceId) throw error;
      recordMigrationFailure(database, projectId, error, at);
    }
  }
  recordHostIdentityRepairs(database, at);
}

export const identityMigrations: readonly Migration[] = [
  { version: 27, sql: migration27Sql, after: backfillWorkspaceIdentity }
];

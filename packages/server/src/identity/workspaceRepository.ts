import { createHash } from "node:crypto";
import type { SqliteDatabase } from "../sqlite.js";

export type WorkspaceIdentityReadState = {
  workspaceId: string;
  status: "pending" | "in_progress" | "completed" | "interrupted" | "repair_required" | "rolled_back";
  interruptionMarker: string;
  failureCode: string | null;
};

type LegacyHostRow = Record<string, unknown> & {
  id: string;
  display_name: string;
  capabilities_json: string;
  capacity: number;
  credential_hash: string;
  created_at: string;
  last_seen_at: string | null;
  credential_expires_at: string | null;
  revoked_at: string | null;
};

type LegacyEnrollmentRow = Record<string, unknown> & {
  code_hash: string;
  expires_at: string;
  credential_expires_at: string;
  created_at: string;
  revoked_at: string | null;
  used_at: string | null;
  host_id: string | null;
};

function workspaceIdForLegacyProject(projectId: string): string {
  return `workspace-legacy-${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}`;
}

function migrationIdForLegacyProject(projectId: string): string {
  return `identity-migration-${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Server-owned workspace identity projection and authority boundary.
 * Migrations create/backfill these tables; runtime writes use this store only.
 */
export class WorkspaceIdentityRepository {
  constructor(private readonly database: SqliteDatabase) {}

  workspaceForLegacyProject(projectId: string): string | undefined {
    const row = this.database
      .prepare(
        "SELECT workspace_id FROM legacy_project_workspace_mappings WHERE legacy_project_id=?"
      )
      .get(projectId);
    return row ? String(row.workspace_id) : undefined;
  }

  /**
   * Create an explicit project-to-workspace binding for a new project. Existing
   * legacy mappings are never inferred from another workspace or host row.
   */
  ensureWorkspaceForLegacyProject(projectId: string): string {
    const existing = this.workspaceForLegacyProject(projectId);
    if (existing) return existing;

    const workspaceId = workspaceIdForLegacyProject(projectId);
    const at = nowIso();
    this.database
      .prepare(
        `INSERT OR IGNORE INTO workspaces(workspace_id,display_name,created_at,archived_at)
         VALUES(?,?,?,NULL)`
      )
      .run(workspaceId, `Legacy workspace ${projectId}`, at);
    this.database
      .prepare(
        `INSERT OR IGNORE INTO legacy_project_workspace_mappings(
          legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at
        ) VALUES(?,?,?,?)`
      )
      .run(projectId, `legacy-project:${projectId}`, workspaceId, at);
    this.database
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
        "verify_cutover",
        "completed",
        "read_cutover_complete",
        "workspace-identity/v1",
        null,
        at
      );
    return workspaceId;
  }

  getReadState(workspaceId: string): WorkspaceIdentityReadState | undefined {
    const row = this.database
      .prepare(
        `SELECT workspace_id,status,interruption_marker,failure_code
         FROM workspace_identity_migrations WHERE workspace_id=? ORDER BY updated_at DESC LIMIT 1`
      )
      .get(workspaceId);
    return row
      ? {
          workspaceId: String(row.workspace_id),
          status: row.status as WorkspaceIdentityReadState["status"],
          interruptionMarker: String(row.interruption_marker),
          failureCode: row.failure_code === null ? null : String(row.failure_code)
        }
      : undefined;
  }

  assertReadCutover(workspaceId: string): void {
    const state = this.getReadState(workspaceId);
    if (!state || state.status !== "completed" || state.interruptionMarker !== "read_cutover_complete") {
      throw new Error("workspace_identity_read_cutover_incomplete");
    }
  }

  /** Bind a legacy Host to one explicit workspace. No workspace-count inference is permitted. */
  bindHostToWorkspace(hostId: string, workspaceId: string): void {
    this.assertWorkspace(workspaceId);
    const host = this.database.prepare("SELECT * FROM agent_hosts WHERE id=?").get(hostId) as
      | LegacyHostRow
      | undefined;
    if (!host) throw new Error("agent_host_not_found");
    this.writeHostProjection(workspaceId, host);
  }

  /** Refresh only workspace bindings that already exist for this Host. */
  synchronizeHost(hostId: string): void {
    const host = this.database.prepare("SELECT * FROM agent_hosts WHERE id=?").get(hostId) as
      | LegacyHostRow
      | undefined;
    if (!host) return;
    const bindings = this.database
      .prepare("SELECT workspace_id FROM workspace_agent_hosts WHERE host_id=? ORDER BY workspace_id")
      .all(hostId);
    for (const binding of bindings) this.writeHostProjection(String(binding.workspace_id), host);
  }

  /**
   * Authenticate only an explicitly bound Host. Without workspaceId exactly one
   * persisted binding is required; zero or ambiguous bindings fail closed.
   */
  hostUsable(hostId: string, now: Date, workspaceId?: string): boolean {
    const rows = workspaceId
      ? this.database
          .prepare(
            `SELECT workspace_id,revoked_at,credential_expires_at
             FROM workspace_agent_hosts WHERE host_id=? AND workspace_id=?`
          )
          .all(hostId, workspaceId)
      : this.database
          .prepare(
            `SELECT workspace_id,revoked_at,credential_expires_at
             FROM workspace_agent_hosts WHERE host_id=? ORDER BY workspace_id`
          )
          .all(hostId);
    if (rows.length !== 1) return false;
    const row = rows[0];
    const boundWorkspaceId = String(row.workspace_id);
    const state = this.getReadState(boundWorkspaceId);
    if (!state || state.status !== "completed" || state.interruptionMarker !== "read_cutover_complete") {
      return false;
    }
    if (row.revoked_at !== null) return false;
    return row.credential_expires_at === null || Date.parse(String(row.credential_expires_at)) > now.getTime();
  }

  /** Bind an enrollment grant to a workspace, preserving its original created_at. */
  bindEnrollmentToWorkspace(enrollmentCodeSha256: string, workspaceId: string): void {
    this.assertWorkspace(workspaceId);
    const grant = this.database
      .prepare("SELECT * FROM agent_host_enrollment_grants WHERE code_hash=?")
      .get(enrollmentCodeSha256) as LegacyEnrollmentRow | undefined;
    if (!grant) throw new Error("host_enrollment_grant_not_found");
    this.writeEnrollmentProjection(workspaceId, grant);
  }

  /** Refresh already-bound enrollment grants after legacy grant state changes. */
  synchronizeEnrollment(enrollmentCodeSha256: string): void {
    const grant = this.database
      .prepare("SELECT * FROM agent_host_enrollment_grants WHERE code_hash=?")
      .get(enrollmentCodeSha256) as LegacyEnrollmentRow | undefined;
    if (!grant) return;
    const bindings = this.database
      .prepare(
        `SELECT workspace_id FROM workspace_host_enrollments
         WHERE enrollment_code_sha256=? ORDER BY workspace_id`
      )
      .all(enrollmentCodeSha256);
    for (const binding of bindings) this.writeEnrollmentProjection(String(binding.workspace_id), grant);
  }

  private assertWorkspace(workspaceId: string): void {
    const workspace = this.database
      .prepare("SELECT workspace_id FROM workspaces WHERE workspace_id=?")
      .get(workspaceId);
    if (!workspace) throw new Error("workspace_not_found");
  }

  private writeHostProjection(workspaceId: string, host: LegacyHostRow): void {
    this.assertWorkspace(workspaceId);
    this.database
      .prepare(
        `INSERT INTO workspace_agent_hosts(
          workspace_id,host_id,display_name,capabilities_json,capacity,credential_sha256,
          created_at,last_seen_at,credential_expires_at,revoked_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id,host_id) DO UPDATE SET
          display_name=excluded.display_name,capabilities_json=excluded.capabilities_json,
          capacity=excluded.capacity,credential_sha256=excluded.credential_sha256,
          last_seen_at=excluded.last_seen_at,credential_expires_at=excluded.credential_expires_at,
          revoked_at=excluded.revoked_at`
      )
      .run(
        workspaceId,
        host.id,
        host.display_name,
        host.capabilities_json,
        Number(host.capacity),
        host.credential_hash,
        host.created_at,
        host.last_seen_at,
        host.credential_expires_at,
        host.revoked_at
      );
  }

  private writeEnrollmentProjection(workspaceId: string, grant: LegacyEnrollmentRow): void {
    const hostId = grant.host_id
      ? this.database
          .prepare(
            "SELECT host_id FROM workspace_agent_hosts WHERE workspace_id=? AND host_id=?"
          )
          .get(workspaceId, grant.host_id)
      : undefined;
    if (grant.used_at && !hostId) throw new Error("workspace_host_binding_required");
    this.database
      .prepare(
        `INSERT INTO workspace_host_enrollments(
          workspace_id,enrollment_id,enrollment_code_sha256,credential_expires_at,expires_at,
          used_at,host_id,revoked_at,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace_id,enrollment_id) DO UPDATE SET
          credential_expires_at=excluded.credential_expires_at,expires_at=excluded.expires_at,
          used_at=excluded.used_at,host_id=excluded.host_id,revoked_at=excluded.revoked_at`
      )
      .run(
        workspaceId,
        `enrollment-${grant.code_hash.slice(0, 32)}`,
        grant.code_hash,
        grant.credential_expires_at,
        grant.expires_at,
        grant.used_at,
        hostId ? grant.host_id : null,
        grant.revoked_at,
        grant.created_at
      );
  }
}

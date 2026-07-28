import { createHash } from "node:crypto";
import {
  agentHostIdentityViewSchema,
  deviceSessionIdSchema,
  humanDisplayNameSchema,
  humanDeviceTokenSchema,
  humanPrincipalIdSchema,
  identityMigrationStateSchema,
  workspaceIdentityViewSchema,
  workspaceIdSchema,
  workspaceHumanPrincipalViewSchema,
  workspaceMembershipViewSchema,
  workspacePickerItemSchema,
  type AgentHostIdentityView,
  type DeviceSessionId,
  type WorkspaceId,
  type WorkspaceIdentityView,
  type WorkspacePickerItem
} from "@planweave-ai/collaboration-contracts";
import { hashHumanToken } from "./crypto.js";
import type { SqliteDatabase } from "../sqlite.js";

export type WorkspaceIdentityReadState = {
  workspaceId: string;
  status:
    | "pending"
    | "in_progress"
    | "completed"
    | "interrupted"
    | "repair_required"
    | "rolled_back";
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

  listWorkspaceIds(): string[] {
    return this.database
      .prepare("SELECT workspace_id FROM workspaces ORDER BY workspace_id")
      .all()
      .map((row) => workspaceIdSchema.parse(String(row.workspace_id)));
  }

  workspaceExists(workspaceId: string): boolean {
    const parsed = workspaceIdSchema.parse(workspaceId);
    return Boolean(
      this.database.prepare("SELECT 1 FROM workspaces WHERE workspace_id=?").get(parsed)
    );
  }

  workspaceView(workspaceId: string): WorkspaceIdentityView {
    const parsed = workspaceIdSchema.parse(workspaceId);
    const row = this.database
      .prepare(
        "SELECT workspace_id,display_name,created_at,archived_at FROM workspaces WHERE workspace_id=?"
      )
      .get(parsed) as
      | {
          workspace_id: string;
          display_name: string;
          created_at: string;
          archived_at: string | null;
        }
      | undefined;
    if (!row) throw new Error("workspace_not_found");
    this.assertReadCutover(parsed);
    return workspaceIdentityViewSchema.parse({
      schemaVersion: "workspace-identity/v1",
      workspaceId: row.workspace_id,
      displayName: row.display_name,
      createdAt: row.created_at,
      archivedAt: row.archived_at
    });
  }

  migrationStateView(workspaceId: string) {
    const parsed = workspaceIdSchema.parse(workspaceId);
    const row = this.database
      .prepare(
        `SELECT migration_id,legacy_project_id,workspace_id,from_version,to_version,step,status,
                interruption_marker,authoritative_read_version,failure_code,updated_at
         FROM workspace_identity_migrations
         WHERE workspace_id=? ORDER BY updated_at DESC LIMIT 1`
      )
      .get(parsed) as Record<string, unknown> | undefined;
    if (!row) throw new Error("workspace_identity_migration_not_found");
    return identityMigrationStateSchema.parse({
      schemaVersion: "workspace-identity-migration/v1",
      migrationId: row.migration_id,
      legacyProjectId: row.legacy_project_id,
      workspaceId: row.workspace_id,
      fromVersion: Number(row.from_version),
      toVersion: Number(row.to_version),
      step: row.step,
      status: row.status,
      interruptionMarker: row.interruption_marker,
      authoritativeReadVersion: row.authoritative_read_version,
      failureCode: row.failure_code,
      updatedAt: row.updated_at
    });
  }

  listPrincipalViews(workspaceId: string) {
    const parsed = workspaceIdSchema.parse(workspaceId);
    this.assertReadCutover(parsed);
    return this.database
      .prepare(
        `SELECT workspace_id,human_principal_id,display_name,created_at,revoked_at
         FROM workspace_principals WHERE workspace_id=? ORDER BY human_principal_id`
      )
      .all(parsed)
      .map((row) =>
        workspaceHumanPrincipalViewSchema.parse({
          schemaVersion: "workspace-identity/v1",
          workspaceId: row.workspace_id,
          humanPrincipalId: row.human_principal_id,
          displayName: row.display_name,
          createdAt: row.created_at,
          revokedAt: row.revoked_at
        })
      );
  }

  listMembershipViews(workspaceId: string) {
    const parsed = workspaceIdSchema.parse(workspaceId);
    this.assertReadCutover(parsed);
    return this.database
      .prepare(
        `SELECT m.workspace_id,m.membership_id,m.human_principal_id,p.display_name,m.role,
                m.revision,m.created_at,m.updated_at,m.revoked_at
         FROM workspace_memberships m
         JOIN workspace_principals p
           ON p.workspace_id=m.workspace_id AND p.human_principal_id=m.human_principal_id
         WHERE m.workspace_id=? ORDER BY m.membership_id`
      )
      .all(parsed)
      .map((row) =>
        workspaceMembershipViewSchema.parse({
          schemaVersion: "workspace-identity/v1",
          workspaceId: row.workspace_id,
          membershipId: row.membership_id,
          humanPrincipalId: row.human_principal_id,
          displayName: row.display_name,
          role: row.role,
          revision: Number(row.revision),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          revokedAt: row.revoked_at
        })
      );
  }

  workspaceForHost(hostId: string): string | undefined {
    const rows = this.database
      .prepare(
        "SELECT workspace_id FROM workspace_agent_hosts WHERE host_id=? ORDER BY workspace_id"
      )
      .all(hostId);
    if (rows.length !== 1) return undefined;
    return workspaceIdSchema.parse(String(rows[0].workspace_id));
  }

  workspaceForEnrollment(enrollmentCodeSha256: string): string | undefined {
    const rows = this.database
      .prepare(
        "SELECT workspace_id FROM workspace_host_enrollments WHERE enrollment_code_sha256=? ORDER BY workspace_id"
      )
      .all(enrollmentCodeSha256);
    if (rows.length !== 1) return undefined;
    return workspaceIdSchema.parse(String(rows[0].workspace_id));
  }

  workspaceIdsForHumanPrincipal(humanPrincipalId: string): string[] {
    const rows = this.database
      .prepare(
        `SELECT DISTINCT workspace_id FROM (
           SELECT workspace_id FROM workspace_principals WHERE human_principal_id=?
           UNION
           SELECT m.workspace_id
           FROM project_memberships p
           JOIN legacy_project_workspace_mappings m ON m.legacy_project_id=p.project_id
           WHERE p.human_principal_id=?
         ) ORDER BY workspace_id`
      )
      .all(humanPrincipalId, humanPrincipalId);
    return rows.map((row) => workspaceIdSchema.parse(String(row.workspace_id)));
  }

  /** Resolve only workspaces with an active projected principal and membership. */
  activeWorkspaceIdsForHumanPrincipal(humanPrincipalId: string): string[] {
    const rows = this.database
      .prepare(
        `SELECT DISTINCT p.workspace_id
         FROM workspace_principals p
         JOIN workspace_memberships m
           ON m.workspace_id=p.workspace_id AND m.human_principal_id=p.human_principal_id
         WHERE p.human_principal_id=? AND p.revoked_at IS NULL AND m.revoked_at IS NULL
         ORDER BY p.workspace_id`
      )
      .all(humanPrincipalId);
    return rows.map((row) => workspaceIdSchema.parse(String(row.workspace_id)));
  }

  /** Authenticate only the Workspace-scoped device sessions minted by setup-code redemption. */
  authenticateWorkspaceDeviceSession(deviceToken: string):
    | {
        workspaceId: WorkspaceId;
        deviceSessionId: DeviceSessionId;
        humanPrincipalId: string;
        displayName: string;
      }
    | undefined {
    const parsedToken = humanDeviceTokenSchema.safeParse(deviceToken);
    if (!parsedToken.success) return undefined;
    const row = this.database
      .prepare(
        `SELECT s.workspace_id,s.device_session_id,s.human_principal_id,p.display_name
         FROM workspace_device_sessions s
         JOIN workspace_memberships m
           ON m.workspace_id=s.workspace_id AND m.human_principal_id=s.human_principal_id
         JOIN workspace_principals p
           ON p.workspace_id=s.workspace_id AND p.human_principal_id=s.human_principal_id
         WHERE s.credential_sha256=?
           AND s.revoked_at IS NULL
           AND s.expires_at>?
           AND p.revoked_at IS NULL
           AND m.revoked_at IS NULL`
      )
      .get(hashHumanToken(parsedToken.data), nowIso()) as
      | {
          workspace_id: string;
          device_session_id: string;
          human_principal_id: string;
          display_name: string;
        }
      | undefined;
    return row
      ? {
          workspaceId: workspaceIdSchema.parse(String(row.workspace_id)),
          deviceSessionId: deviceSessionIdSchema.parse(String(row.device_session_id)),
          humanPrincipalId: humanPrincipalIdSchema.parse(String(row.human_principal_id)),
          displayName: humanDisplayNameSchema.parse(String(row.display_name))
        }
      : undefined;
  }

  authenticateWorkspaceDevice(deviceToken: string):
    | { humanPrincipalId: string; displayName: string }
    | undefined {
    const authenticated = this.authenticateWorkspaceDeviceSession(deviceToken);
    return authenticated
      ? {
          humanPrincipalId: authenticated.humanPrincipalId,
          displayName: authenticated.displayName
        }
      : undefined;
  }

  /**
   * Server-authoritative, redacted Workspace membership rows for an authenticated
   * human device. Project paths and local desktop profiles are intentionally absent.
   */
  listActiveWorkspacePickerItems(humanPrincipalId: string): WorkspacePickerItem[] {
    return this.activeWorkspaceIdsForHumanPrincipal(humanPrincipalId).map((workspaceId) => {
      const workspace = this.workspaceView(workspaceId);
      const membership = this.listMembershipViews(workspaceId).find(
        (candidate) => candidate.humanPrincipalId === humanPrincipalId && candidate.revokedAt === null
      );
      if (!membership) throw new Error("workspace_membership_projection_missing");
      return workspacePickerItemSchema.parse({
        schemaVersion: "workspace-setup/v1",
        workspaceId,
        displayName: workspace.displayName,
        role: membership.role,
        archivedAt: workspace.archivedAt,
        membershipActive: true
      });
    });
  }

  listHostViews(workspaceId: string, limit: number, offset: number): AgentHostIdentityView[] {
    const parsedWorkspaceId = workspaceIdSchema.parse(workspaceId);
    this.assertReadCutover(parsedWorkspaceId);
    const rows = this.database
      .prepare(
        `SELECT workspace_id,host_id,display_name,capabilities_json,capacity,last_seen_at,
                credential_expires_at,revoked_at
         FROM workspace_agent_hosts
         WHERE workspace_id=? ORDER BY display_name,host_id LIMIT ? OFFSET ?`
      )
      .all(parsedWorkspaceId, limit, offset) as Array<{
      workspace_id: string;
      host_id: string;
      display_name: string;
      capabilities_json: string;
      capacity: number;
      last_seen_at: string | null;
      credential_expires_at: string | null;
      revoked_at: string | null;
    }>;
    return rows.map((row) =>
      agentHostIdentityViewSchema.parse({
        schemaVersion: "workspace-identity/v1",
        workspaceId: row.workspace_id,
        hostId: row.host_id,
        displayName: row.display_name,
        capabilities: JSON.parse(row.capabilities_json),
        capacity: Number(row.capacity),
        lastSeenAt: row.last_seen_at,
        credentialExpiresAt: row.credential_expires_at,
        revokedAt: row.revoked_at
      })
    );
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
    const workspace = this.database
      .prepare(
        "SELECT workspace_id,display_name,created_at,archived_at FROM workspaces WHERE workspace_id=?"
      )
      .get(workspaceId);
    if (workspace) {
      if (
        workspace.display_name !== `Legacy workspace ${projectId}` ||
        workspace.archived_at !== null
      ) {
        throw new Error("workspace_projection_conflict");
      }
    } else {
      this.database
        .prepare(
          "INSERT INTO workspaces(workspace_id,display_name,created_at,archived_at) VALUES(?,?,?,NULL)"
        )
        .run(workspaceId, `Legacy workspace ${projectId}`, at);
    }
    this.database
      .prepare(
        `INSERT INTO legacy_project_workspace_mappings(
          legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at
        ) VALUES(?,?,?,?)`
      )
      .run(projectId, `legacy-project:${projectId}`, workspaceId, at);
    this.database
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
    if (
      !state ||
      state.status !== "completed" ||
      state.interruptionMarker !== "read_cutover_complete"
    ) {
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
      .prepare(
        "SELECT workspace_id FROM workspace_agent_hosts WHERE host_id=? ORDER BY workspace_id"
      )
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
    if (
      !state ||
      state.status !== "completed" ||
      state.interruptionMarker !== "read_cutover_complete"
    ) {
      return false;
    }
    if (row.revoked_at !== null) return false;
    return (
      row.credential_expires_at === null ||
      Date.parse(String(row.credential_expires_at)) > now.getTime()
    );
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
    for (const binding of bindings)
      this.writeEnrollmentProjection(String(binding.workspace_id), grant);
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
          .prepare("SELECT host_id FROM workspace_agent_hosts WHERE workspace_id=? AND host_id=?")
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

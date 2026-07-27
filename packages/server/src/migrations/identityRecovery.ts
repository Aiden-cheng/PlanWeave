import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import {
  backfillProjectIdentity,
  recordMigrationFailure,
  WorkspaceIdentityMigrationFailure,
  type WorkspaceIdentityBackfillOptions,
  type WorkspaceIdentityRecoveryResult
} from "./identity.js";

function nowIso(): string {
  return new Date().toISOString();
}

function migrationRecoveryResult(
  database: SqliteDatabase,
  legacyProjectId: string,
  outcome: WorkspaceIdentityRecoveryResult["outcome"]
): WorkspaceIdentityRecoveryResult {
  const row = database
    .prepare(
      "SELECT legacy_project_id,workspace_id,status FROM workspace_identity_migrations WHERE legacy_project_id=?"
    )
    .get(legacyProjectId);
  if (!row) throw new Error("workspace_identity_migration_not_found");
  return {
    legacyProjectId: String(row.legacy_project_id),
    workspaceId: String(row.workspace_id),
    status: row.status as WorkspaceIdentityRecoveryResult["status"],
    outcome
  };
}

function projectState(database: SqliteDatabase, legacyProjectId: string): Record<string, unknown> {
  const row = database
    .prepare(
      "SELECT legacy_project_id,workspace_id,status FROM workspace_identity_migrations WHERE legacy_project_id=?"
    )
    .get(legacyProjectId);
  if (!row) throw new Error("workspace_identity_migration_not_found");
  return row;
}

/** Retry an interrupted or repair-required v27 project backfill. */
function retryWorkspaceIdentityMigrationCore(
  database: SqliteDatabase,
  legacyProjectId: string,
  options: WorkspaceIdentityBackfillOptions
): WorkspaceIdentityRecoveryResult {
  return inWriteTransaction(database, () => {
    const state = projectState(database, legacyProjectId);
    if (state.status === "completed") {
      return migrationRecoveryResult(database, legacyProjectId, "retry_idempotent");
    }
    const workspaceId = String(state.workspace_id);
    const at = options.now?.() ?? nowIso();
    database
      .prepare(
        `UPDATE workspace_identity_migrations
       SET status='in_progress',failure_code=NULL,updated_at=?
       WHERE legacy_project_id=?`
      )
      .run(at, legacyProjectId);
    try {
      backfillProjectIdentity(database, legacyProjectId, workspaceId, at, options);
    } catch (error) {
      if (!(error instanceof WorkspaceIdentityMigrationFailure)) throw error;
      recordMigrationFailure(database, legacyProjectId, error, at);
    }
    return migrationRecoveryResult(database, legacyProjectId, "resume_from_marker");
  });
}

/** Production retry entry point; fault injection is intentionally unavailable. */
export function retryWorkspaceIdentityMigration(
  database: SqliteDatabase,
  legacyProjectId: string
): WorkspaceIdentityRecoveryResult {
  return retryWorkspaceIdentityMigrationCore(database, legacyProjectId, {});
}

/** @internal Test-only recovery seam for deterministic fault injection. */
export function retryWorkspaceIdentityMigrationForTesting(
  database: SqliteDatabase,
  legacyProjectId: string,
  options: WorkspaceIdentityBackfillOptions
): WorkspaceIdentityRecoveryResult {
  return retryWorkspaceIdentityMigrationCore(database, legacyProjectId, options);
}

/** Re-run parity and projection repair after an operator fixes the legacy source/binding. */
export function repairWorkspaceIdentityMigration(
  database: SqliteDatabase,
  legacyProjectId: string
): WorkspaceIdentityRecoveryResult {
  const result = retryWorkspaceIdentityMigrationCore(database, legacyProjectId, {});
  return {
    ...result,
    outcome: result.status === "completed" ? "resume_from_marker" : "repair_required"
  };
}

function sourceIds(
  database: SqliteDatabase,
  legacyProjectId: string
): {
  membershipIds: string[];
  principalIds: string[];
  deviceIds: string[];
} {
  const membershipIds = database
    .prepare("SELECT membership_id FROM project_memberships WHERE project_id=?")
    .all(legacyProjectId)
    .map((row) => String(row.membership_id));
  const principalIds = database
    .prepare(`SELECT DISTINCT human_principal_id FROM project_memberships WHERE project_id=?`)
    .all(legacyProjectId)
    .map((row) => String(row.human_principal_id));
  const deviceIds = database
    .prepare(
      "SELECT device_credential_id FROM human_device_credentials WHERE minted_for_project_id=?"
    )
    .all(legacyProjectId)
    .map((row) => String(row.device_credential_id));
  return { membershipIds, principalIds, deviceIds };
}

/** Logical rollback: remove only v27 rows sourced from this legacy project. */
export function rollbackWorkspaceIdentityMigration(
  database: SqliteDatabase,
  legacyProjectId: string
): WorkspaceIdentityRecoveryResult {
  return inWriteTransaction(database, () => {
    const state = projectState(database, legacyProjectId);
    const workspaceId = String(state.workspace_id);
    const ids = sourceIds(database, legacyProjectId);
    for (const membershipId of ids.membershipIds) {
      database
        .prepare("DELETE FROM workspace_memberships WHERE workspace_id=? AND membership_id=?")
        .run(workspaceId, membershipId);
    }
    for (const deviceId of ids.deviceIds) {
      database
        .prepare(
          "DELETE FROM workspace_device_sessions WHERE workspace_id=? AND device_session_id=?"
        )
        .run(workspaceId, deviceId);
    }
    for (const principalId of ids.principalIds) {
      const usedElsewhere = database
        .prepare(
          "SELECT 1 FROM workspace_memberships WHERE workspace_id=? AND human_principal_id=? LIMIT 1"
        )
        .get(workspaceId, principalId);
      if (!usedElsewhere) {
        database
          .prepare("DELETE FROM workspace_principals WHERE workspace_id=? AND human_principal_id=?")
          .run(workspaceId, principalId);
      }
      database
        .prepare(
          "DELETE FROM workspace_identity_repairs WHERE workspace_id=? AND subject_kind='human_principal' AND subject_id=?"
        )
        .run(workspaceId, principalId);
    }
    for (const deviceId of ids.deviceIds) {
      database
        .prepare(
          "DELETE FROM workspace_identity_repairs WHERE workspace_id=? AND subject_kind='device_session' AND subject_id=?"
        )
        .run(workspaceId, deviceId);
    }
    database
      .prepare(
        `UPDATE workspace_identity_migrations
       SET status='rolled_back',step='verify_cutover',interruption_marker='rollback_complete',failure_code=NULL,updated_at=?
       WHERE legacy_project_id=?`
      )
      .run(nowIso(), legacyProjectId);
    return migrationRecoveryResult(database, legacyProjectId, "rollback_to_legacy");
  });
}

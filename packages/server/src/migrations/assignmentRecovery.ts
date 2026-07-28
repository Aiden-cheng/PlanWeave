import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { migrateLegacyAssignments } from "./assignment.js";

type AssignmentMigrationState = {
  workspaceId: string;
  projectId: string;
  status: "pending" | "completed" | "repair_required";
};

type LegacyAssignmentRow = {
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

export type AssignmentMigrationRecoveryInput = {
  workspaceId: string;
  projectId: string;
};

export type AssignmentMigrationRecoveryResult = AssignmentMigrationRecoveryInput & {
  status: AssignmentMigrationState["status"];
  outcome:
    | "retry_idempotent"
    | "repair_completed"
    | "repair_required"
    | "rollback_to_legacy"
    | "already_legacy";
};

function nowIso(): string {
  return new Date().toISOString();
}

function migrationState(
  database: SqliteDatabase,
  input: AssignmentMigrationRecoveryInput
): AssignmentMigrationState {
  const row = database
    .prepare(
      `SELECT workspace_id,project_id,status FROM assignment_authority_migrations
       WHERE workspace_id=? AND project_id=?`
    )
    .get(input.workspaceId, input.projectId);
  if (!row) throw new Error("assignment_authority_migration_not_found");
  const status = String(row.status);
  if (status !== "pending" && status !== "completed" && status !== "repair_required") {
    throw new Error("assignment_authority_migration_status_invalid");
  }
  return {
    workspaceId: String(row.workspace_id),
    projectId: String(row.project_id),
    status
  };
}

function recoveryResult(
  database: SqliteDatabase,
  input: AssignmentMigrationRecoveryInput,
  outcome: AssignmentMigrationRecoveryResult["outcome"]
): AssignmentMigrationRecoveryResult {
  const state = migrationState(database, input);
  return { ...state, outcome };
}

/** Retry a repair-required OSS-003 migration after its legacy source is corrected. */
export function retryAssignmentAuthorityMigration(
  database: SqliteDatabase,
  input: AssignmentMigrationRecoveryInput
): AssignmentMigrationRecoveryResult {
  return inWriteTransaction(database, () => {
    const before = migrationState(database, input);
    if (before.status === "completed") return recoveryResult(database, input, "retry_idempotent");
    migrateLegacyAssignments(database, input.projectId);
    const result = recoveryResult(database, input, "repair_required");
    return result.status === "completed"
      ? { ...result, outcome: "repair_completed" }
      : result;
  });
}

/** Re-run the scoped migration and report whether the source repair completed the cutover. */
export function repairAssignmentAuthorityMigration(
  database: SqliteDatabase,
  input: AssignmentMigrationRecoveryInput
): AssignmentMigrationRecoveryResult {
  return retryAssignmentAuthorityMigration(database, input);
}

function legacyRows(
  database: SqliteDatabase,
  projectId: string
): readonly LegacyAssignmentRow[] {
  return database
    .prepare("SELECT * FROM work_assignments WHERE project_id=? ORDER BY canvas_id,work_item_key")
    .all(projectId) as LegacyAssignmentRow[];
}

function assertProjection(
  database: SqliteDatabase,
  table: "responsibility_records" | "execution_target_records",
  keys: readonly unknown[],
  expected: Record<string, unknown>
): void {
  const row = database
    .prepare(
      table === "responsibility_records"
        ? `SELECT * FROM responsibility_records
           WHERE workspace_id=? AND project_id=? AND canvas_id=? AND scope_kind=? AND scope_key=?`
        : `SELECT * FROM execution_target_records
           WHERE workspace_id=? AND project_id=? AND canvas_id=? AND block_ref=?`
    )
    .get(...keys);
  if (!row) throw new Error("assignment_rollback_projection_conflict");
  for (const [key, value] of Object.entries(expected)) {
    if ((row[key] ?? null) !== (value ?? null)) {
      throw new Error("assignment_rollback_projection_conflict");
    }
  }
}

function projectionValues(
  workspaceId: string,
  row: LegacyAssignmentRow
): {
  responsibility?: { keys: readonly unknown[]; expected: Record<string, unknown> };
  executionTarget?: { keys: readonly unknown[]; expected: Record<string, unknown> };
} {
  const base = {
    workspace_id: workspaceId,
    project_id: row.project_id,
    canvas_id: row.canvas_id,
    revision: row.revision,
    updated_by_kind: row.updated_by_kind,
    updated_by_id: row.updated_by_id,
    updated_at: row.updated_at
  };
  const responsibility = (principalId: string | null) => ({
    keys: [workspaceId, row.project_id, row.canvas_id, row.work_item_kind, row.work_item_key],
    expected: {
      ...base,
      scope_kind: row.work_item_kind,
      scope_key: row.work_item_key,
      principal_id: principalId
    }
  });
  if (row.target_kind === "human") {
    return { responsibility: responsibility(row.target_human_principal_id) };
  }
  if (row.target_kind === "unassigned") {
    const values = { responsibility: responsibility(null) };
    if (row.work_item_kind !== "block") return values;
    return {
      ...values,
      executionTarget: {
        keys: [workspaceId, row.project_id, row.canvas_id, row.work_item_key],
        expected: { ...base, block_ref: row.work_item_key, target_kind: "unassigned", host_id: null }
      }
    };
  }
  if (
    row.work_item_kind === "block" &&
    (row.target_kind === "exact_host" || row.target_kind === "automatic_host")
  ) {
    return {
      executionTarget: {
        keys: [workspaceId, row.project_id, row.canvas_id, row.work_item_key],
        expected: {
          ...base,
          block_ref: row.work_item_key,
          target_kind: row.target_kind,
          host_id: row.target_kind === "exact_host" ? row.target_host_id : null
        }
      }
    };
  }
  throw new Error("assignment_rollback_legacy_source_invalid");
}

/**
 * Revert only projections that still exactly match their legacy source.
 * Diverged post-cutover authority records are left untouched and fail closed.
 */
export function rollbackAssignmentAuthorityMigration(
  database: SqliteDatabase,
  input: AssignmentMigrationRecoveryInput
): AssignmentMigrationRecoveryResult {
  return inWriteTransaction(database, () => {
    const state = migrationState(database, input);
    if (state.status === "repair_required") {
      return recoveryResult(database, input, "already_legacy");
    }
    const rows = legacyRows(database, input.projectId);
    if (rows.length === 0) throw new Error("assignment_rollback_source_missing");
    const projections = rows.map((row) => projectionValues(input.workspaceId, row));
    for (const projection of projections) {
      if (projection.responsibility) {
        assertProjection(
          database,
          "responsibility_records",
          projection.responsibility.keys,
          projection.responsibility.expected
        );
      }
      if (projection.executionTarget) {
        assertProjection(
          database,
          "execution_target_records",
          projection.executionTarget.keys,
          projection.executionTarget.expected
        );
      }
    }
    for (const projection of projections) {
      if (projection.responsibility) {
        database
          .prepare(
            `DELETE FROM responsibility_records
             WHERE workspace_id=? AND project_id=? AND canvas_id=? AND scope_kind=? AND scope_key=?`
          )
          .run(...projection.responsibility.keys);
      }
      if (projection.executionTarget) {
        database
          .prepare(
            `DELETE FROM execution_target_records
             WHERE workspace_id=? AND project_id=? AND canvas_id=? AND block_ref=?`
          )
          .run(...projection.executionTarget.keys);
      }
    }
    database
      .prepare(
        `UPDATE assignment_authority_migrations
         SET marker='repair_required',status='repair_required',authoritative_read_version='legacy_assignment',
             failure_code='rollback_to_legacy',updated_at=?
         WHERE workspace_id=? AND project_id=?`
      )
      .run(nowIso(), input.workspaceId, input.projectId);
    return recoveryResult(database, input, "rollback_to_legacy");
  });
}

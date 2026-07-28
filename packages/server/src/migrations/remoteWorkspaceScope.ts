import type { SqliteDatabase } from "../sqlite.js";
import { tableExists } from "./legacyTail.js";
import type { Migration } from "./types.js";

const scopeSql = `
  SELECT project_id, MIN(workspace_id) AS workspace_id
  FROM project_registry
  WHERE revoked_at IS NULL
  GROUP BY project_id
  HAVING COUNT(DISTINCT workspace_id)=1
`;

function tableColumns(database: SqliteDatabase, table: string): Set<string> {
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
}

function requireColumns(database: SqliteDatabase, table: string, columns: readonly string[]): void {
  const available = tableColumns(database, table);
  for (const column of columns) {
    if (!available.has(column)) {
      throw new Error(`remote_workspace_scope_source_missing:${table}.${column}`);
    }
  }
}

export function recreateRemoteWorkspaceScope(database: SqliteDatabase): void {
  for (const table of [
    "remote_operations",
    "remote_execution_attempts",
    "dispatches",
    "project_registry"
  ]) {
    if (!tableExists(database, table)) {
      throw new Error(`remote_workspace_scope_source_missing:${table}`);
    }
  }
  const workspaceColumns = [
    tableColumns(database, "remote_operations").has("workspace_id"),
    tableColumns(database, "remote_execution_attempts").has("workspace_id"),
    tableColumns(database, "dispatches").has("workspace_id")
  ];
  if (workspaceColumns.every(Boolean)) return;
  if (workspaceColumns.some(Boolean)) {
    throw new Error("remote_workspace_scope_source_inconsistent");
  }
  requireColumns(database, "remote_operations", ["id", "project_id", "dispatch_id"]);
  requireColumns(database, "remote_execution_attempts", [
    "execution_attempt_id",
    "operation_id",
    "dispatch_id",
    "project_id"
  ]);
  requireColumns(database, "dispatches", ["id", "project_id"]);
  const hasAmbiguousDependency = (
    parentTable: "remote_operations" | "dispatches",
    dependencies: ReadonlyArray<{ table: string; column: string }>
  ): boolean => {
    const ambiguousParents = database
      .prepare(
        `SELECT parent.id FROM ${parentTable} parent
         LEFT JOIN (${scopeSql}) scopes ON scopes.project_id=parent.project_id
         WHERE scopes.project_id IS NULL`
      )
      .all();
    for (const parent of ambiguousParents) {
      for (const dependency of dependencies) {
        if (!tableExists(database, dependency.table)) continue;
        if (
          database
            .prepare(`SELECT 1 FROM ${dependency.table} WHERE ${dependency.column}=? LIMIT 1`)
            .get(parent.id)
        ) {
          return true;
        }
      }
    }
    return false;
  };
  const ambiguousOperationDependency = hasAmbiguousDependency("remote_operations", [
    { table: "remote_execution_attempts", column: "operation_id" },
    { table: "remote_operation_events", column: "operation_id" },
    { table: "remote_execution_actions", column: "operation_id" },
    { table: "remote_interactions", column: "operation_id" },
    { table: "remote_operation_candidates", column: "operation_id" },
    { table: "remote_acp_event_streams", column: "operation_id" }
  ]);
  const ambiguousDispatchDependency = hasAmbiguousDependency("dispatches", [
    { table: "dispatch_events", column: "dispatch_id" },
    { table: "dispatch_execution_envelopes", column: "dispatch_id" },
    { table: "artifact_grants", column: "dispatch_id" },
    { table: "dispatch_artifact_links", column: "dispatch_id" },
    { table: "remote_operations", column: "dispatch_id" },
    { table: "remote_execution_attempts", column: "dispatch_id" },
    { table: "remote_execution_actions", column: "dispatch_id" },
    { table: "remote_acp_event_streams", column: "dispatch_id" },
    { table: "remote_interactions", column: "dispatch_id" }
  ]);
  if (ambiguousOperationDependency || ambiguousDispatchDependency) {
    throw new Error("remote_workspace_scope_migration_ambiguous_dependencies");
  }
  const quarantinedAt = new Date().toISOString();
  database.exec(`
    CREATE TABLE remote_operations_v40_new (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      block_ref TEXT NOT NULL,
      ownership_generation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL CHECK(
        length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^a-f0-9]*'
      ),
      source_fingerprint TEXT NOT NULL,
      required_capabilities_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN (
        'preparing','claimed','reserved','activated','running','interrupted','action_required',
        'awaiting_writeback','completed','failed','cancelled'
      )),
      dispatch_id TEXT NOT NULL UNIQUE,
      execution_attempt_id TEXT NOT NULL UNIQUE,
      envelope_digest TEXT,
      envelope_reference TEXT,
      host_selection_json TEXT,
      diagnostic_code TEXT,
      diagnostic_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT,
      UNIQUE(workspace_id,project_id,canvas_id,block_ref,ownership_generation,idempotency_key),
      CHECK((state IN ('completed','failed','cancelled') AND terminal_at IS NOT NULL)
        OR (state NOT IN ('completed','failed','cancelled') AND terminal_at IS NULL)),
      CHECK(envelope_digest IS NULL OR (length(envelope_digest)=80
        AND substr(envelope_digest,1,16)='envelope:sha256:'
        AND substr(envelope_digest,17) NOT GLOB '*[^a-f0-9]*'))
    );
    CREATE TABLE remote_execution_attempts_v40_new (
      execution_attempt_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES remote_operations_v40_new(id),
      dispatch_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      block_ref TEXT NOT NULL,
      ownership_generation TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'prepared','reserved','activated','running','interrupted','action_required',
        'awaiting_writeback','superseded','completed','failed','cancelled'
      )),
      host_id TEXT REFERENCES agent_hosts(id),
      lease_id TEXT UNIQUE,
      lease_fencing_token INTEGER NOT NULL DEFAULT 0 CHECK(lease_fencing_token >= 0),
      lease_expires_at TEXT,
      state_version INTEGER NOT NULL DEFAULT 0 CHECK(state_version >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT,
      CHECK((status='prepared' AND host_id IS NULL AND lease_id IS NULL AND lease_expires_at IS NULL
        AND lease_fencing_token=0) OR (status<>'prepared' AND host_id IS NOT NULL AND lease_id IS NOT NULL
        AND lease_expires_at IS NOT NULL AND lease_fencing_token>0)),
      CHECK((status IN ('superseded','completed','failed','cancelled') AND terminal_at IS NOT NULL)
        OR (status NOT IN ('superseded','completed','failed','cancelled') AND terminal_at IS NULL))
    );
    CREATE TABLE dispatches_v40_new (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      block_ref TEXT NOT NULL,
      host_id TEXT NOT NULL REFERENCES agent_hosts(id),
      required_capabilities_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'leased','running','interrupted','cancelling','awaiting_writeback',
        'completed','failed','cancelled'
      )),
      lease_id TEXT NOT NULL UNIQUE,
      execution_attempt_id TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      accepted_at TEXT,
      finished_at TEXT,
      result_json TEXT,
      failure_json TEXT,
      interruption_reason TEXT,
      interruption_resumable INTEGER,
      interruption_recovery_json TEXT,
      UNIQUE(id,project_id,host_id,lease_id,execution_attempt_id),
      UNIQUE(id,lease_id,execution_attempt_id)
    );
    CREATE TABLE IF NOT EXISTS remote_operations_unscoped_legacy (
      operation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      quarantined_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dispatches_unscoped_legacy (
      dispatch_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
      quarantined_at TEXT NOT NULL
    );
  `);
  database
    .prepare(`
    INSERT INTO remote_operations_v40_new(
      id,workspace_id,project_id,canvas_id,block_ref,ownership_generation,idempotency_key,
      request_fingerprint,source_fingerprint,required_capabilities_json,state,dispatch_id,
      execution_attempt_id,envelope_digest,envelope_reference,host_selection_json,diagnostic_code,
      diagnostic_message,created_at,updated_at,terminal_at
    )
    SELECT legacy.id,scopes.workspace_id,legacy.project_id,legacy.canvas_id,legacy.block_ref,
      legacy.ownership_generation,legacy.idempotency_key,legacy.request_fingerprint,
      legacy.source_fingerprint,legacy.required_capabilities_json,legacy.state,legacy.dispatch_id,
      legacy.execution_attempt_id,legacy.envelope_digest,legacy.envelope_reference,
      legacy.host_selection_json,legacy.diagnostic_code,legacy.diagnostic_message,legacy.created_at,
      legacy.updated_at,legacy.terminal_at
    FROM remote_operations legacy
    JOIN (${scopeSql}) scopes ON scopes.project_id=legacy.project_id
  `)
    .run();
  database
    .prepare(`
    INSERT INTO remote_execution_attempts_v40_new(
      execution_attempt_id,operation_id,dispatch_id,workspace_id,project_id,canvas_id,block_ref,
      ownership_generation,status,host_id,lease_id,lease_fencing_token,lease_expires_at,state_version,
      created_at,updated_at,terminal_at
    )
    SELECT legacy.execution_attempt_id,legacy.operation_id,legacy.dispatch_id,operation.workspace_id,
      legacy.project_id,legacy.canvas_id,legacy.block_ref,legacy.ownership_generation,legacy.status,
      legacy.host_id,legacy.lease_id,legacy.lease_fencing_token,legacy.lease_expires_at,
      legacy.state_version,legacy.created_at,legacy.updated_at,legacy.terminal_at
    FROM remote_execution_attempts legacy
    JOIN remote_operations_v40_new operation ON operation.id=legacy.operation_id
  `)
    .run();
  database
    .prepare(`
    INSERT INTO dispatches_v40_new(
      id,workspace_id,project_id,block_ref,host_id,required_capabilities_json,status,lease_id,
      execution_attempt_id,lease_expires_at,created_at,accepted_at,finished_at,result_json,failure_json,
      interruption_reason,interruption_resumable,interruption_recovery_json
    )
    SELECT legacy.id,scopes.workspace_id,legacy.project_id,legacy.block_ref,legacy.host_id,
      legacy.required_capabilities_json,legacy.status,legacy.lease_id,legacy.execution_attempt_id,
      legacy.lease_expires_at,legacy.created_at,legacy.accepted_at,legacy.finished_at,legacy.result_json,
      legacy.failure_json,legacy.interruption_reason,legacy.interruption_resumable,
      legacy.interruption_recovery_json
    FROM dispatches legacy
    JOIN (${scopeSql}) scopes ON scopes.project_id=legacy.project_id
  `)
    .run();
  database
    .prepare(`
    INSERT INTO remote_operations_unscoped_legacy(operation_id,project_id,payload_json,quarantined_at)
    SELECT legacy.id,legacy.project_id,json_object(
      'canvasId',legacy.canvas_id,'blockRef',legacy.block_ref,
      'ownershipGeneration',legacy.ownership_generation,'idempotencyKey',legacy.idempotency_key,
      'dispatchId',legacy.dispatch_id,'executionAttemptId',legacy.execution_attempt_id
    ),?
    FROM remote_operations legacy
    LEFT JOIN (${scopeSql}) scopes ON scopes.project_id=legacy.project_id
    WHERE scopes.project_id IS NULL
  `)
    .run(quarantinedAt);
  database
    .prepare(`
    INSERT INTO dispatches_unscoped_legacy(dispatch_id,project_id,payload_json,quarantined_at)
    SELECT legacy.id,legacy.project_id,json_object(
      'blockRef',legacy.block_ref,'hostId',legacy.host_id,'leaseId',legacy.lease_id,
      'executionAttemptId',legacy.execution_attempt_id
    ),?
    FROM dispatches legacy
    LEFT JOIN (${scopeSql}) scopes ON scopes.project_id=legacy.project_id
    WHERE scopes.project_id IS NULL
  `)
    .run(quarantinedAt);
  database.exec(`
    DROP TABLE remote_execution_attempts;
    DROP TABLE remote_operations;
    DROP TABLE dispatches;
    ALTER TABLE remote_operations_v40_new RENAME TO remote_operations;
    ALTER TABLE remote_execution_attempts_v40_new RENAME TO remote_execution_attempts;
    ALTER TABLE dispatches_v40_new RENAME TO dispatches;
    CREATE UNIQUE INDEX idx_remote_attempt_active_ownership
      ON remote_execution_attempts(workspace_id,project_id,canvas_id,block_ref,ownership_generation)
      WHERE status IN ('reserved','activated','running','interrupted','action_required','awaiting_writeback');
    CREATE INDEX idx_remote_attempt_operation_status
      ON remote_execution_attempts(operation_id,status);
    CREATE UNIQUE INDEX idx_remote_attempt_dispatch_identity
      ON remote_execution_attempts(dispatch_id);
    CREATE UNIQUE INDEX idx_remote_attempt_lease_identity
      ON remote_execution_attempts(lease_id) WHERE lease_id IS NOT NULL;
    CREATE INDEX idx_dispatches_host_status ON dispatches(host_id,status);
    CREATE INDEX idx_dispatches_writeback ON dispatches(status,created_at);
    CREATE UNIQUE INDEX idx_dispatches_artifact_scope
      ON dispatches(id,project_id,host_id,lease_id,execution_attempt_id);
    CREATE UNIQUE INDEX idx_dispatches_lease_scope
      ON dispatches(id,lease_id,execution_attempt_id);
    CREATE INDEX idx_dispatches_workspace_project ON dispatches(workspace_id,project_id,created_at);
  `);
}

export const remoteWorkspaceScopeMigration: Migration = {
  version: 40,
  sql: "SELECT 1;",
  disableForeignKeys: true,
  before: recreateRemoteWorkspaceScope
};

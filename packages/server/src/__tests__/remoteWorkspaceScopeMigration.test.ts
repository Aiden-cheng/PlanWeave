import { afterEach, describe, expect, it } from "vitest";
import { recreateRemoteWorkspaceScope } from "../migrations/remoteWorkspaceScope.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function openLegacyDatabase(): Promise<SqliteDatabase> {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  database.exec(`
    CREATE TABLE project_registry (
      project_registry_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE agent_hosts (id TEXT PRIMARY KEY);
    CREATE TABLE remote_operations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      block_ref TEXT NOT NULL,
      ownership_generation TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      source_fingerprint TEXT NOT NULL,
      required_capabilities_json TEXT NOT NULL,
      state TEXT NOT NULL,
      dispatch_id TEXT NOT NULL,
      execution_attempt_id TEXT NOT NULL,
      envelope_digest TEXT,
      envelope_reference TEXT,
      host_selection_json TEXT,
      diagnostic_code TEXT,
      diagnostic_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT
    );
    CREATE TABLE remote_execution_attempts (
      execution_attempt_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      block_ref TEXT NOT NULL,
      ownership_generation TEXT NOT NULL,
      status TEXT NOT NULL,
      host_id TEXT,
      lease_id TEXT,
      lease_fencing_token INTEGER NOT NULL,
      lease_expires_at TEXT,
      state_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT
    );
    CREATE TABLE dispatches (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      block_ref TEXT NOT NULL,
      host_id TEXT NOT NULL,
      required_capabilities_json TEXT NOT NULL,
      status TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      execution_attempt_id TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      accepted_at TEXT,
      finished_at TEXT,
      result_json TEXT,
      failure_json TEXT,
      interruption_reason TEXT,
      interruption_resumable INTEGER,
      interruption_recovery_json TEXT
    );
  `);
  return database;
}

function registerRevokedAndActiveProject(database: SqliteDatabase): void {
  database.exec(`
    INSERT INTO project_registry(
      project_registry_id,workspace_id,project_id,created_at,revoked_at
    ) VALUES
      ('registry-a','workspace-a','shared-project','2026-01-01T00:00:00.000Z','2026-02-01T00:00:00.000Z'),
      ('registry-b','workspace-b','shared-project','2026-02-02T00:00:00.000Z',NULL);
    INSERT INTO agent_hosts(id) VALUES ('host');
  `);
}

function insertLegacyOperation(
  database: SqliteDatabase,
  operationId: string,
  dispatchId: string
): void {
  database
    .prepare(
      `INSERT INTO remote_operations(
        id,project_id,canvas_id,block_ref,ownership_generation,idempotency_key,request_fingerprint,
        source_fingerprint,required_capabilities_json,state,dispatch_id,execution_attempt_id,
        envelope_digest,envelope_reference,host_selection_json,diagnostic_code,diagnostic_message,
        created_at,updated_at,terminal_at
      ) VALUES(?,?,?,'TASK#B-001','generation','key',?,'source','[]','preparing',?,
        'attempt-missing',NULL,NULL,NULL,NULL,NULL,?,?,NULL)`
    )
    .run(
      operationId,
      "shared-project",
      "default",
      "a".repeat(64),
      dispatchId,
      "2026-01-15T00:00:00.000Z",
      "2026-01-15T00:00:00.000Z"
    );
}

function insertLegacyDispatch(database: SqliteDatabase, dispatchId: string): void {
  database
    .prepare(
      `INSERT INTO dispatches(
        id,project_id,block_ref,host_id,required_capabilities_json,status,lease_id,
        execution_attempt_id,lease_expires_at,created_at,accepted_at,finished_at,result_json,
        failure_json,interruption_reason,interruption_resumable,interruption_recovery_json
      ) VALUES(?,'shared-project','TASK#B-001','host','[]','leased','lease',
        'attempt-dispatch','2099-01-01T00:00:00.000Z','2026-01-15T00:00:00.000Z',
        NULL,NULL,NULL,NULL,NULL,NULL,NULL)`
    )
    .run(dispatchId);
}

describe("remote workspace scope migration", () => {
  it("quarantines independent rows when a revoked workspace shares the project ID with an active workspace", async () => {
    const database = await openLegacyDatabase();
    registerRevokedAndActiveProject(database);
    insertLegacyOperation(database, "operation-revoked", "dispatch-missing");
    insertLegacyDispatch(database, "dispatch-revoked");

    recreateRemoteWorkspaceScope(database);

    expect(
      database.prepare("SELECT workspace_id FROM remote_operations WHERE id=?").get("operation-revoked")
    ).toBeUndefined();
    expect(
      database.prepare("SELECT workspace_id FROM dispatches WHERE id=?").get("dispatch-revoked")
    ).toBeUndefined();
    expect(
      database
        .prepare("SELECT project_id FROM remote_operations_unscoped_legacy WHERE operation_id=?")
        .get("operation-revoked")
    ).toEqual({ project_id: "shared-project" });
    expect(
      database
        .prepare("SELECT project_id FROM dispatches_unscoped_legacy WHERE dispatch_id=?")
        .get("dispatch-revoked")
    ).toEqual({ project_id: "shared-project" });

    recreateRemoteWorkspaceScope(database);

    expect(
      database.prepare("SELECT COUNT(*) AS count FROM remote_operations_unscoped_legacy").get()
    ).toEqual({ count: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM dispatches_unscoped_legacy").get()
    ).toEqual({ count: 1 });
  });

  it("blocks the upgrade when ambiguous historical dispatch scope has dependencies", async () => {
    const database = await openLegacyDatabase();
    registerRevokedAndActiveProject(database);
    insertLegacyOperation(database, "operation-linked", "dispatch-linked");
    insertLegacyDispatch(database, "dispatch-linked");

    expect(() => recreateRemoteWorkspaceScope(database)).toThrow(
      "remote_workspace_scope_migration_ambiguous_dependencies"
    );
    expect(
      database
        .prepare("PRAGMA table_info(remote_operations)")
        .all()
        .some((column) => column.name === "workspace_id")
    ).toBe(false);
    expect(
      database.prepare("SELECT 1 FROM sqlite_master WHERE name='remote_operations_unscoped_legacy'").get()
    ).toBeUndefined();
  });
});

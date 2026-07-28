import { afterEach, describe, expect, it } from "vitest";
import { canvasCommandMigrationSql } from "../migrations/canvas.js";
import { migrationModules } from "../migrations/registry.js";
import {
  setupCodeHostEnrollmentOutcomeMigration,
  setupCodeMigration
} from "../migrations/setup.js";
import { applyMigrations, latestCentralSchemaVersion } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function openDatabase(): Promise<SqliteDatabase> {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  return database;
}

async function openDatabaseAtV26(): Promise<SqliteDatabase> {
  const database = await openDatabase();
  applyMigrations(database);
  database.exec("PRAGMA foreign_keys=OFF");
  for (const table of [
    "setup_code_host_enrollment_outcomes",
    "setup_code_revocations",
    "setup_code_grants",
    "canvas_command_pending",
    "canvas_command_snapshots",
    "canvas_command_journal",
    "canvas_command_operations",
    "canvas_command_heads",
    "assignment_authority_migrations",
    "execution_target_records",
    "review_assignment_records",
    "responsibility_records",
    "package_snapshots",
    "acl_registry_migrations",
    "project_access_grants",
    "canvas_registry",
    "project_registry",
    "workspace_identity_repairs",
    "workspace_host_enrollments",
    "workspace_agent_hosts",
    "workspace_identity_revocations",
    "workspace_operator_sessions",
    "workspace_device_sessions",
    "workspace_memberships",
    "workspace_principals",
    "workspace_identity_migrations",
    "legacy_project_workspace_mappings",
    "workspaces"
  ]) {
    database.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  database.prepare("DELETE FROM schema_migrations WHERE version>=27").run();
  database.exec("PRAGMA foreign_keys=ON");
  return database;
}

function tableExists(database: SqliteDatabase, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  );
}

type MigrationMatrixRow = {
  legacyVersion: number | "ephemeral";
  domainStep: string;
  authoritativeReadVersion: string;
  interruptionMarker: string;
  recoveryResult: string;
};

describe("collaboration migration reconciliation", () => {
  it("keeps OSS-001 through OSS-005 registered in their owning domain order", () => {
    const matrix: readonly MigrationMatrixRow[] = [
      {
        legacyVersion: 26,
        domainStep: "identity",
        authoritativeReadVersion: "workspace-identity/v1",
        interruptionMarker: "read_cutover_complete|partial_backfill_failed",
        recoveryResult: "retry_idempotent|resume_from_marker|rollback_to_legacy"
      },
      {
        legacyVersion: 27,
        domainStep: "acl-registry",
        authoritativeReadVersion: "acl-registry/v1",
        interruptionMarker: "path_bound|migration_failed",
        recoveryResult: "retry|repair|rollback"
      },
      {
        legacyVersion: 27,
        domainStep: "package-registry",
        authoritativeReadVersion: "package-snapshot/v1",
        interruptionMarker: "legacy_package_mapped|migration_failed",
        recoveryResult: "registry_repair_without_runtime_result_mutation"
      },
      {
        legacyVersion: 28,
        domainStep: "assignment-authority",
        authoritativeReadVersion: "oss003_authorities|legacy_assignment",
        interruptionMarker: "cutover_complete|repair_required",
        recoveryResult: "retry_idempotent|repair_completed|rollback_to_legacy"
      },
      {
        legacyVersion: 29,
        domainStep: "canvas-command",
        authoritativeReadVersion: "canvas-command/v1",
        interruptionMarker: "atomic_transaction",
        recoveryResult: "transaction_rollback_then_retry"
      },
      {
        legacyVersion: "ephemeral",
        domainStep: "presence",
        authoritativeReadVersion: "ephemeral_presence/v1",
        interruptionMarker: "ephemeral_no_migration",
        recoveryResult: "not_persisted"
      },
      {
        legacyVersion: 30,
        domainStep: "setup-code",
        authoritativeReadVersion: "workspace-setup/v1",
        interruptionMarker: "atomic_transaction",
        recoveryResult: "transaction_rollback_then_retry"
      }
    ];

    expect(matrix.map((row) => row.domainStep)).toEqual([
      "identity",
      "acl-registry",
      "package-registry",
      "assignment-authority",
      "canvas-command",
      "presence",
      "setup-code"
    ]);
    expect(
      migrationModules
        .filter((module) => module.migrations.some((migration) => migration.version >= 27))
        .map((module) => ({
          name: module.name,
          versions: module.migrations.map((migration) => migration.version)
        }))
    ).toEqual([
      { name: "identity", versions: [27, 34] },
      { name: "acl-registry", versions: [28] },
      { name: "assignment-authority", versions: [29] },
      { name: "canvas-command", versions: [30] },
      { name: "content-versions", versions: [33] },
      { name: "setup-code", versions: [31, 32] },
      { name: "comment-workspace-scope", versions: [35] }
    ]);
    expect(latestCentralSchemaVersion).toBe(35);
  });

  it("maps a representative v26 project to one stable Workspace and package registry key", async () => {
    const database = await openDatabaseAtV26();
    const at = "2026-07-28T00:00:00.000Z";
    database
      .prepare(
        "INSERT INTO human_principals(human_principal_id,display_name,created_at) VALUES(?,?,?)"
      )
      .run("owner", "Owner", at);
    database
      .prepare(
        `INSERT INTO project_memberships(
          membership_id,project_id,human_principal_id,role,created_at,updated_at,revision
        ) VALUES(?,?,?,?,?,?,?)`
      )
      .run("membership-owner", "legacy-project", "owner", "owner", at, at, 1);

    applyMigrations(database);
    const mapping = database
      .prepare(
        `SELECT normalized_legacy_project_identity,workspace_id
         FROM legacy_project_workspace_mappings WHERE legacy_project_id=?`
      )
      .get("legacy-project");
    expect(mapping).toEqual({
      normalized_legacy_project_identity: "legacy-project:legacy-project",
      workspace_id: expect.any(String)
    });
    const workspaceId = String(mapping?.workspace_id);
    expect(
      database
        .prepare(
          `SELECT status,interruption_marker,authoritative_read_version
           FROM workspace_identity_migrations WHERE legacy_project_id=?`
        )
        .get("legacy-project")
    ).toEqual({
      status: "completed",
      interruption_marker: "read_cutover_complete",
      authoritative_read_version: "workspace-identity/v1"
    });
    expect(
      database
        .prepare(
          `SELECT workspace_id,project_root_internal,visibility
           FROM project_registry WHERE workspace_id=? AND project_id=?`
        )
        .get(workspaceId, "legacy-project")
    ).toEqual({ workspace_id: workspaceId, project_root_internal: null, visibility: "private" });
    applyMigrations(database);
    expect(
      database
        .prepare(
          "SELECT workspace_id FROM legacy_project_workspace_mappings WHERE legacy_project_id=?"
        )
        .get("legacy-project")
    ).toEqual({ workspace_id: workspaceId });
  });

  it("rolls canvas and setup schema writes back atomically, then retries from the registry", async () => {
    const canvas = await openDatabase();
    expect(() => {
      canvas.exec("BEGIN IMMEDIATE");
      try {
        canvas.exec(canvasCommandMigrationSql);
        throw new Error("injected_canvas_migration_interruption");
      } catch (error) {
        canvas.exec("ROLLBACK");
        throw error;
      }
    }).toThrow("injected_canvas_migration_interruption");
    expect(tableExists(canvas, "canvas_command_journal")).toBe(false);

    const setup = await openDatabase();
    expect(() => {
      setup.exec("BEGIN IMMEDIATE");
      try {
        setup.exec(setupCodeMigration.sql);
        setup.exec(setupCodeHostEnrollmentOutcomeMigration.sql);
        throw new Error("injected_setup_migration_interruption");
      } catch (error) {
        setup.exec("ROLLBACK");
        throw error;
      }
    }).toThrow("injected_setup_migration_interruption");
    expect(tableExists(setup, "setup_code_grants")).toBe(false);
    expect(tableExists(setup, "setup_code_host_enrollment_outcomes")).toBe(false);

    applyMigrations(canvas);
    applyMigrations(setup);
    expect(tableExists(canvas, "canvas_command_journal")).toBe(true);
    expect(tableExists(setup, "setup_code_grants")).toBe(true);
    expect(tableExists(setup, "setup_code_host_enrollment_outcomes")).toBe(true);
    expect(canvas.prepare("SELECT version FROM schema_migrations WHERE version=30").get()).toEqual({
      version: 30
    });
    expect(
      setup
        .prepare("SELECT version FROM schema_migrations WHERE version IN (31,32) ORDER BY version")
        .all()
    ).toEqual([{ version: 31 }, { version: 32 }]);
  });

  it("keeps presence outside the durable migration schema", async () => {
    const database = await openDatabase();
    applyMigrations(database);
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%presence%'")
        .all()
    ).toEqual([]);
  });
});

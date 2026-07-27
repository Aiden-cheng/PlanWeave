import { afterEach, describe, expect, it } from "vitest";
import {
  aclMigrationIdFor,
  repairAclRegistryMigration,
  readAclRegistryMigration,
  retryAclRegistryMigration,
  rollbackAclRegistryMigration,
  upsertAclRegistryMigration
} from "../migrations.js";
import { aclRegistryMigration } from "../migrations/aclRegistry.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function openMigrated() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  database.exec(`
    INSERT INTO workspaces(workspace_id,display_name,created_at) VALUES ('w','Workspace','2026-01-01');
    INSERT INTO human_principals(human_principal_id,display_name,created_at) VALUES ('owner','Owner','2026-01-01'),('member','Member','2026-01-01');
    INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES ('w','owner','Owner','2026-01-01',NULL),('w','member','Member','2026-01-01',NULL);
    INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES ('w','m-owner','owner','owner',1,'2026-01-01','2026-01-01',NULL),('w','m-member','member','member',1,'2026-01-01','2026-01-01',NULL);
    INSERT INTO legacy_project_workspace_mappings(legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at) VALUES ('p','legacy-project:p','w','2026-01-01');
    INSERT INTO project_memberships(membership_id,project_id,human_principal_id,role,created_at,updated_at,revoked_at) VALUES ('m-1','p','owner','owner','2026-01-01','2026-01-01',NULL),('m-2','p','member','member','2026-01-01','2026-01-01',NULL);
  `);
  return database;
}

describe("ACL registry migration", () => {
  it("backfills explicit legacy mappings with foreign keys enabled and supports recovery", async () => {
    const database = await openMigrated();
    aclRegistryMigration.after?.(database);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(
      database
        .prepare("SELECT owner_human_principal_id FROM project_registry WHERE project_id='p'")
        .get()
    ).toEqual({ owner_human_principal_id: "owner" });
    expect(
      database
        .prepare("SELECT role,acl_revision FROM project_access_grants WHERE project_id='p'")
        .get()
    ).toEqual({ role: "editor", acl_revision: 1 });
    expect(
      readAclRegistryMigration(database, {
        workspaceId: "w",
        projectId: "p",
        sourceKind: "legacy_project"
      })
    ).toMatchObject({ status: "pending", marker: "project_registered" });
    expect(
      retryAclRegistryMigration(database, {
        workspaceId: "w",
        projectId: "p",
        sourceKind: "legacy_project"
      })?.status
    ).toBe("pending");
    rollbackAclRegistryMigration(database, {
      workspaceId: "w",
      projectId: "p",
      sourceKind: "legacy_project"
    });
    expect(
      readAclRegistryMigration(database, {
        workspaceId: "w",
        projectId: "p",
        sourceKind: "legacy_project"
      })?.status
    ).toBe("rolled_back");
  });

  it("rejects migration id/scope conflicts instead of overwriting a unique scope", async () => {
    const database = await openMigrated();
    const at = "2026-01-01T00:00:00.000Z";
    upsertAclRegistryMigration(database, {
      migrationId: "migration-a",
      workspaceId: "w",
      projectId: "p",
      canvasId: null,
      sourceKind: "trusted_project",
      marker: "path_bound",
      status: "in_progress",
      failureCode: null,
      updatedAt: at
    });
    expect(() =>
      upsertAclRegistryMigration(database, {
        migrationId: aclMigrationIdFor("trusted_project", "w", "p"),
        workspaceId: "w",
        projectId: "p",
        canvasId: null,
        sourceKind: "trusted_project",
        marker: "path_bound",
        status: "in_progress",
        failureCode: null,
        updatedAt: at
      })
    ).toThrow("acl_registry_migration_conflict");
  });

  it("recovers an interrupted migration through repair, retry, and rollback", async () => {
    const database = await openMigrated();
    const at = "2026-01-01T00:00:00.000Z";
    const migration = {
      migrationId: aclMigrationIdFor("trusted_canvas", "w", "p", "canvas-a"),
      workspaceId: "w",
      projectId: "p",
      canvasId: "canvas-a",
      sourceKind: "trusted_canvas" as const,
      marker: "canvas_registered" as const,
      status: "interrupted" as const,
      failureCode: "process_crash",
      updatedAt: at
    };
    upsertAclRegistryMigration(database, migration);
    expect(
      readAclRegistryMigration(database, {
        workspaceId: "w",
        projectId: "p",
        canvasId: "canvas-a",
        sourceKind: "trusted_canvas"
      })
    ).toMatchObject({
      status: "interrupted",
      marker: "canvas_registered",
      failureCode: "process_crash"
    });

    expect(
      repairAclRegistryMigration(database, {
        workspaceId: "w",
        projectId: "p",
        canvasId: "canvas-a",
        sourceKind: "trusted_canvas"
      })
    ).toMatchObject({ status: "repair_required", failureCode: "process_crash" });
    expect(
      retryAclRegistryMigration(database, {
        workspaceId: "w",
        projectId: "p",
        canvasId: "canvas-a",
        sourceKind: "trusted_canvas"
      })
    ).toMatchObject({ status: "pending", marker: "canvas_registered", failureCode: null });

    rollbackAclRegistryMigration(database, {
      workspaceId: "w",
      projectId: "p",
      canvasId: "canvas-a",
      sourceKind: "trusted_canvas"
    });
    expect(
      readAclRegistryMigration(database, {
        workspaceId: "w",
        projectId: "p",
        canvasId: "canvas-a",
        sourceKind: "trusted_canvas"
      })
    ).toMatchObject({ status: "rolled_back", marker: "none", failureCode: null });
  });
});

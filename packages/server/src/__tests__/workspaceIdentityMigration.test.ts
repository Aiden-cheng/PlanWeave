import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../migrations.js";
import { backfillWorkspaceIdentity } from "../migrations/identity.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const directories: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function openDatabaseAtV26(): Promise<SqliteDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "planweave-workspace-identity-migration-"));
  directories.push(directory);
  const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
  databases.push(database);
  applyMigrations(database);

  database.exec("PRAGMA foreign_keys=OFF");
  for (const table of [
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
  database.prepare("DELETE FROM schema_migrations WHERE version=27").run();
  database.exec("PRAGMA foreign_keys=ON");
  return database;
}

function repairId(subjectKind: "agent_host" | "enrollment", subjectId: string): string {
  return `identity-repair-${createHash("sha256")
    .update(`${subjectKind}:${subjectId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function enrollmentSubjectId(codeHash: string): string {
  return `legacy-enrollment-${createHash("sha256").update(codeHash).digest("hex").slice(0, 32)}`;
}

describe("workspace identity migration v27 Host repair markers", () => {
  it("does not infer Host grants from zero, one, or many dispatches", async () => {
    const database = await openDatabaseAtV26();
    const now = "2026-07-27T00:00:00.000Z";
    database
      .prepare(
        "INSERT INTO human_principals(human_principal_id,display_name,created_at) VALUES(?,?,?)"
      )
      .run("human-owner", "Owner", now);
    database
      .prepare(
        `INSERT INTO project_memberships(
          membership_id,project_id,human_principal_id,role,created_at,updated_at,revision
        ) VALUES(?,?,?,?,?,?,?)`
      )
      .run("membership-owner", "project-host-repair", "human-owner", "owner", now, now, 1);

    const hosts = [
      { id: "host-zero", dispatches: 0 },
      { id: "host-one", dispatches: 1 },
      { id: "host-many", dispatches: 3 }
    ];
    for (const host of hosts) {
      database
        .prepare(
          `INSERT INTO agent_hosts(
            id,display_name,credential_hash,capabilities_json,capacity,created_at
          ) VALUES(?,?,?,?,?,?)`
        )
        .run(host.id, host.id, "a".repeat(64), "[]", 1, now);
      for (let index = 0; index < host.dispatches; index += 1) {
        database
          .prepare(
            `INSERT INTO dispatches(
              id,project_id,block_ref,host_id,required_capabilities_json,status,lease_id,
              execution_attempt_id,lease_expires_at,created_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            `dispatch-${host.id}-${index}`,
            "project-host-repair",
            `T-001#B-${String(index + 1).padStart(3, "0")}`,
            host.id,
            "[]",
            "completed",
            `lease-${host.id}-${index}`,
            `attempt-${host.id}-${index}`,
            "2030-01-01T00:00:00.000Z",
            now
          );
      }
    }

    const unusedCodeHash = "b".repeat(64);
    const usedCodeHash = "c".repeat(64);
    database
      .prepare(
        `INSERT INTO agent_host_enrollment_grants(
          code_hash,expires_at,credential_expires_at,created_at
        ) VALUES(?,?,?,?)`
      )
      .run(unusedCodeHash, "2030-01-01T00:00:00.000Z", "2030-01-02T00:00:00.000Z", now);
    database
      .prepare(
        `INSERT INTO agent_host_enrollment_grants(
          code_hash,expires_at,credential_expires_at,used_at,used_attempt_id,
          used_request_hash,host_id,created_at
        ) VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(
        usedCodeHash,
        "2030-01-01T00:00:00.000Z",
        "2030-01-02T00:00:00.000Z",
        now,
        "enrollment-attempt-used",
        "d".repeat(64),
        "host-many",
        now
      );

    applyMigrations(database);

    expect(database.prepare("SELECT COUNT(*) AS count FROM workspace_agent_hosts").get()).toEqual({
      count: 0
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM workspace_host_enrollments").get()
    ).toEqual({ count: 0 });

    const repairs = database
      .prepare(
        `SELECT repair_id,subject_kind,subject_id,status,reason
         FROM workspace_identity_repairs ORDER BY subject_kind,subject_id`
      )
      .all();
    expect(repairs).toHaveLength(5);
    expect(repairs).toEqual(
      expect.arrayContaining(
        hosts.map((host) => ({
          repair_id: repairId("agent_host", host.id),
          subject_kind: "agent_host",
          subject_id: host.id,
          status: "repair_required",
          reason: "host_requires_reenrollment"
        }))
      )
    );
    const unusedSubjectId = enrollmentSubjectId(unusedCodeHash);
    const usedSubjectId = enrollmentSubjectId(usedCodeHash);
    expect(repairs).toEqual(
      expect.arrayContaining([
        {
          repair_id: repairId("enrollment", unusedSubjectId),
          subject_kind: "enrollment",
          subject_id: unusedSubjectId,
          status: "repair_required",
          reason: "enrollment_requires_workspace_binding"
        },
        {
          repair_id: repairId("enrollment", usedSubjectId),
          subject_kind: "enrollment",
          subject_id: usedSubjectId,
          status: "repair_required",
          reason: "enrollment_requires_reenrollment"
        }
      ])
    );

    expect(
      database
        .prepare(
          `SELECT status,interruption_marker FROM workspace_identity_migrations
           WHERE legacy_project_id=?`
        )
        .get("project-host-repair")
    ).toEqual({ status: "completed", interruption_marker: "read_cutover_complete" });

    backfillWorkspaceIdentity(database);
    expect(
      database
        .prepare(
          "SELECT repair_id,status,reason FROM workspace_identity_repairs WHERE subject_id=?"
        )
        .get("host-many")
    ).toEqual({
      repair_id: repairId("agent_host", "host-many"),
      status: "repair_required",
      reason: "host_requires_reenrollment"
    });
  });
});

describe("workspace identity migration v27 human scope repair", () => {
  it("does not clone a legacy principal across workspaces and is idempotent", async () => {
    const database = await openDatabaseAtV26();
    const now = "2026-07-27T00:00:00.000Z";
    database
      .prepare(
        "INSERT INTO human_principals(human_principal_id,display_name,created_at) VALUES(?,?,?)"
      )
      .run("human-shared", "Shared", now);
    for (const project of ["project-a", "project-b"]) {
      database
        .prepare(
          `INSERT INTO project_memberships(
            membership_id,project_id,human_principal_id,role,created_at,updated_at,revision
          ) VALUES(?,?,?,?,?,?,?)`
        )
        .run(`membership-${project}`, project, "human-shared", "member", now, now, 1);
    }
    database
      .prepare(
        `INSERT INTO human_device_credentials(
          device_credential_id,human_principal_id,minted_for_project_id,token_sha256,created_at
        ) VALUES(?,?,?,?,?)`
      )
      .run("device-a", "human-shared", "project-a", "a".repeat(64), now);
    database
      .prepare(
        `INSERT INTO human_device_credentials(
          device_credential_id,human_principal_id,minted_for_project_id,token_sha256,created_at
        ) VALUES(?,?,?,?,?)`
      )
      .run("device-b", "human-shared", "project-b", "b".repeat(64), now);

    applyMigrations(database);

    const mappings = database
      .prepare(
        "SELECT legacy_project_id,workspace_id FROM legacy_project_workspace_mappings ORDER BY legacy_project_id"
      )
      .all();
    const workspaceA = String(mappings[0].workspace_id);
    const workspaceB = String(mappings[1].workspace_id);
    expect(workspaceA).not.toBe(workspaceB);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM workspace_principals WHERE workspace_id=?")
        .get(workspaceA)
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM workspace_principals WHERE workspace_id=?")
        .get(workspaceB)
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM workspace_memberships WHERE workspace_id=?")
        .get(workspaceB)
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM workspace_device_sessions WHERE workspace_id=?")
        .get(workspaceB)
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          `SELECT subject_kind,subject_id,reason FROM workspace_identity_repairs
           ORDER BY subject_kind,subject_id`
        )
        .all()
    ).toEqual(
      expect.arrayContaining([
        {
          subject_kind: "human_principal",
          subject_id: "human-shared",
          reason: "human_principal_requires_reenrollment"
        },
        {
          subject_kind: "device_session",
          subject_id: "device-b",
          reason: "device_session_requires_reenrollment"
        }
      ])
    );
    expect(
      database
        .prepare(
          "SELECT status,interruption_marker,failure_code FROM workspace_identity_migrations WHERE workspace_id=?"
        )
        .get(workspaceB)
    ).toEqual({
      status: "repair_required",
      interruption_marker: "partial_backfill_failed",
      failure_code: "human_principal_workspace_conflict"
    });
    expect(() => new WorkspaceIdentityRepository(database).listPrincipalViews(workspaceB)).toThrow(
      "workspace_identity_read_cutover_incomplete"
    );

    backfillWorkspaceIdentity(database);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM workspace_identity_repairs").get()
    ).toEqual({ count: 2 });
  });
});

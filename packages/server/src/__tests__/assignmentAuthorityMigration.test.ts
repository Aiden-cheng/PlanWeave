import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function legacyFixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  database.exec(`
    INSERT INTO workspaces(workspace_id,display_name,created_at)
      VALUES ('w','Workspace','2026-07-27T00:00:00.000Z');
    INSERT INTO legacy_project_workspace_mappings(legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at)
      VALUES ('p','legacy-project:p','w','2026-07-27T00:00:00.000Z');
    DELETE FROM schema_migrations WHERE version=29;
    DROP TABLE assignment_authority_migrations;
    DROP TABLE execution_target_records;
    DROP TABLE review_assignment_records;
    DROP TABLE responsibility_records;
  `);
  return database;
}

function insertLegacy(
  database: SqliteDatabase,
  input: {
    key: string;
    workItemKind: "task" | "block";
    targetKind: "human" | "exact_host";
    humanId?: string;
    hostId?: string;
  }
): void {
  database
    .prepare(
      `INSERT INTO work_assignments(
        project_id,canvas_id,work_item_kind,work_item_key,target_kind,
        target_human_principal_id,target_host_id,revision,updated_by_kind,
        updated_by_id,updated_by_display_name,updated_at
      ) VALUES ('p','c',?,?,?,?,?,1,'human','owner',NULL,'2026-07-27T00:00:00.000Z')`
    )
    .run(
      input.workItemKind,
      input.key,
      input.targetKind,
      input.humanId ?? null,
      input.hostId ?? null
    );
}

describe("assignment authority migration", () => {
  it("backfills human responsibility and exact Block Host without conflating them", async () => {
    const database = await legacyFixture();
    insertLegacy(database, {
      key: "T-001",
      workItemKind: "task",
      targetKind: "human",
      humanId: "member"
    });
    insertLegacy(database, {
      key: "T-001#B-001",
      workItemKind: "block",
      targetKind: "exact_host",
      hostId: "host-1"
    });

    applyMigrations(database);
    expect(
      database
        .prepare("SELECT principal_id FROM responsibility_records WHERE scope_key='T-001'")
        .get()
    ).toEqual({ principal_id: "member" });
    expect(
      database
        .prepare(
          "SELECT target_kind,host_id FROM execution_target_records WHERE block_ref='T-001#B-001'"
        )
        .get()
    ).toEqual({ target_kind: "exact_host", host_id: "host-1" });
    expect(
      database
        .prepare(
          "SELECT marker,status,authoritative_read_version FROM assignment_authority_migrations WHERE project_id='p'"
        )
        .get()
    ).toEqual({
      marker: "cutover_complete",
      status: "completed",
      authoritative_read_version: "oss003_authorities"
    });
  });

  it("marks a legacy Task Host target repair-required and keeps legacy reads authoritative", async () => {
    const database = await legacyFixture();
    database.exec("PRAGMA ignore_check_constraints = ON");
    insertLegacy(database, {
      key: "T-001",
      workItemKind: "task",
      targetKind: "exact_host",
      hostId: "host-1"
    });
    database.exec("PRAGMA ignore_check_constraints = OFF");

    applyMigrations(database);
    expect(
      database
        .prepare(
          "SELECT marker,status,authoritative_read_version,failure_code FROM assignment_authority_migrations WHERE project_id='p'"
        )
        .get()
    ).toEqual({
      marker: "repair_required",
      status: "repair_required",
      authoritative_read_version: "legacy_assignment",
      failure_code: "legacy_task_host_target_requires_repair"
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM execution_target_records").get()
    ).toEqual({ count: 0 });
  });
});

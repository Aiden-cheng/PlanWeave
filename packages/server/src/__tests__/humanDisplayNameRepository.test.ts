import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HumanIdentityRepository } from "../identity/repository.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const directories: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function openRepository() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-human-display-name-"));
  directories.push(directory);
  const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
  databases.push(database);
  applyMigrations(database);
  return { database, repository: new HumanIdentityRepository(database) };
}

describe("human display name repository", () => {
  it("atomically updates the global name and every Workspace projection without rewriting history", async () => {
    const { database, repository } = await openRepository();
    const bootstrapped = repository.bootstrapOwner({
      kind: "local_administrative_proof",
      projectId: "project-a",
      humanPrincipalId: "human-owner-1",
      displayName: "Ada Owner",
      issuedAt: "2026-07-24T10:00:00.000Z"
    });
    const primaryWorkspace = database
      .prepare("SELECT workspace_id FROM workspace_principals WHERE human_principal_id=?")
      .get(bootstrapped.principal.humanPrincipalId) as { workspace_id: string };
    database
      .prepare(
        "INSERT INTO workspaces(workspace_id,display_name,created_at,archived_at) VALUES(?,?,?,NULL)"
      )
      .run("workspace-secondary", "Secondary", bootstrapped.principal.createdAt);
    database
      .prepare(
        `INSERT INTO workspace_principals(
          workspace_id,human_principal_id,display_name,created_at,revoked_at
        ) VALUES(?,?,?,?,NULL)`
      )
      .run(
        "workspace-secondary",
        bootstrapped.principal.humanPrincipalId,
        bootstrapped.principal.displayName,
        bootstrapped.principal.createdAt
      );
    const historicalSubjects = JSON.stringify([
      {
        kind: "human",
        humanPrincipalId: bootstrapped.principal.humanPrincipalId,
        displayName: "Ada Owner"
      }
    ]);
    database
      .prepare(
        `INSERT INTO activity_records(
          activity_id,workspace_id,project_id,type,source_kind,source_id,summary_json,subjects_json,
          canvas_id,work_item_kind,work_item_key,occurred_at
        ) VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL,?)`
      )
      .run(
        "activity-old-name",
        primaryWorkspace.workspace_id,
        "project-a",
        "member_joined",
        "membership",
        bootstrapped.membership.membershipId,
        JSON.stringify({ headline: "Ada Owner joined" }),
        historicalSubjects,
        bootstrapped.principal.createdAt
      );

    database.exec(`
      CREATE TRIGGER reject_secondary_name_update
      BEFORE UPDATE OF display_name ON workspace_principals
      WHEN OLD.workspace_id='workspace-secondary'
      BEGIN
        SELECT RAISE(ABORT, 'projection_update_rejected');
      END;
    `);
    expect(() =>
      repository.updateHumanDisplayName(bootstrapped.principal.humanPrincipalId, "Grace Hopper")
    ).toThrow("projection_update_rejected");
    expect(repository.getPrincipal(bootstrapped.principal.humanPrincipalId)?.displayName).toBe(
      "Ada Owner"
    );

    database.exec("DROP TRIGGER reject_secondary_name_update");
    expect(
      repository.updateHumanDisplayName(bootstrapped.principal.humanPrincipalId, "  Grace Hopper  ")
        .displayName
    ).toBe("Grace Hopper");
    expect(
      database
        .prepare(
          `SELECT workspace_id,display_name FROM workspace_principals
           WHERE human_principal_id=? ORDER BY workspace_id`
        )
        .all(bootstrapped.principal.humanPrincipalId)
    ).toEqual([
      { workspace_id: primaryWorkspace.workspace_id, display_name: "Grace Hopper" },
      { workspace_id: "workspace-secondary", display_name: "Grace Hopper" }
    ]);
    expect(
      database.prepare("SELECT summary_json,subjects_json FROM activity_records").get()
    ).toEqual({
      summary_json: JSON.stringify({ headline: "Ada Owner joined" }),
      subjects_json: historicalSubjects
    });
  });
});

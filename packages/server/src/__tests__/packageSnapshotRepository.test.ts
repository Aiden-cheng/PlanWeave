import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { applyMigrations } from "../migrations.js";
import { PackageSnapshotRepository } from "../packageSnapshotRepository.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture() {
  const workspace = await createTestWorkspace();
  directories.push(workspace.home, workspace.root);
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  database.exec(`
    INSERT INTO workspaces(workspace_id,display_name,created_at) VALUES ('w','Workspace','2026-01-01');
    INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES
      ('w','owner','Owner','2026-01-01',NULL),('w','viewer','Viewer','2026-01-01',NULL);
    INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES
      ('w','m-owner','owner','owner',1,'2026-01-01','2026-01-01',NULL),('w','m-viewer','viewer','member',1,'2026-01-01','2026-01-01',NULL);
  `);
  const access = new ProjectAccessRepository(database, () => new Date("2026-01-02T00:00:00.000Z"));
  access.registerProjectInternal({
    workspaceId: "w",
    projectId: "p",
    projectRoot: workspace.root,
    ownerHumanPrincipalId: "owner"
  });
  access.registerCanvasInternal({
    workspaceId: "w",
    projectId: "p",
    canvasId: "default",
    packageDir: workspace.init.workspace.packageDir,
    visibility: "shared",
    ownerHumanPrincipalId: "owner"
  });
  access.markCanvasCutover("w", "p", "default");
  access.finalizeProjectCutover("w", "p");
  const snapshots = new PackageSnapshotRepository(
    database,
    access,
    join(workspace.root, "snapshot-data"),
    () => new Date("2026-01-02T00:00:00.000Z")
  );
  return { workspace, database, access, snapshots };
}

const owner = { kind: "human", id: "owner" } as const;
const viewer = { kind: "human", id: "viewer" } as const;

describe("package snapshot repository", () => {
  it("persists bounded payloads without package paths and restores through ACL", async () => {
    const { workspace, snapshots } = await fixture();
    const created = await snapshots.create({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      actor: owner,
      expectedAclRevision: 0
    });
    const backing = join(
      workspace.root,
      "snapshot-data",
      "snapshots",
      created.snapshot.immutable.snapshotId,
      "package.json"
    );
    const payload = JSON.parse(await readFile(backing, "utf8"));
    expect(payload).not.toHaveProperty("packageDir");
    await writeFile(workspace.init.workspace.manifestFile, "{}", "utf8");
    const restored = await snapshots.restore({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      snapshotId: created.snapshot.immutable.snapshotId,
      actor: owner,
      expectedAclRevision: 0
    });
    expect(restored.outcome).toBe("restored");
    expect(
      JSON.parse(await readFile(workspace.init.workspace.manifestFile, "utf8")).project.title
    ).toBe("Test Plan");
  });

  it("rejects viewer mutation, stale ACL, and tampered backing paths", async () => {
    const { database, snapshots, access } = await fixture();
    access.grant({
      workspaceId: "w",
      projectId: "p",
      humanPrincipalId: "viewer",
      role: "viewer",
      grantedBy: owner
    });
    await expect(
      snapshots.create({
        workspaceId: "w",
        projectId: "p",
        canvasId: "default",
        actor: viewer,
        expectedAclRevision: 0
      })
    ).rejects.toThrow("grantor_role_insufficient");
    const created = await snapshots.create({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      actor: owner,
      expectedAclRevision: 0
    });
    database
      .prepare("UPDATE package_snapshots SET content_root_internal=? WHERE snapshot_id=?")
      .run("/tmp/evil", created.snapshot.immutable.snapshotId);
    const result = await snapshots.restore({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      snapshotId: created.snapshot.immutable.snapshotId,
      actor: owner,
      expectedAclRevision: 0
    });
    expect(result.outcome).toBe("malformed");
    expect(
      database
        .prepare("SELECT state,restore_marker FROM package_snapshots WHERE snapshot_id=?")
        .get(created.snapshot.immutable.snapshotId)
    ).toEqual({ state: "malformed", restore_marker: "none" });
  });

  it("marks snapshots malformed when backing content digest is tampered", async () => {
    const { database, workspace, snapshots } = await fixture();
    const created = await snapshots.create({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      actor: owner,
      expectedAclRevision: 0
    });
    const backing = join(
      workspace.root,
      "snapshot-data",
      "snapshots",
      created.snapshot.immutable.snapshotId,
      "package.json"
    );
    const payload = JSON.parse(await readFile(backing, "utf8")) as {
      files: Array<{ content: string }>;
    };
    payload.files[0].content = `${payload.files[0].content}\ntampered`;
    await writeFile(backing, JSON.stringify(payload), "utf8");
    const result = await snapshots.restore({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      snapshotId: created.snapshot.immutable.snapshotId,
      actor: owner,
      expectedAclRevision: 0
    });
    expect(result.outcome).toBe("malformed");
    expect(
      database
        .prepare("SELECT state,restore_marker FROM package_snapshots WHERE snapshot_id=?")
        .get(created.snapshot.immutable.snapshotId)
    ).toEqual({ state: "malformed", restore_marker: "none" });
  });

  it("blocks revoke while restore is pending and is idempotent afterwards", async () => {
    const { database, snapshots } = await fixture();
    const created = await snapshots.create({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      actor: owner,
      expectedAclRevision: 0
    });
    database
      .prepare("UPDATE package_snapshots SET restore_marker='restore_pending' WHERE snapshot_id=?")
      .run(created.snapshot.immutable.snapshotId);
    await expect(
      snapshots.revoke({
        workspaceId: "w",
        projectId: "p",
        canvasId: "default",
        snapshotId: created.snapshot.immutable.snapshotId,
        actor: owner,
        expectedAclRevision: 0
      })
    ).rejects.toThrow("snapshot_restore_pending");
    database
      .prepare("UPDATE package_snapshots SET restore_marker='none' WHERE snapshot_id=?")
      .run(created.snapshot.immutable.snapshotId);
    await snapshots.revoke({
      workspaceId: "w",
      projectId: "p",
      canvasId: "default",
      snapshotId: created.snapshot.immutable.snapshotId,
      actor: owner,
      expectedAclRevision: 0
    });
    await expect(
      snapshots.revoke({
        workspaceId: "w",
        projectId: "p",
        canvasId: "default",
        snapshotId: created.snapshot.immutable.snapshotId,
        actor: owner,
        expectedAclRevision: 0
      })
    ).resolves.toBeUndefined();
  });

  it("retains the newest bounded snapshots with a fixed clock", async () => {
    const { database, workspace, snapshots } = await fixture();
    let newest = "";
    for (let index = 0; index < 257; index += 1) {
      await writeFile(
        join(workspace.init.workspace.packageDir, "nodes", "T-001", "prompt.md"),
        `# revision ${index}\n`,
        "utf8"
      );
      newest = (
        await snapshots.create({
          workspaceId: "w",
          projectId: "p",
          canvasId: "default",
          actor: owner,
          expectedAclRevision: 0
        })
      ).snapshot.immutable.snapshotId;
    }
    const canvasRegistryId = database
      .prepare(
        "SELECT canvas_registry_id FROM canvas_registry WHERE project_id='p' AND canvas_id='default'"
      )
      .get()?.canvas_registry_id;
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM package_snapshots WHERE canvas_registry_id=? AND state='available'"
        )
        .get(canvasRegistryId)?.count
    ).toBe(256);
    expect(
      database.prepare("SELECT state FROM package_snapshots WHERE snapshot_id=?").get(newest)
    ).toEqual({ state: "available" });
  });
});

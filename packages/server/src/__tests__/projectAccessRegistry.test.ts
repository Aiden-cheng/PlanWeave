import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../migrations.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function openFixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  database.exec(`
    INSERT INTO workspaces(workspace_id,display_name,created_at) VALUES ('w','Workspace','2026-01-01');
    INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES
      ('w','owner','Owner','2026-01-01',NULL),
      ('w','editor','Editor','2026-01-01',NULL),
      ('w','viewer','Viewer','2026-01-01',NULL);
    INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES
      ('w','m-owner','owner','owner',1,'2026-01-01','2026-01-01',NULL),
      ('w','m-editor','editor','member',1,'2026-01-01','2026-01-01',NULL),
      ('w','m-viewer','viewer','member',1,'2026-01-01','2026-01-01',NULL);
  `);
  return {
    database,
    access: new ProjectAccessRepository(database, () => new Date("2026-01-02T00:00:00.000Z"))
  };
}

const owner = { kind: "human", id: "owner" } as const;
const editor = { kind: "human", id: "editor" } as const;
const viewer = { kind: "human", id: "viewer" } as const;

async function registered() {
  const fixture = await openFixture();
  fixture.access.registerProjectInternal({
    workspaceId: "w",
    projectId: "p",
    projectRoot: "/tmp/planweave-project",
    ownerHumanPrincipalId: "owner"
  });
  fixture.access.registerCanvasInternal({
    workspaceId: "w",
    projectId: "p",
    canvasId: "c",
    packageDir: "/tmp/planweave-project-canvas",
    ownerHumanPrincipalId: "owner"
  });
  return fixture;
}

describe("project access registry", () => {
  it("enforces owner/editor management by scope and makes revoke replay idempotent", async () => {
    const { access } = await registered();
    const projectEditor = access.grant({
      workspaceId: "w",
      projectId: "p",
      humanPrincipalId: "editor",
      role: "editor",
      grantedBy: owner
    });
    const projectViewer = access.grant({
      workspaceId: "w",
      projectId: "p",
      humanPrincipalId: "viewer",
      role: "viewer",
      grantedBy: owner
    });
    expect(() =>
      access.grant({
        workspaceId: "w",
        projectId: "p",
        canvasId: "c",
        humanPrincipalId: "viewer",
        role: "viewer",
        grantedBy: editor
      })
    ).toThrow("grantor_role_insufficient");
    const revoked = access.revoke({
      workspaceId: "w",
      projectId: "p",
      canvasId: null,
      grantId: projectViewer.grantId,
      actor: editor,
      expectedAclRevision: 2
    });
    expect(
      access.revoke({
        workspaceId: "w",
        projectId: "p",
        canvasId: null,
        grantId: projectViewer.grantId,
        actor: editor,
        expectedAclRevision: 2
      })
    ).toEqual(revoked);
    expect(() =>
      access.revoke({
        workspaceId: "w",
        projectId: "p",
        canvasId: null,
        grantId: projectViewer.grantId,
        actor: viewer,
        expectedAclRevision: 2
      })
    ).toThrow("grantor_role_insufficient");
    const canvasEditor = access.grant({
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      humanPrincipalId: "editor",
      role: "editor",
      grantedBy: owner
    });
    expect(
      access.grant({
        workspaceId: "w",
        projectId: "p",
        canvasId: "c",
        humanPrincipalId: "viewer",
        role: "viewer",
        grantedBy: editor
      }).scopeKind
    ).toBe("canvas");
    expect(projectEditor.scopeKind).toBe("project");
    expect(canvasEditor.scopeKind).toBe("canvas");
  });

  it("keeps SQL pagination bounded to authorized rows", async () => {
    const { access } = await registered();
    access.grant({
      workspaceId: "w",
      projectId: "p",
      humanPrincipalId: "editor",
      role: "editor",
      grantedBy: owner
    });
    expect(
      access.listAuthorizedProjects({ workspaceId: "w", actor: editor, limit: 1, offset: 0 })
    ).toHaveLength(1);
    expect(
      access.listAuthorizedCanvases({
        workspaceId: "w",
        projectId: "p",
        actor: editor,
        limit: 1,
        offset: 0
      })
    ).toHaveLength(0);
  });

  it("requires explicit active owner initialization and verifies registration replay", async () => {
    const { access } = await openFixture();
    access.registerProjectInternal({
      workspaceId: "w",
      projectId: "ownerless",
      projectRoot: "/tmp/ownerless",
      visibility: "private"
    });
    access.registerCanvasInternal({
      workspaceId: "w",
      projectId: "ownerless",
      canvasId: "c",
      packageDir: "/tmp/ownerless-c",
      visibility: "private"
    });
    expect(() =>
      access.registerProjectInternal({
        workspaceId: "w",
        projectId: "ownerless",
        projectRoot: "/tmp/ownerless",
        visibility: "shared",
        ownerHumanPrincipalId: "owner"
      })
    ).toThrow("project_registry_conflict");
    expect(() => access.initializeProjectOwner("w", "ownerless", "missing")).toThrow(
      "project_registry_owner_not_active"
    );
    const project = access.initializeProjectOwner("w", "ownerless", "owner");
    expect(project.ownerHumanPrincipalId).toBe("owner");
    expect(access.registry.canvasInternal("w", "ownerless", "c")?.ownerHumanPrincipalId).toBe(
      "owner"
    );
    expect(() => access.initializeProjectOwner("w", "ownerless", "editor")).toThrow(
      "project_registry_owner_conflict"
    );
    expect(access.project("w", "ownerless")?.owner).toBe("owner");
  });
});

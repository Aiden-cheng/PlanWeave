import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../migrations.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { inWriteTransaction, openServerDatabase, type SqliteDatabase } from "../sqlite.js";

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

  it("transfers registry ownership and preserves independent canvas owners", async () => {
    const { database, access } = await openFixture();
    database.exec(`
      INSERT INTO human_principals(human_principal_id,display_name,created_at) VALUES
        ('owner','Owner','2026-01-01'),('editor','Editor','2026-01-01'),('viewer','Viewer','2026-01-01');
      INSERT INTO project_memberships(
        membership_id,project_id,human_principal_id,role,revision,created_at,updated_at
      ) VALUES
        ('m-owner','p','owner','owner',1,'2026-01-01','2026-01-01'),
        ('m-editor','p','editor','owner',1,'2026-01-02','2026-01-02'),
        ('m-viewer','p','viewer','owner',1,'2026-01-03','2026-01-03');
    `);
    access.registerProjectInternal({
      workspaceId: "w",
      projectId: "p",
      projectRoot: "/tmp/transfer-project",
      ownerHumanPrincipalId: "owner"
    });
    access.registerCanvasInternal({
      workspaceId: "w",
      projectId: "p",
      canvasId: "inherited",
      packageDir: "/tmp/transfer-project-inherited",
      ownerHumanPrincipalId: "owner"
    });
    access.registerCanvasInternal({
      workspaceId: "w",
      projectId: "p",
      canvasId: "independent",
      packageDir: "/tmp/transfer-project-independent",
      ownerHumanPrincipalId: "viewer"
    });

    inWriteTransaction(database, () => {
      database
        .prepare(
          "UPDATE project_memberships SET role='member',revision=revision+1 WHERE membership_id=?"
        )
        .run("m-owner");
      database
        .prepare(
          "UPDATE workspace_memberships SET role='member',revision=revision+1 WHERE workspace_id=? AND human_principal_id=?"
        )
        .run("w", "owner");
      access.synchronizeHumanMembershipOwnerInCallerTransaction({
        workspaceId: "w",
        projectId: "p",
        humanPrincipalId: "owner",
        transition: "owner_demoted",
        membershipRole: "member"
      });
    });
    expect(access.project("w", "p")?.owner).toBe("editor");
    expect(access.canvas("w", "p", "inherited")?.owner).toBe("editor");
    expect(access.canvas("w", "p", "independent")?.owner).toBe("viewer");

    inWriteTransaction(database, () => {
      database
        .prepare(
          "UPDATE project_memberships SET revoked_at='2026-01-04',updated_at='2026-01-04',revision=revision+1 WHERE membership_id=?"
        )
        .run("m-editor");
      database
        .prepare(
          "UPDATE workspace_memberships SET revoked_at='2026-01-04',updated_at='2026-01-04',revision=revision+1 WHERE workspace_id=? AND human_principal_id=?"
        )
        .run("w", "editor");
      access.synchronizeHumanMembershipOwnerInCallerTransaction({
        workspaceId: "w",
        projectId: "p",
        humanPrincipalId: "editor",
        transition: "member_removed",
        membershipRole: "owner"
      });
    });
    expect(access.project("w", "p")?.owner).toBe("viewer");
    expect(access.canvas("w", "p", "inherited")?.owner).toBe("viewer");
    expect(access.canvas("w", "p", "independent")?.owner).toBe("viewer");
  });

  it("transfers independent canvas ownership when a member is removed", async () => {
    const { database, access } = await openFixture();
    database.exec(`
      INSERT INTO human_principals(human_principal_id,display_name,created_at) VALUES
        ('owner','Owner','2026-01-01'),('editor','Editor','2026-01-01');
      INSERT INTO project_memberships(
        membership_id,project_id,human_principal_id,role,revision,created_at,updated_at
      ) VALUES
        ('m-owner','p','owner','owner',1,'2026-01-01','2026-01-01'),
        ('m-member','p','editor','member',1,'2026-01-02','2026-01-02');
    `);
    access.registerProjectInternal({
      workspaceId: "w",
      projectId: "p",
      projectRoot: "/tmp/member-removal-project",
      ownerHumanPrincipalId: "owner"
    });
    access.registerCanvasInternal({
      workspaceId: "w",
      projectId: "p",
      canvasId: "independent",
      packageDir: "/tmp/member-removal-project-independent",
      ownerHumanPrincipalId: "editor"
    });

    inWriteTransaction(database, () => {
      database
        .prepare(
          "UPDATE project_memberships SET revoked_at='2026-01-04',updated_at='2026-01-04',revision=revision+1 WHERE membership_id=?"
        )
        .run("m-member");
      database
        .prepare(
          "UPDATE workspace_memberships SET revoked_at='2026-01-04',updated_at='2026-01-04',revision=revision+1 WHERE workspace_id=? AND human_principal_id=?"
        )
        .run("w", "editor");
      access.synchronizeHumanMembershipOwnerInCallerTransaction({
        workspaceId: "w",
        projectId: "p",
        humanPrincipalId: "editor",
        transition: "member_removed",
        membershipRole: "member"
      });
    });

    expect(access.canvas("w", "p", "independent")?.owner).toBe("owner");
  });

  it("transfers independent canvas ownership through HumanIdentityRepository removal", async () => {
    const { database, access } = await openFixture();
    database.exec(`
      UPDATE workspace_principals SET created_at='2026-01-01T00:00:00.000Z' WHERE workspace_id='w';
      UPDATE workspace_memberships
      SET created_at='2026-01-01T00:00:00.000Z',updated_at='2026-01-01T00:00:00.000Z'
      WHERE workspace_id='w';
    `);
    database.exec(`
      INSERT INTO human_principals(human_principal_id,display_name,created_at) VALUES
        ('owner','Owner','2026-01-01T00:00:00.000Z'),('editor','Editor','2026-01-01T00:00:00.000Z');
      INSERT INTO project_memberships(
        membership_id,project_id,human_principal_id,role,revision,created_at,updated_at
      ) VALUES
        ('m-owner','p','owner','owner',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
        ('m-member','p','editor','member',1,'2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z');
      INSERT INTO legacy_project_workspace_mappings(
        legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at
      ) VALUES ('p','legacy-project:p','w','2026-01-01T00:00:00.000Z');
      INSERT INTO workspace_identity_migrations(
        migration_id,legacy_project_id,workspace_id,from_version,to_version,step,status,
        interruption_marker,authoritative_read_version,failure_code,updated_at
      ) VALUES(
        'identity-migration-p','p','w',0,1,'verify_cutover','completed',
        'read_cutover_complete','workspace-identity/v1',NULL,'2026-01-01T00:00:00.000Z'
      );
    `);
    access.registerProjectInternal({
      workspaceId: "w",
      projectId: "p",
      projectRoot: "/tmp/identity-removal-project",
      ownerHumanPrincipalId: "owner"
    });
    access.registerCanvasInternal({
      workspaceId: "w",
      projectId: "p",
      canvasId: "independent",
      packageDir: "/tmp/identity-removal-project-independent",
      ownerHumanPrincipalId: "editor"
    });
    const identity = new HumanIdentityRepository(database, () => new Date("2026-01-04T00:00:00Z"), {
      onMembershipTransitionInTransaction: ({ membership, principal, type }) => {
        access.synchronizeHumanMembershipOwnerInCallerTransaction({
          workspaceId: "w",
          projectId: membership.projectId,
          humanPrincipalId: principal.humanPrincipalId,
          transition: type,
          membershipRole: membership.role
        });
      }
    });

    expect(identity.removeMember("p", "editor").humanPrincipalId).toBe("editor");
    expect(access.canvas("w", "p", "independent")?.owner).toBe("owner");
  });
});

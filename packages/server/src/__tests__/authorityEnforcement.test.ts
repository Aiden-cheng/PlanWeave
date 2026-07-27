import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { AgentHostRepository } from "../hosts.js";
import { AuthorityRepository } from "../work/authorityRepository.js";
import { AuthorityService } from "../work/authorityService.js";
import {
  createAuthorityDispatchGate,
  DispatchAssignmentError
} from "../work/dispatchIntegration.js";
import { workItemPackageFactsSchema, type WorkItemRef } from "../work/schemas.js";

const databases: SqliteDatabase[] = [];
const now = () => new Date("2026-07-27T10:00:00.000Z");

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function fixture() {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  database.exec(`
    INSERT INTO workspaces(workspace_id,display_name,created_at)
      VALUES ('w','Workspace','2026-07-27T00:00:00.000Z');
    INSERT INTO human_principals(human_principal_id,display_name,created_at)
      VALUES ('owner','Owner','2026-07-27T00:00:00.000Z'),
             ('member','Member','2026-07-27T00:00:00.000Z');
    INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at)
      VALUES ('w','owner','Owner','2026-07-27T00:00:00.000Z',NULL),
             ('w','member','Member','2026-07-27T00:00:00.000Z',NULL);
    INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at)
      VALUES ('w','wm-owner','owner','owner',1,'2026-07-27T00:00:00.000Z','2026-07-27T00:00:00.000Z',NULL),
             ('w','wm-member','member','member',1,'2026-07-27T00:00:00.000Z','2026-07-27T00:00:00.000Z',NULL);
    INSERT INTO project_memberships(membership_id,project_id,human_principal_id,role,created_at,updated_at,revoked_at)
      VALUES ('pm-owner','p','owner','owner','2026-07-27T00:00:00.000Z','2026-07-27T00:00:00.000Z',NULL),
             ('pm-member','p','member','member','2026-07-27T00:00:00.000Z','2026-07-27T00:00:00.000Z',NULL);
    INSERT INTO legacy_project_workspace_mappings(legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at)
      VALUES ('p','legacy-project:p','w','2026-07-27T00:00:00.000Z');
  `);
  const access = new ProjectAccessRepository(database, now);
  access.registerProjectInternal({
    workspaceId: "w",
    projectId: "p",
    projectRoot: "/tmp/project-p",
    ownerHumanPrincipalId: "owner"
  });
  access.registerCanvasInternal({
    workspaceId: "w",
    projectId: "p",
    canvasId: "c",
    packageDir: "/tmp/project-p/canvas-c",
    ownerHumanPrincipalId: "owner"
  });
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const hosts = new AgentHostRepository(database, now);
  const host = hosts.registerWithCredential(
    "Host",
    `pw_host_${"a".repeat(43)}`,
    ["acp.codex"],
    1
  ).host;
  hosts.bindToWorkspace(host.id, "w");
  hosts.reportOnline(host.id, ["acp.codex"], 1);
  const repository = new AuthorityRepository(database, { clock: now });
  const packagePort = {
    resolveWorkItem(workItem: WorkItemRef) {
      return workItemPackageFactsSchema.parse(
        workItem.canvasId !== "c"
          ? {
              canvasId: workItem.canvasId,
              kind: workItem.kind,
              exists: false,
              ...(workItem.kind === "task"
                ? { taskId: workItem.taskId }
                : { blockRef: workItem.blockRef }),
              requiredCapabilities: []
            }
          : workItem.kind === "task"
            ? {
                canvasId: "c",
                kind: "task",
                taskId: workItem.taskId,
                exists: workItem.taskId === "T-001",
                requiredCapabilities: []
              }
            : {
                canvasId: "c",
                kind: "block",
                blockRef: workItem.blockRef,
                taskId: "T-001",
                blockType: "implementation",
                exists: workItem.blockRef === "T-001#B-001",
                requiredCapabilities: ["acp.codex"]
              }
      );
    }
  };
  const service = new AuthorityService({
    repository,
    packagePort,
    identity: new HumanIdentityRepository(database, now),
    access,
    workspaceIdentity,
    hosts,
    clock: now
  });
  const actor = {
    humanPrincipalId: "owner",
    displayName: "Owner",
    deviceCredentialId: "device-owner",
    projectId: "p",
    role: "owner" as const,
    membershipId: "pm-owner"
  };
  return { database, access, workspaceIdentity, hosts, host, repository, service, actor };
}

describe("separated assignment authorities", () => {
  it("mutates responsibility, reviewer, and Block execution target independently", async () => {
    const { service, actor, host } = await fixture();
    const taskScope = {
      kind: "task" as const,
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      taskId: "T-001"
    };
    expect(
      service.updateResponsibility(actor, {
        schemaVersion: "responsibility/v1",
        scope: taskScope,
        principal: { kind: "human", humanPrincipalId: "member" },
        expectedRevision: 0
      })
    ).toMatchObject({ revision: 1, principal: { humanPrincipalId: "member" } });
    expect(
      service.updateReviewer(actor, {
        schemaVersion: "review-assignment/v1",
        scope: taskScope,
        principal: { kind: "human", humanPrincipalId: "owner" },
        expectedRevision: 0
      })
    ).toMatchObject({ revision: 1, principal: { humanPrincipalId: "owner" } });
    expect(service.getResponsibility(actor, taskScope)).toMatchObject({
      revision: 1,
      principal: { humanPrincipalId: "member" }
    });

    const blockScope = {
      kind: "block" as const,
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      blockRef: "T-001#B-001"
    };
    expect(
      service.updateExecutionTarget(actor, {
        schemaVersion: "execution-target/v1",
        scope: blockScope,
        target: { kind: "exact_host", hostId: host.id },
        expectedRevision: 0
      })
    ).toMatchObject({ revision: 1, target: { kind: "exact_host", hostId: host.id } });
    expect(service.currentRevisions(actor, blockScope)).toEqual({
      responsibilityRevision: 0,
      reviewerRevision: 0,
      executionTargetRevision: 1
    });
    expect(() =>
      service.updateExecutionTarget(actor, {
        schemaVersion: "execution-target/v1",
        scope: taskScope,
        target: { kind: "automatic_host" },
        expectedRevision: 0
      })
    ).toThrow();
  });

  it("projects redacted work authority without coupling reviewer to Host execution", async () => {
    const { service, actor, host } = await fixture();
    const blockScope = {
      kind: "block" as const,
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      blockRef: "T-001#B-001"
    };
    service.updateResponsibility(actor, {
      schemaVersion: "responsibility/v1",
      scope: blockScope,
      principal: { kind: "human", humanPrincipalId: "member" },
      expectedRevision: 0
    });
    service.updateReviewer(actor, {
      schemaVersion: "review-assignment/v1",
      scope: blockScope,
      principal: { kind: "human", humanPrincipalId: "owner" },
      expectedRevision: 0
    });
    service.updateExecutionTarget(actor, {
      schemaVersion: "execution-target/v1",
      scope: blockScope,
      target: { kind: "exact_host", hostId: host.id },
      expectedRevision: 0
    });
    // Reviewer change must not rewrite execution target revision.
    service.updateReviewer(actor, {
      schemaVersion: "review-assignment/v1",
      scope: blockScope,
      principal: { kind: "human", humanPrincipalId: "member" },
      expectedRevision: 1
    });
    const projection = service.getWorkAuthorityProjection(actor, blockScope);
    expect(projection.responsibility.principal).toEqual({
      kind: "human",
      humanPrincipalId: "member"
    });
    expect(projection.reviewer.principal).toEqual({
      kind: "human",
      humanPrincipalId: "member"
    });
    expect(projection.executionTarget?.target).toEqual({
      kind: "exact_host",
      hostId: host.id
    });
    expect(projection.revisions).toEqual({
      responsibilityRevision: 1,
      reviewerRevision: 2,
      executionTargetRevision: 1
    });
    expect(projection.selectedHost?.availabilityReason).toBe("ready");
    expect(projection.selectedHost?.lease.status).toBe("none");
    expect(JSON.stringify(projection)).not.toMatch(/pw_|\/tmp|secret/i);
  });
});

describe("strict Host dispatch authority", () => {
  it("selects only an eligible workspace Host and rejects stale revisions", async () => {
    const { database, access, workspaceIdentity, hosts, host, repository } = await fixture();
    const scope = {
      kind: "block" as const,
      workspaceId: "w",
      projectId: "p",
      canvasId: "c",
      blockRef: "T-001#B-001"
    };
    repository.applyExecutionTarget({
      mutation: {
        schemaVersion: "execution-target/v1",
        scope,
        target: { kind: "exact_host", hostId: host.id },
        expectedRevision: 0
      },
      actor: { kind: "human", id: "owner" }
    });
    const gate = createAuthorityDispatchGate({
      repository,
      database,
      workspaceIdentity,
      hosts,
      access,
      hostOfflineAfterMs: 60_000,
      clock: now
    });
    expect(
      gate.resolve({
        projectId: "p",
        canvasId: "c",
        blockRef: "T-001#B-001",
        requiredCapabilities: ["acp.codex"],
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        expectedExecutionTargetRevision: 1
      })
    ).toMatchObject({ selection: "exact", preferredHostId: host.id });

    repository.applyReviewer({
      mutation: {
        schemaVersion: "review-assignment/v1",
        scope,
        principal: { kind: "human", humanPrincipalId: "owner" },
        expectedRevision: 0
      },
      actor: { kind: "human", id: "owner" }
    });
    expect(() =>
      gate.resolve({
        projectId: "p",
        canvasId: "c",
        blockRef: "T-001#B-001",
        requiredCapabilities: ["acp.codex"],
        expectedResponsibilityRevision: 0,
        expectedReviewerRevision: 0,
        expectedExecutionTargetRevision: 1
      })
    ).toThrow(DispatchAssignmentError);
  });
});

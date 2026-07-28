import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { rm } from "node:fs/promises";
import {
  canonicalContentVersionDigestPayload,
  type CompleteContentVersion
} from "@planweave-ai/collaboration-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { handleContentVersionHttpRequest } from "../canvas/contentVersionHttp.js";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import { ContentVersionService } from "../canvas/contentVersionService.js";
import { HumanIdentityRepository, HumanMembershipService } from "../identity/index.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const servers: Server[] = [];
const databases: SqliteDatabase[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
function content(): CompleteContentVersion {
  const members = [
    {
      kind: "desktop_layout" as const,
      path: "desktop/layout.json",
      content: JSON.stringify({
        version: "desktop-layout/v1",
        projectId: "p",
        nodes: [],
        updatedAt: "2026-01-01T00:00:00.000Z"
      })
    },
    {
      kind: "manifest" as const,
      path: "manifest.json",
      content: JSON.stringify({
        version: "plan-package/v1",
        project: { title: "Plan", description: "" },
        execution: { parallel: { enabled: false, maxConcurrent: 1 } },
        review: { maxFeedbackCycles: 1, completionPolicy: "strict" },
        executors: {},
        nodes: [
          {
            id: "T-001",
            type: "task",
            title: "Task",
            prompt: "nodes/T-001/prompt.md",
            acceptance: ["done"],
            blocks: [
              {
                id: "B-001",
                type: "implementation",
                title: "Block",
                prompt: "nodes/T-001/blocks/B-001.prompt.md"
              }
            ]
          }
        ],
        edges: []
      })
    },
    { kind: "task_prompt" as const, path: "nodes/T-001/prompt.md", content: "# Task\n" },
    {
      kind: "block_prompt" as const,
      path: "nodes/T-001/blocks/B-001.prompt.md",
      content: "# Block\n"
    }
  ]
    .map((member) => ({
      ...member,
      digestSha256: digest(member.content),
      sizeBytes: Buffer.byteLength(member.content, "utf8")
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const totalBytes = members.reduce((sum, member) => sum + member.sizeBytes, 0);
  return {
    members,
    totalBytes,
    canonicalDigest: digest(
      canonicalContentVersionDigestPayload({ members, totalBytes, canonicalDigest: "0".repeat(64) })
    )
  };
}

async function fixture() {
  const workspace = await createTestWorkspace();
  directories.push(workspace.home, workspace.root);
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  database.exec(`
    INSERT INTO workspaces(workspace_id,display_name,created_at) VALUES ('w','Workspace','2026-01-01');
    INSERT INTO legacy_project_workspace_mappings(legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at) VALUES ('p','legacy-project:p','w','2026-01-01');
    INSERT INTO workspace_identity_migrations(
      migration_id,legacy_project_id,workspace_id,from_version,to_version,step,status,
      interruption_marker,authoritative_read_version,failure_code,updated_at
    ) VALUES ('identity-p','p','w',0,1,'verify_cutover','completed','read_cutover_complete','workspace-identity/v1',NULL,'2026-01-01');
  `);
  const identity = new HumanIdentityRepository(database);
  const membership = new HumanMembershipService({
    repository: identity,
    projectAuthority: { hasProject: (id) => id === "p" }
  });
  const owner = membership.bootstrapOwner("p", { humanPrincipalId: "owner", displayName: "Owner" });
  const member = identity.createInvitation({ projectId: "p", createdByHumanPrincipalId: "owner" });
  const memberJoin = identity.consumeInvitation({
    invitationToken: member.invitationToken,
    projectId: "p",
    displayName: "Member"
  });
  database.exec(`
    INSERT OR IGNORE INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES
      ('w','owner','Owner','2026-01-01',NULL);
    INSERT OR IGNORE INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES
      ('w','wm-owner','owner','owner',1,'2026-01-01','2026-01-01',NULL);
  `);
  database
    .prepare(
      "INSERT OR IGNORE INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES(?,?,?,?,NULL)"
    )
    .run(
      "w",
      memberJoin.principal.humanPrincipalId,
      memberJoin.principal.displayName,
      "2026-01-01"
    );
  database
    .prepare(
      "INSERT OR IGNORE INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES(?,?,?,?,?,?,?,NULL)"
    )
    .run(
      "w",
      "wm-member",
      memberJoin.principal.humanPrincipalId,
      "member",
      1,
      "2026-01-01",
      "2026-01-01"
    );
  const access = new ProjectAccessRepository(database);
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
    ownerHumanPrincipalId: "owner"
  });
  access.markCanvasCutover("w", "p", "default");
  access.finalizeProjectCutover("w", "p");
  access.grant({
    workspaceId: "w",
    projectId: "p",
    canvasId: "default",
    humanPrincipalId: memberJoin.principal.humanPrincipalId,
    role: "viewer",
    grantedBy: { kind: "human", id: "owner" }
  });
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const service = new ContentVersionService({
    repository: new ContentVersionRepository(database),
    access,
    workspaceIdentity
  });
  const server = createServer((request, response) => {
    void handleContentVersionHttpRequest(request, response, {
      service,
      repository: identity,
      workspaceIdentity,
      projectAuthority: {
        hasProject: (id) => id === "p",
        hasScope: (scope) =>
          scope.workspaceId === "w" &&
          scope.projectId === "p" &&
          (scope.canvasId === undefined || scope.canvasId === "default")
      },
      allowInsecureDevelopment: true
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address missing");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    database,
    ownerToken: owner.deviceToken,
    memberToken: memberJoin.deviceToken
  };
}

function headers(token: string) {
  return { "content-type": "application/json", authorization: `Bearer ${token}` };
}

describe("content version HTTP boundary", () => {
  it("authorizes head discovery, bounded fetch/ack, revocation, and redacted failures", async () => {
    const { origin, database, ownerToken, memberToken } = await fixture();
    const initial = await fetch(
      `${origin}/api/v1/projects/p/canvases/default/content/initial-publish`,
      {
        method: "POST",
        headers: headers(ownerToken),
        body: JSON.stringify({
          expectedHeadRevision: 0,
          expectedHeadVersionId: null,
          content: content()
        })
      }
    );
    expect(initial.status).toBe(201);
    const published = (await initial.json()) as { version: { completed: unknown } };
    const discovery = await fetch(`${origin}/api/v1/projects/p/canvases/default/content/head`, {
      method: "POST",
      headers: headers(memberToken),
      body: JSON.stringify({ localReplica: null, knownRevision: null })
    });
    expect(discovery.status).toBe(200);
    const discovered = (await discovery.json()) as {
      authoritativeHead: { content: unknown };
      replicaStatus: string;
      recoveryAction: string;
    };
    expect(discovered).toMatchObject({
      replicaStatus: "snapshot_required",
      recoveryAction: "fetch_head",
      canPublishInitial: false,
      canMaterialize: true,
      canRecover: true,
      authoritativeHead: { content: published.version.completed }
    });
    expect(JSON.stringify(discovered)).not.toContain("members");
    expect(JSON.stringify(discovered)).not.toContain("packageDir");
    const fetched = await fetch(`${origin}/api/v1/projects/p/canvases/default/content/fetch`, {
      method: "POST",
      headers: headers(memberToken),
      body: JSON.stringify({ content: published.version.completed })
    });
    expect(fetched.status).toBe(200);
    const acknowledged = await fetch(
      `${origin}/api/v1/projects/p/canvases/default/content/acknowledgements`,
      {
        method: "POST",
        headers: headers(memberToken),
        body: JSON.stringify({ content: published.version.completed })
      }
    );
    expect(acknowledged.status).toBe(200);
    const inSync = await fetch(`${origin}/api/v1/projects/p/canvases/default/content/head`, {
      method: "POST",
      headers: headers(memberToken),
      body: JSON.stringify({ localReplica: published.version.completed, knownRevision: 1 })
    });
    expect(await inSync.json()).toMatchObject({
      replicaStatus: "in_sync",
      recoveryAction: "none",
      lastAcknowledgement: { content: published.version.completed }
    });
    const crossScope = await fetch(`${origin}/api/v1/projects/p/canvases/other/content/fetch`, {
      method: "POST",
      headers: headers(ownerToken),
      body: JSON.stringify({ content: published.version.completed })
    });
    expect(crossScope.status).toBe(403);
    expect(JSON.stringify(await crossScope.json())).not.toContain("package");
    const crossScopeDiscovery = await fetch(
      `${origin}/api/v1/projects/p/canvases/other/content/head`,
      {
        method: "POST",
        headers: headers(memberToken),
        body: JSON.stringify({ localReplica: null, knownRevision: null })
      }
    );
    expect(crossScopeDiscovery.status).toBe(403);
    database
      .prepare(
        "UPDATE human_device_credentials SET revoked_at='2026-01-03T00:00:00.000Z' WHERE device_credential_id=(SELECT device_credential_id FROM human_device_credentials WHERE human_principal_id='owner')"
      )
      .run();
    const revoked = await fetch(`${origin}/api/v1/projects/p/canvases/default/content/fetch`, {
      method: "POST",
      headers: headers(ownerToken),
      body: JSON.stringify({ content: published.version.completed })
    });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual({ error: "unauthorized" });
  });
});

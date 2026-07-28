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
    { kind: "desktop_layout" as const, path: "desktop/layout.json", content: "{}" },
    { kind: "manifest" as const, path: "manifest.json", content: "{}" }
  ].map((member) => ({ ...member, digestSha256: digest(member.content), sizeBytes: 2 }));
  const totalBytes = 4;
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
      ('w','owner','Owner','2026-01-01',NULL),('w','member','Member','2026-01-01',NULL);
    INSERT OR IGNORE INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES
      ('w','wm-owner','owner','owner',1,'2026-01-01','2026-01-01',NULL),('w','wm-member','member','member',1,'2026-01-01','2026-01-01',NULL);
  `);
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
    humanPrincipalId: "member",
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
      projectAuthority: { hasProject: (id) => id === "p" },
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
  it("authorizes bounded publish, fetch/ack, revocation, and redacted failures", async () => {
    const { origin, database, ownerToken } = await fixture();
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
    const fetched = await fetch(`${origin}/api/v1/projects/p/canvases/default/content/fetch`, {
      method: "POST",
      headers: headers(ownerToken),
      body: JSON.stringify({ content: published.version.completed })
    });
    expect(fetched.status).toBe(200);
    const acknowledged = await fetch(
      `${origin}/api/v1/projects/p/canvases/default/content/acknowledgements`,
      {
        method: "POST",
        headers: headers(ownerToken),
        body: JSON.stringify({ content: published.version.completed })
      }
    );
    expect(acknowledged.status).toBe(200);
    const crossScope = await fetch(`${origin}/api/v1/projects/p/canvases/other/content/fetch`, {
      method: "POST",
      headers: headers(ownerToken),
      body: JSON.stringify({ content: published.version.completed })
    });
    expect(crossScope.status).toBe(403);
    expect(JSON.stringify(await crossScope.json())).not.toContain("package");
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

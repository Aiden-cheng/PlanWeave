import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  canonicalContentVersionDigestPayload,
  type CompleteContentVersion
} from "@planweave-ai/collaboration-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ContentVersionRepository } from "../canvas/contentVersionRepository.js";
import { ContentVersionService } from "../canvas/contentVersionService.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations, latestCentralSchemaVersion } from "../migrations.js";
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

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function content(): CompleteContentVersion {
  const members = [
    { kind: "desktop_layout" as const, path: "desktop/layout.json", content: "{}" },
    { kind: "manifest" as const, path: "manifest.json", content: "{}" },
    { kind: "task_prompt" as const, path: "nodes/T-001/prompt.md", content: "# Task\n" }
  ].map((member) => ({
    ...member,
    digestSha256: sha256(member.content),
    sizeBytes: Buffer.byteLength(member.content)
  }));
  const totalBytes = members.reduce((sum, member) => sum + member.sizeBytes, 0);
  const withoutDigest = { members, totalBytes };
  return {
    ...withoutDigest,
    canonicalDigest: sha256(
      canonicalContentVersionDigestPayload({ ...withoutDigest, canonicalDigest: "0".repeat(64) })
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
    INSERT INTO workspace_principals(workspace_id,human_principal_id,display_name,created_at,revoked_at) VALUES
      ('w','owner','Owner','2026-01-01',NULL),('w','member','Member','2026-01-01',NULL);
    INSERT INTO workspace_memberships(workspace_id,membership_id,human_principal_id,role,revision,created_at,updated_at,revoked_at) VALUES
      ('w','m-owner','owner','owner',1,'2026-01-01','2026-01-01',NULL),('w','m-member','member','member',1,'2026-01-01','2026-01-01',NULL);
    INSERT INTO legacy_project_workspace_mappings(legacy_project_id,normalized_legacy_project_identity,workspace_id,mapped_at)
      VALUES ('p','legacy-project:p','w','2026-01-01');
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
    ownerHumanPrincipalId: "owner"
  });
  access.markCanvasCutover("w", "p", "default");
  access.finalizeProjectCutover("w", "p");
  access.grant({
    workspaceId: "w",
    projectId: "p",
    canvasId: "default",
    humanPrincipalId: "member",
    role: "editor",
    grantedBy: { kind: "human", id: "owner" }
  });
  const repository = new ContentVersionRepository(
    database,
    () => new Date("2026-01-02T00:00:00.000Z")
  );
  const service = new ContentVersionService({
    repository,
    access,
    workspaceIdentity: new WorkspaceIdentityRepository(database)
  });
  return { database, repository, service };
}

const owner = {
  humanPrincipalId: "owner",
  displayName: "Owner",
  deviceCredentialId: "device-owner",
  projectId: "p",
  role: "owner" as const,
  membershipId: "m-owner"
};
const member = {
  humanPrincipalId: "member",
  displayName: "Member",
  deviceCredentialId: "device-member",
  projectId: "p",
  role: "member" as const,
  membershipId: "m-member"
};

describe("authoritative content version repository", () => {
  it("persists a verified owner-only initial version before creating the first head", async () => {
    const { repository, service } = await fixture();
    expect(latestCentralSchemaVersion).toBe(33);
    const result = service.publishInitial(owner, {
      projectId: "p",
      canvasId: "default",
      expectedHeadRevision: 0,
      expectedHeadVersionId: null,
      content: content()
    });
    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") throw new Error("expected published content");
    expect(result.head.content).toEqual(result.version.completed);
    expect(
      repository.readVersion(
        { workspaceId: "w", projectId: "p", canvasId: "default" },
        result.version.completed
      ).content.members
    ).toHaveLength(3);
    expect(
      repository.journalAfter({ workspaceId: "w", projectId: "p", canvasId: "default" }, 0)
    ).toHaveLength(1);
  });

  it("fails closed for malformed digest, non-owner publication, and first-head races", async () => {
    const { repository, service } = await fixture();
    const invalid = content();
    invalid.canonicalDigest = "0".repeat(64);
    expect(
      service.publishInitial(owner, {
        projectId: "p",
        canvasId: "default",
        expectedHeadRevision: 0,
        expectedHeadVersionId: null,
        content: invalid
      })
    ).toMatchObject({ outcome: "rejected", reason: "content_verification_failed", head: null });
    expect(repository.head({ workspaceId: "w", projectId: "p", canvasId: "default" })).toBeNull();
    expect(
      service.publishInitial(member, {
        projectId: "p",
        canvasId: "default",
        expectedHeadRevision: 0,
        expectedHeadVersionId: null,
        content: content()
      })
    ).toMatchObject({ outcome: "rejected", reason: "authorization_revoked", head: null });
    const first = service.publishInitial(owner, {
      projectId: "p",
      canvasId: "default",
      expectedHeadRevision: 0,
      expectedHeadVersionId: null,
      content: content()
    });
    expect(first.outcome).toBe("published");
    expect(
      service.publishInitial(owner, {
        projectId: "p",
        canvasId: "default",
        expectedHeadRevision: 0,
        expectedHeadVersionId: null,
        content: content()
      })
    ).toMatchObject({ outcome: "rejected", reason: "head_already_exists", head: null });
  });

  it("serves only scoped authorized content and records idempotent device acknowledgements", async () => {
    const { database, service } = await fixture();
    const initial = service.publishInitial(owner, {
      projectId: "p",
      canvasId: "default",
      expectedHeadRevision: 0,
      expectedHeadVersionId: null,
      content: content()
    });
    if (initial.outcome !== "published") throw new Error("expected published content");
    expect(
      service.fetch(member, {
        projectId: "p",
        canvasId: "default",
        content: initial.version.completed
      }).completed
    ).toEqual(initial.version.completed);
    expect(() =>
      service.fetch(member, {
        projectId: "p",
        canvasId: "other",
        content: initial.version.completed
      })
    ).toThrow("content_fetch_forbidden");
    service.acknowledge(member, "p", "default", { content: initial.version.completed });
    service.acknowledge(member, "p", "default", { content: initial.version.completed });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM canvas_content_acknowledgements").get()?.count
    ).toBe(1);
  });

  it("rejects a tampered immutable member on read rather than returning mutable cache content", async () => {
    const { database, service } = await fixture();
    const initial = service.publishInitial(owner, {
      projectId: "p",
      canvasId: "default",
      expectedHeadRevision: 0,
      expectedHeadVersionId: null,
      content: content()
    });
    if (initial.outcome !== "published") throw new Error("expected published content");
    database
      .prepare(
        "UPDATE canvas_content_version_members SET content='[]' WHERE version_id=? AND member_path='manifest.json'"
      )
      .run(initial.version.completed.versionId);
    expect(() =>
      service.fetch(member, {
        projectId: "p",
        canvasId: "default",
        content: initial.version.completed
      })
    ).toThrow("content_version_member_digest_mismatch");
  });

  it("fails closed when retained journal rows cannot reach the authoritative head", async () => {
    const { database, repository, service } = await fixture();
    const initial = service.publishInitial(owner, {
      projectId: "p",
      canvasId: "default",
      expectedHeadRevision: 0,
      expectedHeadVersionId: null,
      content: content()
    });
    if (initial.outcome !== "published") throw new Error("expected published content");
    database
      .prepare(
        "DELETE FROM canvas_content_journal WHERE workspace_id='w' AND project_id='p' AND canvas_id='default' AND revision=1"
      )
      .run();
    expect(() =>
      repository.journalAfter({ workspaceId: "w", projectId: "p", canvasId: "default" }, 0)
    ).toThrow("content_version_journal_gap");
  });
});

import { describe, expect, it } from "vitest";
import {
  assertFixturesDoNotShareAcceptanceState,
  clearIsolatedCanvasContentHead,
  configureWorkspaceAccess,
  deviceToken,
  discoverContentHead,
  issueDeviceSetupCode,
  postJson,
  redeemDesktop,
  setupSelfHostedTwoClientFixture
} from "./support/selfHostedTwoClientE2E.js";

async function ownerSession(fixture: Awaited<ReturnType<typeof setupSelfHostedTwoClientFixture>>) {
  const owner = await redeemDesktop({
    home: fixture.home,
    name: "Publish Owner",
    origin: fixture.origin,
    setupCode: (await issueDeviceSetupCode(fixture.origin, fixture.workspaceId)).setupCode
  });
  const member = await redeemDesktop({
    home: fixture.home,
    name: "Publish Member",
    origin: fixture.origin,
    setupCode: (await issueDeviceSetupCode(fixture.origin, fixture.workspaceId)).setupCode
  });
  const ownerToken = await deviceToken(owner);
  const ownerId = owner.view.profile?.profileId;
  const memberId = member.view.profile?.profileId;
  const ownerCredential = await owner.vault.getMetadata(ownerId ?? "");
  const memberCredential = await member.vault.getMetadata(memberId ?? "");
  if (!ownerCredential?.humanPrincipalId || !memberCredential?.humanPrincipalId) {
    throw new Error("workspace_principal_missing");
  }
  const configured = await configureWorkspaceAccess({
    databasePath: fixture.databasePath,
    workspaceId: fixture.workspaceId,
    projectId: fixture.projectId,
    ownerId: ownerCredential.humanPrincipalId,
    memberId: memberCredential.humanPrincipalId
  });
  return { ownerToken, configured };
}

describe("self-hosted content initial-publish isolation", () => {
  it("publishes once on an empty head and rejects a second initial publish", async () => {
    const fixture = await setupSelfHostedTwoClientFixture();
    const { ownerToken, configured } = await ownerSession(fixture);
    try {
      // Composition bootstraps trusted canvases. Clear only this isolated test DB head so
      // HTTP initial-publish exercises a true empty-head path without sharing user state.
      await clearIsolatedCanvasContentHead({
        databasePath: fixture.databasePath,
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        canvasId: "default"
      });
      const emptyHead = await discoverContentHead(
        fixture.origin,
        fixture.projectId,
        "default",
        ownerToken
      );
      expect(emptyHead.status).toBe(200);
      expect(emptyHead.body.canPublishInitial).toBe(true);
      expect(emptyHead.body.authoritativeHead).toBeNull();

      const first = await postJson(
        fixture.origin,
        `/api/v1/projects/${encodeURIComponent(fixture.projectId)}/canvases/default/content/initial-publish`,
        ownerToken,
        {
          expectedHeadRevision: 0,
          expectedHeadVersionId: null,
          content: fixture.initialContent
        }
      );
      expect(first.status).toBe(201);
      const published = (await first.json()) as {
        outcome: string;
        head: { revision: number; content: { canonicalDigest: string } };
      };
      expect(published).toMatchObject({
        outcome: "published",
        head: {
          revision: 1,
          content: { canonicalDigest: fixture.initialContent.canonicalDigest }
        }
      });

      const after = await discoverContentHead(
        fixture.origin,
        fixture.projectId,
        "default",
        ownerToken
      );
      expect(after.body.canPublishInitial).toBe(false);
      expect(after.body.authoritativeHead?.revision).toBe(1);

      const second = await postJson(
        fixture.origin,
        `/api/v1/projects/${encodeURIComponent(fixture.projectId)}/canvases/default/content/initial-publish`,
        ownerToken,
        {
          expectedHeadRevision: 0,
          expectedHeadVersionId: null,
          content: fixture.initialContent
        }
      );
      expect(second.status).toBe(409);
      await expect(second.json()).resolves.toEqual({
        outcome: "rejected",
        reason: "head_already_exists",
        retryable: false,
        detail: "initial_publish_already_completed",
        head: null
      });
    } finally {
      configured.database.close();
    }
  });

  it("does not share database, workspace, project, or canvas head across fixtures", async () => {
    const first = await setupSelfHostedTwoClientFixture();
    const second = await setupSelfHostedTwoClientFixture();
    assertFixturesDoNotShareAcceptanceState(first, second);

    const left = await ownerSession(first);
    const right = await ownerSession(second);
    try {
      const leftHead = await discoverContentHead(
        first.origin,
        first.projectId,
        "default",
        left.ownerToken
      );
      const rightHead = await discoverContentHead(
        second.origin,
        second.projectId,
        "default",
        right.ownerToken
      );
      expect(leftHead.body.authoritativeHead?.content.canonicalDigest).toBe(
        first.initialContent.canonicalDigest
      );
      expect(rightHead.body.authoritativeHead?.content.canonicalDigest).toBe(
        second.initialContent.canonicalDigest
      );
      // Distinct project scopes even when content digests match for identical fixtures.
      expect(leftHead.body.authoritativeHead).not.toEqual(rightHead.body.authoritativeHead);
    } finally {
      left.configured.database.close();
      right.configured.database.close();
    }
  });
});

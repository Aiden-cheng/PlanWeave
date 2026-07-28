import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AuthoritativeContentVersion,
  CompleteContentVersion,
  ContentVersionAcknowledgement,
  ContentVersionAuthorityDiscoveryResult,
  FirstContentVersionPublishResult
} from "@planweave-ai/collaboration-contracts";
import {
  completedContentVersionRefSchema,
  type CompletedContentVersionRef
} from "@planweave-ai/collaboration-contracts";
import { ContentVersionFacade } from "../main/collaboration/ContentVersionFacade.js";
import { CollaborationClientError } from "../main/collaboration/collaborationErrors.js";
import type { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";

const directories: string[] = [];
const originalHome = process.env.PLANWEAVE_HOME;
const originalSettingsFile = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  if (originalSettingsFile === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = originalSettingsFile;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function versionRef(content: CompleteContentVersion): CompletedContentVersionRef {
  return completedContentVersionRefSchema.parse({
    versionId: `version-${content.canonicalDigest}`,
    canonicalDigest: content.canonicalDigest,
    verification: "complete"
  });
}

function acknowledgement(projectId: string, content: CompletedContentVersionRef): ContentVersionAcknowledgement {
  return {
    scope: { workspaceId: "workspace-test", projectId, canvasId: "default" },
    deviceSessionId: "device-session-test",
    content,
    acknowledgedAt: "2026-07-28T00:00:00.000Z"
  };
}

function head(projectId: string, content: CompletedContentVersionRef) {
  return {
    schemaVersion: "content-version/v1" as const,
    scope: { workspaceId: "workspace-test", projectId, canvasId: "default" },
    revision: 1,
    content,
    advancedAt: "2026-07-28T00:00:00.000Z"
  };
}

function fakeClient(projectId: string) {
  let published: AuthoritativeContentVersion | null = null;
  const discoverContentAuthority = vi.fn(async (input: {
    localReplica: CompletedContentVersionRef | null;
  }): Promise<ContentVersionAuthorityDiscoveryResult> => {
    if (!published) {
      return {
        authoritativeHead: null,
        localReplica: input.localReplica,
        lastAcknowledgement: null,
        replicaStatus: "snapshot_required",
        recoveryAction: "await_initial_publish",
        canPublishInitial: true,
        canMaterialize: false,
        canRecover: true
      };
    }
    return {
      authoritativeHead: head(projectId, published.completed),
      localReplica: input.localReplica,
      lastAcknowledgement: acknowledgement(projectId, published.completed),
      replicaStatus: "in_sync",
      recoveryAction: "none",
      canPublishInitial: false,
      canMaterialize: true,
      canRecover: true
    };
  });
  const publishInitialContent = vi.fn(async (input: { content: CompleteContentVersion }): Promise<FirstContentVersionPublishResult> => {
    const completed = versionRef(input.content);
    published = {
      schemaVersion: "content-version/v1",
      scope: { workspaceId: "workspace-test", projectId, canvasId: "default" },
      content: input.content,
      completed,
      createdAt: "2026-07-28T00:00:00.000Z",
      createdBy: { kind: "human", id: "human-owner", displayName: "Owner" }
    };
    return { outcome: "published", version: published, head: head(projectId, completed) };
  });
  const fetchContentVersion = vi.fn(async (): Promise<AuthoritativeContentVersion> => {
    if (!published) throw new Error("content_not_published");
    return published;
  });
  const acknowledgeContentVersion = vi.fn(async (input: { content: CompletedContentVersionRef }) =>
    acknowledgement(projectId, input.content)
  );
  return {
    client: {
      projectId,
      discoverContentAuthority,
      publishInitialContent,
      fetchContentVersion,
      acknowledgeContentVersion
    } as unknown as CollaborationClient,
    calls: { discoverContentAuthority, publishInitialContent, fetchContentVersion, acknowledgeContentVersion }
  };
}

describe("ContentVersionFacade", () => {
  it("publishes local-only content, discovers the head, materializes it, and acknowledges it", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id);
    const facade = new ContentVersionFacade(() => fake.client);

    await expect(facade.bind({ canvasId: "default" })).resolves.toMatchObject({
      authoritativeHead: null,
      replicaStatus: "snapshot_required",
      canPublishInitial: true
    });
    await expect(facade.publishInitial()).resolves.toMatchObject({
      replicaStatus: "in_sync",
      canMaterialize: true
    });
    await expect(facade.materializeHead()).resolves.toMatchObject({ replicaStatus: "in_sync" });

    expect(fake.calls.publishInitialContent).toHaveBeenCalledWith(expect.objectContaining({
      canvasId: "default",
      content: expect.objectContaining({ canonicalDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    }));
    expect(fake.calls.discoverContentAuthority).toHaveBeenCalledWith(expect.objectContaining({
      canvasId: "default",
      localReplica: expect.objectContaining({ verification: "complete" })
    }));
    expect(fake.calls.fetchContentVersion).toHaveBeenCalledWith(expect.objectContaining({ canvasId: "default" }));
    expect(fake.calls.acknowledgeContentVersion).toHaveBeenCalledTimes(2);
  });

  it("keeps a rejected initial publish redacted and typed as a boundary failure", async () => {
    const workspace = await createTestWorkspace();
    directories.push(workspace.home, workspace.root);
    const fake = fakeClient(workspace.init.workspace.id);
    fake.client.publishInitialContent = vi.fn(async () => ({
      outcome: "rejected" as const,
      reason: "authorization_revoked" as const,
      retryable: false,
      detail: "owner access revoked",
      head: null
    }));
    const facade = new ContentVersionFacade(() => fake.client);
    await facade.bind({ canvasId: "default" });

    await expect(facade.publishInitial()).rejects.toMatchObject({
      name: "CollaborationClientError",
      code: "content_initial_publish_authorization_revoked",
      retryable: false
    });
  });

  it("fails closed while disconnected before accepting a renderer canvas input", async () => {
    const facade = new ContentVersionFacade(() => null);

    await expect(facade.bind({ canvasId: "default" })).rejects.toBeInstanceOf(CollaborationClientError);
    await expect(facade.bind({ canvasId: "default" })).rejects.toMatchObject({
      code: "collaboration_content_offline",
      retryable: true
    });
  });
});

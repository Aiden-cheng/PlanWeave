/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  acquireCollaborationReadModelController,
  resetCollaborationReadModelHubForTests
} from "../renderer/collaboration/collaborationReadModelHub";
import { resetCommentDraftStoreForTests } from "../renderer/collaboration/commentDraftStore";
import type { CollaborationReadBridgePort } from "../renderer/collaboration/CollaborationReadModelController";
import { useCommentsPanelController } from "../renderer/hooks/useCommentsPanelController";
import { useActivityPanelController } from "../renderer/hooks/useActivityPanelController";
import { createTranslator } from "../renderer/i18n";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";

const taskItem: WorkItemRef = { kind: "task", canvasId: "canvas-1", taskId: "T-1" };

function connectedStatus(): CollaborationStatus {
  return {
    profiles: [
      {
        profileId: "profile-1",
        displayName: "Demo",
        serverBaseUrl: "https://example.test",
        projectId: "project-1",
        allowInsecureTransport: false,
        hasDeviceCredential: true,
        deviceCredentialPersistence: "persisted",
        deviceCredentialId: "device-1",
        humanPrincipalId: "human-1",
        updatedAt: "2030-01-01T00:00:00.000Z"
      }
    ],
    activeProfileId: "profile-1",
    credentialStorage: "available",
    nonPersistenceWarning: null,
    session: {
      phase: "connected",
      activeProfileId: "profile-1",
      detail: null,
      lastErrorCode: null,
      lastErrorMessage: null
    },
    updatedAt: "2030-01-01T00:00:00.000Z",
    workspaceConnection: {
      schemaVersion: "workspace-setup/v1",
      status: "local_only",
      profile: null,
      workspaceId: null,
      workspaceDisplayName: null,
      connectedAt: null,
      error: null
    },
    workspacePicker: { schemaVersion: "workspace-setup/v1", items: [], nextCursor: null }
  };
}

function commentProjection(id: string, body: string, revision = 1) {
  return {
    commentId: id,
    projectId: "project-1",
    workItem: taskItem,
    author: {
      humanPrincipalId: "human-1",
      displayName: "Ada",
      membershipActive: true
    },
    body,
    bodyFormat: "markdown" as const,
    revision,
    createdAt: `2030-01-01T00:00:0${id.slice(-1)}.000Z`,
    updatedAt: `2030-01-01T00:00:0${id.slice(-1)}.000Z`,
    tombstoned: false,
    attachments: [],
    workItemPresence: "present" as const
  };
}

function createApi() {
  const status = connectedStatus();
  const listComments = vi.fn().mockImplementation(async (query: { cursor?: unknown }) => {
    if (query?.cursor) {
      return {
        items: [commentProjection("comment-0", "older")],
        nextCursor: null
      };
    }
    return {
      items: [commentProjection("comment-1", "first")],
      nextCursor: { createdAt: "2030-01-01T00:00:01.000Z", commentId: "comment-1" }
    };
  });
  const listActivity = vi.fn().mockImplementation(async (query: { cursor?: unknown }) => {
    if (query?.cursor) {
      return { items: [], nextCursor: null };
    }
    return {
      items: [
        {
          activityId: "act-1",
          projectId: "project-1",
          type: "comment_created",
          source: { kind: "comment", sourceId: "comment-1" },
          summary: { headline: "Ada commented", commentId: "comment-1", workItem: taskItem },
          subjects: [{ kind: "human", humanPrincipalId: "human-1", displayName: "Ada" }],
          workItem: taskItem,
          occurredAt: "2030-01-01T00:00:01.000Z"
        }
      ],
      nextCursor: { occurredAt: "2030-01-01T00:00:01.000Z", activityId: "act-1" }
    };
  });

  const createComment = vi.fn().mockResolvedValue(commentProjection("comment-2", "new", 1));
  const editComment = vi.fn().mockResolvedValue(commentProjection("comment-1", "edited", 2));
  const tombstoneComment = vi.fn().mockResolvedValue({
    ...commentProjection("comment-1", "first", 3),
    body: null,
    tombstoned: true,
    tombstonedAt: "2030-01-01T00:05:00.000Z"
  });
  const readCommentAttachment = vi.fn().mockResolvedValue({
    digestSha256: "a".repeat(64),
    mediaType: "image/png",
    sizeBytes: 4,
    bodyBase64: "iVBORw=="
  });

  const api = {
    getCollaborationStatus: vi.fn().mockResolvedValue(status),
    listCollaborationMembers: vi.fn().mockResolvedValue({
      items: [
        {
          membershipId: "m-1",
          projectId: "project-1",
          humanPrincipalId: "human-1",
          displayName: "Ada",
          role: "owner",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z"
        }
      ],
      nextCursor: null
    }),
    listCollaborationAssignments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationEligibleAssignees: vi.fn().mockResolvedValue({
      workItem: taskItem,
      humans: [],
      hosts: [],
      nextHumanCursor: null,
      nextHostCursor: null
    }),
    listCollaborationComments: listComments,
    listCollaborationActivity: listActivity,
    updateCollaborationAssignment: vi.fn(),
    createCollaborationComment: createComment,
    editCollaborationComment: editComment,
    tombstoneCollaborationComment: tombstoneComment,
    createCollaborationPendingAttachment: vi.fn(),
    uploadCollaborationPendingAttachment: vi.fn(),
    finalizeCollaborationPendingAttachment: vi.fn(),
    readCollaborationCommentAttachment: readCommentAttachment,
    onCollaborationStatusChanged: vi.fn(() => () => undefined),
    onCollaborationObserverSignal: vi.fn(() => () => undefined)
  } as unknown as PlanWeaveCollaborationApi & CollaborationReadBridgePort;

  return {
    api,
    listComments,
    listActivity,
    createComment,
    editComment,
    tombstoneComment,
    readCommentAttachment
  };
}

afterEach(() => {
  resetCollaborationReadModelHubForTests();
  resetCommentDraftStoreForTests();
  vi.restoreAllMocks();
});

describe("useCommentsPanelController", () => {
  it("binds an idle secondary-window hub to the connected profile", async () => {
    const { api } = createApi();

    renderHook(() =>
      useCommentsPanelController({
        workItem: taskItem,
        open: true,
        api,
        t: createTranslator("en")
      })
    );

    await waitFor(() => {
      expect(api.listCollaborationMembers).toHaveBeenCalled();
      expect(api.listCollaborationAssignments).toHaveBeenCalled();
      expect(api.listCollaborationActivity).toHaveBeenCalled();
    });
  });

  it("loads pages, preserves drafts by work item, and mutates with expected revision", async () => {
    const {
      api,
      listComments,
      createComment,
      editComment,
      tombstoneComment,
      readCommentAttachment
    } = createApi();
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });

    const { result } = renderHook(() =>
      useCommentsPanelController({
        workItem: taskItem,
        open: true,
        api,
        t: createTranslator("en")
      })
    );

    await waitFor(() => {
      expect(result.current.rows.length).toBeGreaterThan(0);
    });
    expect(listComments).toHaveBeenCalledWith(
      expect.objectContaining({ includeTombstoned: false })
    );
    expect(listComments).toHaveBeenCalledWith(expect.objectContaining({ includeTombstoned: true }));
    expect(result.current.hasMore).toBe(true);

    await expect(result.current.readAttachment("comment-1", "a".repeat(64))).resolves.toMatchObject(
      {
        mediaType: "image/png",
        bodyBase64: "iVBORw=="
      }
    );
    expect(readCommentAttachment).toHaveBeenCalledWith({
      commentId: "comment-1",
      digestSha256: "a".repeat(64)
    });

    await act(async () => {
      result.current.setDraftBody("saved draft");
    });
    expect(result.current.draft.body).toBe("saved draft");

    await act(async () => {
      await result.current.loadMore();
    });
    await waitFor(() => {
      expect(result.current.hasMore).toBe(false);
    });

    await act(async () => {
      const ok = await result.current.submitComment();
      expect(ok).toBe(true);
    });
    expect(createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        workItem: taskItem,
        body: "saved draft"
      })
    );
    expect(result.current.draft.body).toBe("");

    await act(async () => {
      await result.current.editComment("comment-1", "edited", 1);
    });
    expect(editComment).toHaveBeenCalledWith({
      commentId: "comment-1",
      body: "edited",
      expectedRevision: 1
    });

    await act(async () => {
      await result.current.tombstoneComment("comment-1", 2);
    });
    expect(tombstoneComment).toHaveBeenCalledWith({
      commentId: "comment-1",
      expectedRevision: 2
    });
    expect(result.current.rows.some((row) => row.commentId === "comment-1")).toBe(false);
    expect(
      Object.values(shell.controller.getSnapshot().commentsByWorkItem)
        .flat()
        .find((comment) => comment.commentId === "comment-1")
    ).toMatchObject({ tombstoned: true });
  });

  it("removes an active row when an observer refresh no longer returns the comment", async () => {
    const { api, listComments } = createApi();
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });

    const { result } = renderHook(() =>
      useCommentsPanelController({
        workItem: taskItem,
        open: true,
        api,
        t: createTranslator("en")
      })
    );

    await waitFor(() => {
      expect(result.current.rows.map((row) => row.commentId)).toContain("comment-1");
    });

    const removedComment = {
      ...commentProjection("comment-1", "first", 2),
      body: null,
      tombstoned: true,
      tombstonedAt: "2030-01-01T00:10:00.000Z"
    };
    listComments.mockImplementation(async (query: { includeTombstoned?: boolean }) => ({
      items: query.includeTombstoned ? [removedComment] : [],
      nextCursor: null
    }));
    shell.controller.handleObserverSignalForTests({
      type: "human.observer.event",
      profileId: "profile-1",
      projectId: "project-1",
      event: {
        type: "human.observer.event",
        protocolVersion: 1,
        cursor: 1,
        previousCursor: 0,
        occurredAt: "2030-01-01T00:10:00.000Z",
        kind: "comment",
        workItem: taskItem
      }
    });

    await waitFor(() => {
      expect(shell.controller.getSnapshot().commentsByWorkItem["task:canvas-1:T-1"]).toEqual([
        removedComment
      ]);
      expect(result.current.rows).toEqual([]);
    });
  });

  it("surfaces offline compose denial when session is disconnected", async () => {
    const { api } = createApi();
    (api.getCollaborationStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...connectedStatus(),
      activeProfileId: null,
      session: {
        phase: "idle",
        activeProfileId: null,
        detail: null,
        lastErrorCode: null,
        lastErrorMessage: null
      }
    });

    const { result } = renderHook(() =>
      useCommentsPanelController({
        workItem: taskItem,
        open: true,
        api,
        t: createTranslator("en")
      })
    );

    await waitFor(() => {
      expect(result.current.mode).toBe("disconnected");
    });
    expect(result.current.canCompose).toBe(false);
  });
});

describe("useActivityPanelController", () => {
  it("loads activity pages and keeps rows non-commandable", async () => {
    const { api, listActivity } = createApi();
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });

    const { result } = renderHook(() =>
      useActivityPanelController({
        workItem: taskItem,
        open: true,
        api,
        t: createTranslator("en")
      })
    );

    // Wait for the panel-scoped list (includes workItem), not only hub project catch-up.
    // Hub snapshot merge can populate rows earlier without establishing pagination cursors.
    await waitFor(() => {
      expect(listActivity).toHaveBeenCalledWith(expect.objectContaining({ workItem: taskItem }));
      expect(result.current.rows.length).toBe(1);
      expect(result.current.hasMore).toBe(true);
    });
    expect(result.current.rows[0]?.interactive).toBe(false);
    expect(result.current.rows[0]?.sourceLabelKey).toBe("activitySourceComment");

    await act(async () => {
      await result.current.loadMore();
    });
    await waitFor(() => {
      expect(result.current.hasMore).toBe(false);
    });
  });
});

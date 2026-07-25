/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  exampleActivityListPage,
  exampleAssignmentProjection,
  exampleCommentListPage,
  exampleCommentProjection,
  exampleMemberPage,
  exampleObserverCatchupRequired,
  exampleObserverEvent
} from "@planweave-ai/collaboration-contracts";
import { CollaborationReadModelController } from "../renderer/collaboration/CollaborationReadModelController";
import {
  buildCollaborationProjectViewModel,
  mutationAppearsSuccessful
} from "../renderer/collaboration/collaborationViewModels";
import { useCollaborationReadModels } from "../renderer/hooks/useCollaborationReadModels";
import { workItemKey } from "../shared/collaborationReadModels";
import type {
  CollaborationObserverSignal,
  CollaborationStatus
} from "../shared/collaboration";
import type { CollaborationReadBridgePort } from "../renderer/collaboration/CollaborationReadModelController";

const workItem = exampleAssignmentProjection.workItem;
const workKey = workItemKey(workItem);

function idleStatus(overrides?: Partial<CollaborationStatus>): CollaborationStatus {
  return {
    profiles: [],
    activeProfileId: "profile-demo-001",
    credentialStorage: "available",
    nonPersistenceWarning: null,
    session: {
      phase: "connected",
      activeProfileId: "profile-demo-001",
      detail: "observer:connected",
      lastErrorCode: null,
      lastErrorMessage: null
    },
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...overrides
  };
}

function createMockApi(options?: {
  members?: typeof exampleMemberPage;
  assignments?: { items: typeof exampleAssignmentProjection[]; nextCursor: number | null };
  activity?: typeof exampleActivityListPage;
  comments?: typeof exampleCommentListPage;
  onUpdateAssignment?: ReturnType<typeof vi.fn>;
  onEditComment?: ReturnType<typeof vi.fn>;
}): {
  api: CollaborationReadBridgePort;
  statusListeners: Array<(status: CollaborationStatus) => void>;
  signalListeners: Array<(signal: CollaborationObserverSignal) => void>;
  listMembers: ReturnType<typeof vi.fn>;
  listAssignments: ReturnType<typeof vi.fn>;
  listActivity: ReturnType<typeof vi.fn>;
  listComments: ReturnType<typeof vi.fn>;
  listEligible: ReturnType<typeof vi.fn>;
} {
  const statusListeners: Array<(status: CollaborationStatus) => void> = [];
  const signalListeners: Array<(signal: CollaborationObserverSignal) => void> = [];
  const listMembers = vi.fn().mockResolvedValue(options?.members ?? exampleMemberPage);
  const listAssignments = vi.fn().mockResolvedValue(
    options?.assignments ?? { items: [exampleAssignmentProjection], nextCursor: null }
  );
  const listActivity = vi.fn().mockResolvedValue(options?.activity ?? exampleActivityListPage);
  const listComments = vi.fn().mockResolvedValue(options?.comments ?? exampleCommentListPage);
  const listEligible = vi.fn().mockResolvedValue({
    workItem,
    humans: [],
    hosts: [
      {
        projectId: "project-demo-001",
        hostId: "host-001",
        exists: true,
        revoked: false,
        authorizedForProject: true,
        online: true,
        capabilities: ["acp"],
        displayName: "Host One"
      }
    ],
    nextHumanCursor: null,
    nextHostCursor: null
  });
  const updateAssignment =
    options?.onUpdateAssignment ??
    vi.fn().mockResolvedValue({
      ...exampleAssignmentProjection,
      revision: 2,
      target: { kind: "unassigned" }
    });
  const editComment =
    options?.onEditComment ??
    vi.fn().mockResolvedValue({
      ...exampleCommentProjection,
      revision: 2,
      body: "edited"
    });

  const api: CollaborationReadBridgePort = {
    getCollaborationStatus: vi.fn().mockResolvedValue(idleStatus()),
    listCollaborationMembers: listMembers,
    listCollaborationAssignments: listAssignments,
    listCollaborationEligibleAssignees: listEligible,
    listCollaborationComments: listComments,
    listCollaborationActivity: listActivity,
    updateCollaborationAssignment: updateAssignment,
    createCollaborationComment: vi.fn().mockResolvedValue(exampleCommentProjection),
    editCollaborationComment: editComment,
    tombstoneCollaborationComment: vi.fn().mockResolvedValue({
      ...exampleCommentProjection,
      tombstoned: true,
      revision: 3
    }),
    onCollaborationStatusChanged: (callback) => {
      statusListeners.push(callback);
      return () => {
        const index = statusListeners.indexOf(callback);
        if (index >= 0) statusListeners.splice(index, 1);
      };
    },
    onCollaborationObserverSignal: (callback) => {
      signalListeners.push(callback);
      return () => {
        const index = signalListeners.indexOf(callback);
        if (index >= 0) signalListeners.splice(index, 1);
      };
    }
  };

  return {
    api,
    statusListeners,
    signalListeners,
    listMembers,
    listAssignments,
    listActivity,
    listComments,
    listEligible
  };
}

describe("CollaborationReadModelController", () => {
  it("loads membership, hosts, assignments, activity on setActiveProject", async () => {
    const { api, listMembers, listAssignments, listActivity, listEligible } = createMockApi();
    const controller = new CollaborationReadModelController({
      api,
      clock: { now: () => new Date("2030-01-01T00:00:00.000Z") }
    });

    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001",
      canvasId: "canvas-1"
    });

    const snapshot = controller.getSnapshot();
    expect(snapshot.syncPhase).toBe("ready");
    expect(snapshot.members).toEqual(exampleMemberPage.items);
    expect(snapshot.assignmentsByWorkItem[workKey]?.revision).toBe(1);
    expect(snapshot.hosts[0]?.hostId).toBe("host-001");
    expect(snapshot.activity).toEqual(exampleActivityListPage.items);
    expect(listMembers).toHaveBeenCalledTimes(1);
    expect(listAssignments).toHaveBeenCalledTimes(1);
    expect(listActivity).toHaveBeenCalledTimes(1);
    expect(listEligible).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("handles initial load race by ignoring stale generation results", async () => {
    vi.useFakeTimers();
    try {
      const { api, listMembers } = createMockApi();
      let membersCall = 0;
      listMembers.mockImplementation(async () => {
        membersCall += 1;
        if (membersCall === 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            items: [
              {
                ...exampleMemberPage.items[0]!,
                projectId: "project-a",
                membershipId: "membership-stale"
              }
            ],
            nextCursor: null
          };
        }
        return exampleMemberPage;
      });

      const controller = new CollaborationReadModelController({ api });
      const first = controller.setActiveProject({
        profileId: "profile-a",
        projectId: "project-a"
      });
      await act(async () => {
        await Promise.resolve();
      });

      const second = controller.setActiveProject({
        profileId: "profile-b",
        projectId: "project-b"
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60);
      });
      await second;
      await first;

      expect(controller.getSnapshot().profileId).toBe("profile-b");
      expect(controller.getSnapshot().projectId).toBe("project-b");
      expect(
        controller
          .getSnapshot()
          .members.some((member) => member.membershipId === "membership-stale")
      ).toBe(false);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops subscriptions and clears cache on project switch", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });
    expect(mock.signalListeners).toHaveLength(1);
    const firstListener = mock.signalListeners[0];
    expect(controller.getSnapshot().projectId).toBe("project-demo-001");

    mock.listAssignments.mockResolvedValueOnce({ items: [], nextCursor: null });
    mock.listMembers.mockResolvedValueOnce({ items: [], nextCursor: null });
    mock.listActivity.mockResolvedValueOnce({ items: [], nextCursor: null });

    await controller.setActiveProject({
      profileId: "profile-other",
      projectId: "project-other"
    });
    expect(mock.signalListeners).toHaveLength(1);
    expect(mock.signalListeners[0]).not.toBe(firstListener);
    expect(controller.getSnapshot().profileId).toBe("profile-other");
    expect(controller.getSnapshot().projectId).toBe("project-other");
    expect(controller.getSnapshot().assignmentsByWorkItem).toEqual({});
    controller.dispose();
    expect(mock.signalListeners).toHaveLength(0);
  });

  it("dedupes out-of-order and duplicate observer events", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });
    mock.listAssignments.mockClear();

    const baseEvent = exampleObserverEvent;
    controller.handleObserverSignalForTests({
      type: "human.observer.event",
      profileId: "profile-demo-001",
      projectId: "project-demo-001",
      event: baseEvent
    });
    await Promise.resolve();
    await Promise.resolve();

    const assignmentCallsAfterFirst = mock.listAssignments.mock.calls.length;

    // duplicate
    controller.handleObserverSignalForTests({
      type: "human.observer.event",
      profileId: "profile-demo-001",
      projectId: "project-demo-001",
      event: baseEvent
    });
    await Promise.resolve();
    expect(mock.listAssignments.mock.calls.length).toBe(assignmentCallsAfterFirst);

    // out-of-order older cursor
    controller.handleObserverSignalForTests({
      type: "human.observer.event",
      profileId: "profile-demo-001",
      projectId: "project-demo-001",
      event: {
        ...baseEvent,
        cursor: 5,
        previousCursor: 4
      }
    });
    await Promise.resolve();
    expect(mock.listAssignments.mock.calls.length).toBe(assignmentCallsAfterFirst);

    controller.dispose();
  });

  it("performs bounded authoritative refresh on cursor retention gap", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });
    expect(controller.getSnapshot().assignmentsByWorkItem[workKey]).toBeTruthy();

    mock.listMembers.mockClear();
    mock.listAssignments.mockClear();
    mock.listActivity.mockClear();

    await act(async () => {
      controller.handleObserverSignalForTests({
        type: "human.observer.catchup_required",
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        reason: exampleObserverCatchupRequired.reason,
        resumeCursor: exampleObserverCatchupRequired.resumeCursor,
        droppedThroughCursor: exampleObserverCatchupRequired.droppedThroughCursor
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(controller.getSnapshot().observerCursor).toBe(100);
      expect(controller.getSnapshot().syncPhase).toBe("ready");
    });
    expect(mock.listMembers).toHaveBeenCalled();
    expect(mock.listAssignments).toHaveBeenCalled();
    expect(mock.listActivity).toHaveBeenCalled();
    controller.dispose();
  });

  it("models auth expiry from session status", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });

    controller.handleStatusForTests(
      idleStatus({
        session: {
          phase: "error",
          activeProfileId: "profile-demo-001",
          detail: "observer:auth_expired",
          lastErrorCode: "human_device_revoked",
          lastErrorMessage: "revoked"
        }
      })
    );

    expect(controller.getSnapshot().syncPhase).toBe("auth_expired");
    expect(controller.getSnapshot().lastError?.code).toBe("human_device_revoked");
    controller.dispose();
  });

  it("does not treat offline mutation as success", async () => {
    const updateAssignment = vi.fn().mockRejectedValue({
      kind: "offline",
      code: "collaboration_offline",
      message: "Network request failed.",
      retryable: true
    });
    const mock = createMockApi({ onUpdateAssignment: updateAssignment });
    const controller = new CollaborationReadModelController({
      api: mock.api,
      createMutationId: () => "mut-offline"
    });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });

    const result = await controller.updateAssignment({
      workItem,
      target: { kind: "unassigned" },
      expectedRevision: 1
    });
    expect(result).toBeNull();
    const mutation = controller.getSnapshot().mutationsById["mut-offline"];
    expect(mutation?.status).toBe("offline");
    expect(mutationAppearsSuccessful(mutation)).toBe(false);
    expect(controller.getSnapshot().syncPhase).toBe("degraded");
    // Assignment cache must still show last server projection (rev 1), not optimistic unassigned.
    expect(controller.getSnapshot().assignmentsByWorkItem[workKey]?.revision).toBe(1);
    expect(controller.getSnapshot().assignmentsByWorkItem[workKey]?.target).toEqual({
      kind: "human",
      humanPrincipalId: "human-owner-001"
    });
    controller.dispose();
  });

  it("models stale revision conflict without confirming the mutation", async () => {
    const updateAssignment = vi.fn().mockRejectedValue({
      kind: "conflict",
      code: "revision_conflict",
      message: "Assignment revision conflict.",
      retryable: false
    });
    const mock = createMockApi({ onUpdateAssignment: updateAssignment });
    const controller = new CollaborationReadModelController({
      api: mock.api,
      createMutationId: () => "mut-conflict"
    });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });

    const result = await controller.updateAssignment({
      workItem,
      target: { kind: "unassigned" },
      expectedRevision: 1
    });
    expect(result).toBeNull();
    expect(controller.getSnapshot().mutationsById["mut-conflict"]?.status).toBe("rejected");
    expect(controller.getSnapshot().syncPhase).toBe("stale_conflict");
    expect(mutationAppearsSuccessful(controller.getSnapshot().mutationsById["mut-conflict"])).toBe(
      false
    );
    controller.dispose();
  });

  it("confirms mutation only after server accepts it", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({
      api: mock.api,
      createMutationId: () => "mut-ok"
    });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });

    const result = await controller.updateAssignment({
      workItem,
      target: { kind: "unassigned" },
      expectedRevision: 1
    });
    expect(result?.revision).toBe(2);
    expect(controller.getSnapshot().mutationsById["mut-ok"]?.status).toBe("confirmed");
    expect(controller.getSnapshot().assignmentsByWorkItem[workKey]?.target).toEqual({
      kind: "unassigned"
    });
    controller.dispose();
  });

  it("derives remote runs from activity and observer progress", async () => {
    const activity = {
      items: [
        {
          ...exampleActivityListPage.items[0]!,
          activityId: "activity-remote-1",
          type: "remote_run_started" as const,
          source: { kind: "remote_run" as const, sourceId: "dispatch-001" },
          summary: {
            headline: "Remote run started",
            workItem,
            dispatchId: "dispatch-001",
            hostId: "host-001"
          }
        }
      ],
      nextCursor: null
    };
    const mock = createMockApi({ activity });
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001"
    });
    expect(controller.getSnapshot().remoteRunsByDispatchId["dispatch-001"]?.status).toBe(
      "started"
    );

    controller.handleObserverSignalForTests({
      type: "human.observer.event",
      profileId: "profile-demo-001",
      projectId: "project-demo-001",
      event: {
        type: "human.observer.event",
        protocolVersion: 1,
        cursor: 20,
        previousCursor: 19,
        occurredAt: "2030-01-01T00:10:00.000Z",
        kind: "remote_run",
        dispatchId: "dispatch-001",
        remoteRunStatus: "progress",
        workItem
      }
    });
    await Promise.resolve();
    expect(controller.getSnapshot().remoteRunsByDispatchId["dispatch-001"]?.status).toBe(
      "progress"
    );
    controller.dispose();
  });

  it("does not derive business state from DOM", () => {
    // Structural guard: controller module must not touch document/window DOM APIs.
    const source = CollaborationReadModelController.toString();
    expect(source).not.toMatch(/document\.|querySelector|getElementById|innerHTML/);
  });
});

describe("collaboration view models", () => {
  it("keeps server projections separate from local runtime facts", async () => {
    const mock = createMockApi();
    const controller = new CollaborationReadModelController({ api: mock.api });
    await controller.setActiveProject({
      profileId: "profile-demo-001",
      projectId: "project-demo-001",
      canvasId: "canvas-1"
    });

    const viewModel = buildCollaborationProjectViewModel({
      snapshot: controller.getSnapshot(),
      localWorkItems: [
        {
          workItem,
          localTitle: "Local task title",
          localRuntimeStatus: "running",
          presentInLocalGraph: true
        }
      ]
    });

    expect(viewModel.workItems).toHaveLength(1);
    expect(viewModel.workItems[0]!.assignment?.target).toEqual({
      kind: "human",
      humanPrincipalId: "human-owner-001"
    });
    expect(viewModel.workItems[0]!.local?.localRuntimeStatus).toBe("running");
    expect(viewModel.workItems[0]!.local?.localTitle).toBe("Local task title");
    // Local runtime must not invent a successful mutation.
    expect(viewModel.workItems[0]!.hasConfirmedMutation).toBe(false);
    expect(viewModel.isAuthoritative).toBe(true);
    controller.dispose();
  });
});

describe("useCollaborationReadModels", () => {
  it("binds one controller per active project and cleans up on unmount", async () => {
    const mock = createMockApi();
    const { result, unmount } = renderHook(() =>
      useCollaborationReadModels({
        profileId: "profile-demo-001",
        projectId: "project-demo-001",
        canvasId: "canvas-1",
        api: mock.api
      })
    );

    await waitFor(() => {
      expect(result.current.snapshot.syncPhase).toBe("ready");
    });
    expect(result.current.viewModel.members).toHaveLength(1);
    expect(mock.signalListeners).toHaveLength(1);

    unmount();
    expect(mock.signalListeners).toHaveLength(0);
  });

  it("clears projections when project becomes null", async () => {
    const mock = createMockApi();
    const { result, rerender } = renderHook(
      (props: { profileId: string | null; projectId: string | null }) =>
        useCollaborationReadModels({
          profileId: props.profileId,
          projectId: props.projectId,
          api: mock.api
        }),
      { initialProps: { profileId: "profile-demo-001", projectId: "project-demo-001" } }
    );

    await waitFor(() => {
      expect(result.current.snapshot.syncPhase).toBe("ready");
    });

    rerender({ profileId: null, projectId: null });
    await waitFor(() => {
      expect(result.current.snapshot.syncPhase).toBe("idle");
      expect(result.current.snapshot.members).toEqual([]);
    });
  });
});

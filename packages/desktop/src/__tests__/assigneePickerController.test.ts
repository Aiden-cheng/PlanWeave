/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkItemRef } from "@planweave-ai/collaboration-contracts";
import {
  acquireCollaborationReadModelController,
  resetCollaborationReadModelHubForTests
} from "../renderer/collaboration/collaborationReadModelHub";
import type { CollaborationReadBridgePort } from "../renderer/collaboration/CollaborationReadModelController";
import { useAssigneePickerController } from "../renderer/hooks/useAssigneePickerController";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../shared/collaboration";
import { createTranslator } from "../renderer/i18n";

const taskItem: WorkItemRef = { kind: "task", canvasId: "canvas-1", taskId: "T-1" };
const blockItem: WorkItemRef = { kind: "block", canvasId: "canvas-1", blockRef: "T-1#B-001" };
const secondBlockItem: WorkItemRef = {
  kind: "block",
  canvasId: "canvas-1",
  blockRef: "T-1#B-002"
};
const blockedBlockItem: WorkItemRef = {
  kind: "block",
  canvasId: "canvas-1",
  blockRef: "T-1#B-003"
};

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

function createApi() {
  const status = connectedStatus();
  const updateResponsibility = vi.fn().mockResolvedValue({
    schemaVersion: "responsibility/v1",
    scope: {
      kind: "task",
      workspaceId: "w",
      projectId: "project-1",
      canvasId: "canvas-1",
      taskId: "T-1"
    },
    principal: { kind: "human", humanPrincipalId: "human-1" },
    revision: 1,
    updatedAt: "2030-01-01T00:00:00.000Z",
    availability: "active"
  });
  const updateExecutionTarget = vi.fn().mockResolvedValue({
    schemaVersion: "execution-target/v1",
    scope: {
      kind: "block",
      workspaceId: "w",
      projectId: "project-1",
      canvasId: "canvas-1",
      blockRef: "T-1#B-001"
    },
    target: { kind: "automatic_host" },
    revision: 1,
    updatedAt: "2030-01-01T00:00:00.000Z",
    availability: { status: "pending", reason: "automatic_pending_selection" }
  });
  const getWorkAuthority = vi
    .fn()
    .mockImplementation(async ({ workItem }: { workItem: WorkItemRef }) => {
      const scope =
        workItem.kind === "task"
          ? {
              kind: "task" as const,
              workspaceId: "w",
              projectId: "project-1",
              canvasId: workItem.canvasId,
              taskId: workItem.taskId
            }
          : {
              kind: "block" as const,
              workspaceId: "w",
              projectId: "project-1",
              canvasId: workItem.canvasId,
              blockRef: workItem.blockRef
            };
      return {
        schemaVersion: "work-authority/v1",
        scope,
        responsibility: {
          schemaVersion: "responsibility/v1",
          scope,
          principal: null,
          revision: 0,
          updatedAt: "2030-01-01T00:00:00.000Z",
          availability: "unassigned"
        },
        reviewer: {
          schemaVersion: "review-assignment/v1",
          scope,
          principal: null,
          revision: 0,
          updatedAt: "2030-01-01T00:00:00.000Z",
          availability: "unassigned"
        },
        executionTarget:
          workItem.kind === "block"
            ? {
                schemaVersion: "execution-target/v1",
                scope,
                target: { kind: "unassigned" },
                revision: 0,
                updatedAt: "2030-01-01T00:00:00.000Z",
                availability: { status: "unassigned", reason: "unassigned" }
              }
            : null,
        revisions: {
          responsibilityRevision: 0,
          reviewerRevision: 0,
          executionTargetRevision: 0
        },
        selectedHost: null,
        evaluatedAt: "2030-01-01T00:00:00.000Z"
      };
    });
  const listEligibleAssignees = vi.fn(async ({ workItem }: { workItem: WorkItemRef }) => ({
    workItem,
    humans: [],
    hosts:
      workItem.kind === "block"
        ? [
            {
              projectId: "project-1",
              hostId: "host-1",
              displayName: "Builder",
              exists: true,
              revoked: false,
              authorizedForProject: true,
              online: true,
              capabilities: ["acp.codex"],
              capacityRemaining: 1
            },
            ...(workItem.blockRef === secondBlockItem.blockRef
              ? []
              : [
                  {
                    projectId: "project-1",
                    hostId: "host-only-first",
                    displayName: "First only",
                    exists: true,
                    revoked: false,
                    authorizedForProject: true,
                    online: true,
                    capabilities: ["acp.codex"],
                    capacityRemaining: 1
                  }
                ])
          ]
        : [],
    nextHumanCursor: null,
    nextHostCursor: null
  }));
  const dispatchRemoteOperation = vi.fn().mockResolvedValue({ operationId: "operation-1" });
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
    listCollaborationEligibleAssignees: listEligibleAssignees,
    getCollaborationWorkAuthority: getWorkAuthority,
    updateCollaborationResponsibility: updateResponsibility,
    updateCollaborationReviewer: vi.fn(),
    updateCollaborationExecutionTarget: updateExecutionTarget,
    listCollaborationComments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationActivity: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    updateCollaborationAssignment: vi.fn(),
    createCollaborationComment: vi.fn(),
    editCollaborationComment: vi.fn(),
    tombstoneCollaborationComment: vi.fn(),
    dispatchCollaborationRemoteOperation: dispatchRemoteOperation,
    onCollaborationStatusChanged: vi.fn(() => () => undefined),
    onCollaborationObserverSignal: vi.fn(() => () => undefined)
  } as unknown as PlanWeaveCollaborationApi & CollaborationReadBridgePort;
  return {
    api,
    updateResponsibility,
    updateExecutionTarget,
    listEligibleAssignees,
    dispatchRemoteOperation
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAssigneePickerController", () => {
  it("hard-rejects Host targets on the responsibility axis without calling Host mutation", async () => {
    const { api, updateResponsibility, updateExecutionTarget } = createApi();
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });

    const { result } = renderHook(() =>
      useAssigneePickerController({
        workItem: taskItem,
        authorityRole: "responsibility",
        api,
        detailsOpen: false,
        t: createTranslator("zh-CN")
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel).not.toBeNull();
    });

    let ok = true;
    await act(async () => {
      ok = await result.current.selectTarget({ kind: "automatic_host" });
    });
    expect(ok).toBe(false);
    expect(updateResponsibility).not.toHaveBeenCalled();
    expect(updateExecutionTarget).not.toHaveBeenCalled();
    expect(result.current.viewModel?.lastError).toBe("Task 不能分配给 Agent Host。");

    await act(async () => {
      ok = await result.current.selectTarget({
        kind: "exact_host",
        hostId: "host-1"
      });
    });
    expect(ok).toBe(false);
    expect(updateExecutionTarget).not.toHaveBeenCalled();

    shell.release();
    resetCollaborationReadModelHubForTests(api);
  });

  it("routes Block automatic_host only through the execution_target authority", async () => {
    const { api, updateResponsibility, updateExecutionTarget } = createApi();
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });

    const { result } = renderHook(() =>
      useAssigneePickerController({
        workItem: blockItem,
        authorityRole: "execution_target",
        api,
        detailsOpen: false,
        t: createTranslator("en")
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel).not.toBeNull();
    });

    let ok = false;
    await act(async () => {
      ok = await result.current.selectTarget({ kind: "automatic_host" });
    });
    expect(ok).toBe(true);
    expect(updateExecutionTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        workItem: blockItem,
        target: { kind: "automatic_host" }
      })
    );
    expect(updateResponsibility).not.toHaveBeenCalled();

    shell.release();
    resetCollaborationReadModelHubForTests(api);
  });

  it("expands a Task Host selection into eligible exact-Block dispatches in runtime order", async () => {
    const { api, updateExecutionTarget, listEligibleAssignees, dispatchRemoteOperation } =
      createApi();
    const shell = acquireCollaborationReadModelController(api);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "canvas-1"
    });

    const { result } = renderHook(() =>
      useAssigneePickerController({
        workItem: taskItem,
        taskExecutionBlocks: [
          { workItem: blockItem, dispatchable: true },
          { workItem: secondBlockItem, dispatchable: true },
          { workItem: blockedBlockItem, dispatchable: false }
        ],
        authorityRole: "execution_target",
        api,
        detailsOpen: true,
        createId: vi.fn().mockReturnValueOnce("id-1").mockReturnValueOnce("id-2"),
        t: createTranslator("en")
      })
    );

    await waitFor(() => {
      expect(result.current.viewModel?.sections[0]?.options.map((option) => option.id)).toEqual([
        "exact_host:host-1"
      ]);
    });

    let ok = true;
    await act(async () => {
      ok = await result.current.selectTarget({ kind: "exact_host", hostId: "host-1" });
    });

    expect(ok).toBe(false);
    expect(updateExecutionTarget).toHaveBeenCalledTimes(2);
    expect(updateExecutionTarget.mock.calls.map(([input]) => input.workItem)).toEqual([
      blockItem,
      secondBlockItem
    ]);
    expect(dispatchRemoteOperation.mock.calls.map(([input]) => input.blockRef)).toEqual([
      blockItem.blockRef,
      secondBlockItem.blockRef
    ]);
    expect(dispatchRemoteOperation.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([
      "desktop-task-dispatch-id-1",
      "desktop-task-dispatch-id-2"
    ]);
    expect(result.current.taskDispatchResults).toEqual([
      { blockRef: blockItem.blockRef, ok: true, message: "task_block_dispatched" },
      { blockRef: secondBlockItem.blockRef, ok: true, message: "task_block_dispatched" },
      {
        blockRef: blockedBlockItem.blockRef,
        ok: false,
        message: "task_block_not_dispatchable"
      }
    ]);
    expect(listEligibleAssignees.mock.calls.some(([input]) => input.workItem.kind === "task")).toBe(
      false
    );

    shell.release();
    resetCollaborationReadModelHubForTests(api);
  });
});

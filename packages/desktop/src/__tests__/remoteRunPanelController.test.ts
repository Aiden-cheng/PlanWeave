/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkItemRef } from "@planweave-ai/collaboration-contracts";
import {
  acquireCollaborationReadModelController,
  resetCollaborationReadModelHubForTests
} from "../renderer/collaboration/collaborationReadModelHub";
import type { CollaborationReadBridgePort } from "../renderer/collaboration/CollaborationReadModelController";
import { useRemoteRunPanelController } from "../renderer/hooks/useRemoteRunPanelController";
import { createTranslator } from "../renderer/i18n";
import type {
  CollaborationStatus,
  PlanWeaveCollaborationApi
} from "../shared/collaboration";

const blockItem: WorkItemRef = {
  kind: "block",
  canvasId: "default",
  blockRef: "T-1#B-1"
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
    updatedAt: "2030-01-01T00:00:00.000Z"
  };
}

function observation(state: "running" | "interrupted" | "completed" = "running") {
  return {
    operationId: "op-1",
    projectId: "project-1",
    canvasId: "default",
    blockRef: "T-1#B-1",
    state,
    dispatchId: "dispatch-1",
    executionAttemptId: "attempt-1",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:01:00.000Z",
    attempt: {
      executionAttemptId: "attempt-1",
      dispatchId: "dispatch-1",
      status: state === "running" ? ("running" as const) : (state as "interrupted" | "completed"),
      hostId: "host-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2030-01-01T01:00:00.000Z",
      stateVersion: 2
    },
    dispatchStatus: state === "running" ? ("running" as const) : undefined,
    runtime: {
      ref: "T-1#B-1",
      status: state === "completed" ? "completed" : "in_progress",
      interruption:
        state === "interrupted"
          ? {
              reason: "transport_lost",
              resumable: true,
              recovery: { acpSessionId: "session-1", recoveryId: "recovery-1" }
            }
          : undefined
    }
  };
}

function createApi() {
  const status = connectedStatus();
  const observe = vi.fn().mockResolvedValue(observation("running"));
  const dispatch = vi.fn().mockResolvedValue(observation("running"));
  const executeAction = vi.fn().mockResolvedValue({
    request: {
      kind: "cancel",
      actionId: "a1",
      operationId: "op-1",
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      expectedAttemptVersion: 2,
      leaseId: "lease-1",
      reason: "stop"
    },
    state: "recorded",
    createdAt: "2030-01-01T00:02:00.000Z"
  });
  const replay = vi.fn().mockResolvedValue({
    executionAttemptId: "attempt-1",
    afterCursor: 0,
    cursor: 2,
    highWatermark: 2,
    hasMore: false,
    events: [
      { cursor: 1, kind: "agent_message", text: "hello" },
      { cursor: 2, kind: "tool_call", title: "edit", status: "completed" }
    ]
  });
  const listInteractions = vi.fn().mockResolvedValue({
    items: [
      {
        request: {
          type: "interaction.permission_requested",
          title: "Write",
          description: "Allow write",
          actionId: "ia-1",
          dispatchId: "dispatch-1",
          leaseId: "lease-1",
          executionAttemptId: "attempt-1",
          acpSessionId: "session-1",
          expiresAt: "2030-01-01T02:00:00.000Z"
        },
        operationId: "op-1",
        hostId: "host-1",
        status: "pending",
        createdAt: "2030-01-01T00:30:00.000Z"
      }
    ],
    nextCursor: null
  });
  const settle = vi.fn().mockImplementation(async (input: { settlement: { actionId: string } }) => ({
    request: {
      type: "interaction.permission_requested",
      title: "Write",
      description: "Allow write",
      actionId: input.settlement.actionId,
      dispatchId: "dispatch-1",
      leaseId: "lease-1",
      executionAttemptId: "attempt-1",
      acpSessionId: "session-1",
      expiresAt: "2030-01-01T02:00:00.000Z"
    },
    operationId: "op-1",
    hostId: "host-1",
    status: "settled",
    createdAt: "2030-01-01T00:30:00.000Z"
  }));

  const api = {
    getCollaborationStatus: vi.fn().mockResolvedValue(status),
    onCollaborationStatusChanged: vi.fn(() => () => undefined),
    onCollaborationObserverSignal: vi.fn(() => () => undefined),
    listCollaborationMembers: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationAssignments: vi.fn().mockResolvedValue({
      items: [
        {
          projectId: "project-1",
          workItem: blockItem,
          target: { kind: "exact_host", hostId: "host-1" },
          revision: 1,
          availability: { status: "ready", reason: "ready" },
          host: {
            hostId: "host-1",
            displayName: "Host",
            online: true,
            authorizedForProject: true,
            revoked: false,
            capabilitiesSatisfied: true
          }
        }
      ],
      nextCursor: null
    }),
    listCollaborationActivity: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationComments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listCollaborationEligibleAssignees: vi.fn().mockResolvedValue({
      humans: [],
      hosts: []
    }),
    observeCollaborationRemoteOperation: observe,
    dispatchCollaborationRemoteOperation: dispatch,
    executeCollaborationRemoteOperationAction: executeAction,
    replayCollaborationRemoteOperationEvents: replay,
    listCollaborationRemoteOperationInteractions: listInteractions,
    settleCollaborationRemoteOperationInteraction: settle
  } as unknown as PlanWeaveCollaborationApi;

  return {
    api,
    observe,
    dispatch,
    executeAction,
    replay,
    listInteractions,
    settle
  };
}

const apis: CollaborationReadBridgePort[] = [];

afterEach(() => {
  while (apis.length > 0) {
    resetCollaborationReadModelHubForTests(apis.pop());
  }
});

describe("useRemoteRunPanelController", () => {
  it("loads observation, events, and interactions when open", async () => {
    const { api, observe, replay, listInteractions } = createApi();
    const bridge = api as unknown as CollaborationReadBridgePort;
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    const { result } = renderHook(() =>
      useRemoteRunPanelController({
        workItem: blockItem,
        runtimeRemoteExecution: {
          identity: { operationId: "op-1" },
          phase: "active",
          status: "owned",
          actionRequired: false,
          source: { revision: "rev-1", graphFingerprint: "fp-1" },
          dispatchAttempt: { dispatchId: "dispatch-1", executionAttemptId: "attempt-1" }
        },
        open: true,
        api,
        t: createTranslator("en"),
        createId: () => "id-fixed"
      })
    );

    await waitFor(() => {
      expect(observe).toHaveBeenCalledWith({ operationId: "op-1" });
      expect(result.current.viewModel.identity?.operationId).toBe("op-1");
    });
    expect(replay).toHaveBeenCalled();
    expect(listInteractions).toHaveBeenCalled();
    expect(result.current.viewModel.events).toHaveLength(2);
    expect(result.current.viewModel.pendingInteractions).toHaveLength(1);
    expect(result.current.viewModel.authority).toBe("remote_dispatch");
  });

  it("dispatches and cancels through the mock bridge", async () => {
    const { api, dispatch, executeAction, observe } = createApi();
    observe.mockResolvedValueOnce(observation("running"));
    const bridge = api as unknown as CollaborationReadBridgePort;
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    const { result } = renderHook(() =>
      useRemoteRunPanelController({
        workItem: blockItem,
        runtimeRemoteExecution: {
          identity: { operationId: "op-1" },
          phase: "active",
          status: "owned",
          actionRequired: false,
          source: { revision: "rev-1", graphFingerprint: "fp-1" },
          dispatchAttempt: { dispatchId: "dispatch-1", executionAttemptId: "attempt-1" }
        },
        open: true,
        api,
        t: createTranslator("en"),
        createId: () => "id-fixed"
      })
    );

    await waitFor(() => expect(result.current.viewModel.identity).not.toBeNull());

    await act(async () => {
      await result.current.dispatch();
    });
    expect(dispatch).toHaveBeenCalled();

    await act(async () => {
      await result.current.cancel("stop please");
    });
    expect(executeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-1",
        action: expect.objectContaining({ kind: "cancel", reason: "stop please" })
      })
    );
  });

  it("settles one pending permission interaction", async () => {
    const { api, settle } = createApi();
    const bridge = api as unknown as CollaborationReadBridgePort;
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    const { result } = renderHook(() =>
      useRemoteRunPanelController({
        workItem: blockItem,
        runtimeRemoteExecution: {
          identity: { operationId: "op-1" },
          phase: "active",
          status: "owned",
          actionRequired: true,
          source: { revision: "rev-1", graphFingerprint: "fp-1" },
          dispatchAttempt: { dispatchId: "dispatch-1", executionAttemptId: "attempt-1" }
        },
        open: true,
        api,
        t: createTranslator("en"),
        createId: () => "id-fixed"
      })
    );

    await waitFor(() => expect(result.current.viewModel.pendingInteractions.length).toBe(1));

    await act(async () => {
      await result.current.answerInteraction({
        type: "interaction.permission_response",
        decision: "allow_once",
        actionId: "ia-1",
        dispatchId: "dispatch-1",
        leaseId: "lease-1",
        executionAttemptId: "attempt-1",
        acpSessionId: "session-1"
      });
    });
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-1",
        settlement: expect.objectContaining({
          type: "interaction.permission_response",
          decision: "allow_once"
        })
      })
    );
  });

  it("clears observation state on project switch generation", async () => {
    const { api } = createApi();
    const bridge = api as unknown as CollaborationReadBridgePort;
    apis.push(bridge);
    const shell = acquireCollaborationReadModelController(bridge);
    await shell.controller.setActiveProject({
      profileId: "profile-1",
      projectId: "project-1",
      canvasId: "default"
    });

    const { result } = renderHook(() =>
      useRemoteRunPanelController({
        workItem: blockItem,
        runtimeRemoteExecution: {
          identity: { operationId: "op-1" },
          phase: "active",
          status: "owned",
          actionRequired: false,
          source: { revision: "rev-1", graphFingerprint: "fp-1" },
          dispatchAttempt: { dispatchId: "dispatch-1", executionAttemptId: "attempt-1" }
        },
        open: true,
        api,
        t: createTranslator("en")
      })
    );

    await waitFor(() => expect(result.current.viewModel.identity).not.toBeNull());

    await act(async () => {
      await shell.controller.setActiveProject({
        profileId: "profile-1",
        projectId: "project-2",
        canvasId: "default"
      });
    });

    await waitFor(() => {
      expect(result.current.viewModel.identity).toBeNull();
    });
  });
});

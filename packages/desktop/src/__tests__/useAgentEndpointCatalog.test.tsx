/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import type { RemoteAgentEndpoint } from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollaborationObserverSignal } from "../shared/collaborationReadModels";
import { useAgentEndpointCatalog } from "../renderer/hooks/useAgentEndpointCatalog";

const online: RemoteAgentEndpoint = {
  schemaVersion: "agent-endpoint/v1",
  endpointId: "endpoint-windows",
  profileId: "codex-acp",
  agentId: "codex",
  displayName: "Codex",
  hostDisplayName: "LINANIML",
  status: "available",
  capabilities: ["acp.codex"]
};

const offline: RemoteAgentEndpoint = {
  ...online,
  status: "unavailable",
  unavailableReason: "host_offline"
};

describe("useAgentEndpointCatalog freshness", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("refreshes liveness at a low frequency and preserves an unavailable Endpoint id", async () => {
    let current = online;
    const listCollaborationAgentEndpoints = vi.fn(async () => ({
      schemaVersion: "agent-endpoint-list/v1" as const,
      items: [current]
    }));
    const api = {
      listCollaborationAgentEndpoints,
      onCollaborationObserverSignal: vi.fn(() => () => undefined)
    };
    const { result } = renderHook(() =>
      useAgentEndpointCatalog({
        api,
        enabled: true,
        logicalExecutors: [
          {
            executorName: "codex",
            profileId: "codex-acp",
            agentId: "codex",
            displayName: "Codex",
            capabilities: ["acp.codex"],
            available: true,
            unavailableReason: null,
            custom: false
          }
        ],
        profileId: "profile-1",
        projectId: "project-1"
      })
    );

    await act(async () => undefined);
    expect(
      result.current.endpoints.find((endpoint) => endpoint.id === "remote:endpoint-windows")
    ).toMatchObject({ available: true, unavailableReason: null });

    current = offline;
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(listCollaborationAgentEndpoints).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(
      result.current.endpoints.find((endpoint) => endpoint.id === "remote:endpoint-windows")
    ).toMatchObject({
      id: "remote:endpoint-windows",
      available: false,
      unavailableReason: "host_offline"
    });

    current = online;
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(
      result.current.endpoints.find((endpoint) => endpoint.id === "remote:endpoint-windows")
    ).toMatchObject({ available: true, unavailableReason: null });
  });

  it("refreshes when the active project receives a remote run observer event", async () => {
    let current = online;
    let observerListener: ((signal: CollaborationObserverSignal) => void) | null = null;
    const listCollaborationAgentEndpoints = vi.fn(async () => ({
      schemaVersion: "agent-endpoint-list/v1" as const,
      items: [current]
    }));
    const api = {
      listCollaborationAgentEndpoints,
      onCollaborationObserverSignal: vi.fn(
        (listener: (signal: CollaborationObserverSignal) => void) => {
          observerListener = listener;
          return () => undefined;
        }
      )
    };
    const { result } = renderHook(() =>
      useAgentEndpointCatalog({
        api,
        enabled: true,
        logicalExecutors: [],
        profileId: "profile-1",
        projectId: "project-1"
      })
    );

    await act(async () => undefined);
    current = offline;
    const event: CollaborationObserverSignal = {
      type: "human.observer.event",
      profileId: "profile-1",
      projectId: "project-1",
      event: {
        type: "human.observer.event",
        protocolVersion: 1,
        cursor: 1,
        previousCursor: 0,
        occurredAt: "2030-01-01T00:00:00.000Z",
        kind: "remote_run",
        dispatchId: "dispatch-1",
        remoteRunStatus: "started",
        workItem: {
          canvasId: "default",
          blockRef: "project-1:task-1:block-1"
        }
      }
    };
    expect(observerListener).not.toBeNull();
    await act(async () => observerListener?.(event));

    expect(listCollaborationAgentEndpoints).toHaveBeenCalledTimes(2);
    expect(
      result.current.endpoints.find((endpoint) => endpoint.id === "remote:endpoint-windows")
    ).toMatchObject({
      available: false,
      unavailableReason: "host_offline"
    });
  });
});

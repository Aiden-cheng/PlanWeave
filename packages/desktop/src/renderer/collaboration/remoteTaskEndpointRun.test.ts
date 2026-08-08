import {
  remoteOperationObservationSchema,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import { describe, expect, it, vi } from "vitest";
import { waitForRemoteOperationTerminal } from "./remoteTaskEndpointRun";

function operation(
  blockRef: string,
  state: RemoteOperationObservation["state"]
): RemoteOperationObservation {
  const operationSuffix = blockRef.replace("#", ":");
  const attemptStatus =
    state === "completed" || state === "failed" || state === "cancelled" || state === "interrupted"
      ? state
      : state === "awaiting_writeback"
        ? "awaiting_writeback"
        : "running";
  return remoteOperationObservationSchema.parse({
    operationId: `operation-${operationSuffix}`,
    projectId: "project-1",
    canvasId: "canvas-1",
    blockRef,
    state,
    dispatchId: `dispatch-${operationSuffix}`,
    executionAttemptId: `attempt-${operationSuffix}`,
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:01.000Z",
    attempt: {
      executionAttemptId: `attempt-${operationSuffix}`,
      dispatchId: `dispatch-${operationSuffix}`,
      status: attemptStatus,
      stateVersion: 1
    },
    runtime: {
      ref: blockRef,
      status:
        state === "completed"
          ? "completed"
          : state === "interrupted"
            ? "interrupted"
            : "in_progress"
    }
  });
}

describe("waitForRemoteOperationTerminal", () => {
  it("refreshes an operation through the observer API until it reaches a terminal state", async () => {
    const unsubscribe = vi.fn();
    const observeCollaborationRemoteOperation = vi.fn(async () =>
      operation("T-001#B-001", "completed")
    );

    const result = await waitForRemoteOperationTerminal({
      api: {
        observeCollaborationRemoteOperation,
        onCollaborationObserverSignal: vi.fn(() => unsubscribe)
      },
      initial: operation("T-001#B-001", "running")
    });

    expect(result.state).toBe("completed");
    expect(observeCollaborationRemoteOperation).toHaveBeenCalledWith({
      operationId: "operation-T-001:B-001"
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("resolves immediately when the initial observation is already terminal", async () => {
    const observeCollaborationRemoteOperation = vi.fn();
    const result = await waitForRemoteOperationTerminal({
      api: {
        observeCollaborationRemoteOperation,
        onCollaborationObserverSignal: vi.fn(() => () => undefined)
      },
      initial: operation("T-001#B-001", "completed")
    });
    expect(result.state).toBe("completed");
    expect(observeCollaborationRemoteOperation).not.toHaveBeenCalled();
  });

  it("treats interrupted without pending writeback as wait-terminal", async () => {
    const observeCollaborationRemoteOperation = vi.fn();
    const result = await waitForRemoteOperationTerminal({
      api: {
        observeCollaborationRemoteOperation,
        onCollaborationObserverSignal: vi.fn(() => () => undefined)
      },
      initial: {
        ...operation("T-001#B-001", "interrupted"),
        dispatchStatus: "interrupted"
      }
    });
    expect(result.state).toBe("interrupted");
    expect(observeCollaborationRemoteOperation).not.toHaveBeenCalled();
  });

  it("keeps waiting when interrupted but dispatch is still awaiting_writeback", async () => {
    const unsubscribe = vi.fn();
    const observeCollaborationRemoteOperation = vi
      .fn()
      .mockResolvedValueOnce({
        ...operation("T-001#R-001", "interrupted"),
        dispatchStatus: "awaiting_writeback"
      })
      .mockResolvedValueOnce(operation("T-001#R-001", "completed"));

    const result = await waitForRemoteOperationTerminal({
      api: {
        observeCollaborationRemoteOperation,
        onCollaborationObserverSignal: vi.fn(() => unsubscribe)
      },
      initial: {
        ...operation("T-001#R-001", "interrupted"),
        dispatchStatus: "awaiting_writeback"
      },
      fallbackRefreshMs: 1
    });

    expect(result.state).toBe("completed");
    expect(observeCollaborationRemoteOperation).toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

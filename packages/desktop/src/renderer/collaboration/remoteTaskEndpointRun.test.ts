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
      status: state === "completed" ? "completed" : "running",
      stateVersion: 1
    },
    runtime: { ref: blockRef, status: state === "completed" ? "completed" : "in_progress" }
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
});

import {
  remoteOperationObservationSchema,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import {
  canvasRuntimeStatusProjectionSchema,
  type CanvasRuntimeStatusProjection
} from "@planweave-ai/collaboration-protocol/canvas/status";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import { describe, expect, it, vi } from "vitest";
import { runRemoteTaskEndpoint, waitForRemoteOperationTerminal } from "./remoteTaskEndpointRun";

const task: DesktopGraphViewModel["tasks"][number] = {
  taskId: "T-001",
  title: "Task",
  status: "ready",
  executor: "codex",
  executorLabel: "codex",
  promptMarkdown: "# Task",
  promptMissing: false,
  promptPreview: "Task",
  sharedResources: [],
  blocks: ["B-001", "B-002"].map((blockId) => ({
    ref: `T-001#${blockId}`,
    blockId,
    type: "implementation" as const,
    title: blockId,
    status: "ready" as const,
    executor: null,
    requiredCapabilities: ["acp.codex"],
    promptMissing: false,
    exceptionReason: null,
    dispatchable: true,
    remoteExecution: null
  })),
  blockPreview: [],
  hiddenBlockRefs: [],
  overflowBlockCount: 0,
  exceptions: []
};

function runtimeStatus(input: {
  taskStatus: "ready" | "in_progress" | "implemented";
  dispatchableBlockRef?: string;
  blockedReason?: string;
}): CanvasRuntimeStatusProjection {
  return canvasRuntimeStatusProjectionSchema.parse({
    schemaVersion: "canvas-runtime-status/v2",
    scope: { workspaceId: "workspace-1", projectId: "project-1", canvasId: "canvas-1" },
    packageFingerprint: `pkg-${"a".repeat(64)}`,
    capturedAt: "2026-08-05T00:00:00.000Z",
    tasks: [{ taskId: task.taskId, status: input.taskStatus, openFeedbackCount: 0 }],
    blocks: task.blocks.map((block) => ({
      ref: block.ref,
      status:
        input.blockedReason && block.ref === "T-001#B-001"
          ? ("blocked" as const)
          : input.dispatchableBlockRef === block.ref
            ? ("ready" as const)
            : ("completed" as const),
      completionReason: input.dispatchableBlockRef === block.ref ? null : ("passed" as const),
      blockedReason: block.ref === "T-001#B-001" ? (input.blockedReason ?? null) : null,
      divergenceReason: null,
      dispatchable: input.dispatchableBlockRef === block.ref
    }))
  });
}

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

describe("remote Task Endpoint run", () => {
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

  it("dispatches each authoritative next Block to completion in graph order", async () => {
    const readRuntimeStatus = vi
      .fn()
      .mockResolvedValueOnce(
        runtimeStatus({ taskStatus: "ready", dispatchableBlockRef: "T-001#B-001" })
      )
      .mockResolvedValueOnce(
        runtimeStatus({ taskStatus: "in_progress", dispatchableBlockRef: "T-001#B-002" })
      )
      .mockResolvedValueOnce(runtimeStatus({ taskStatus: "implemented" }));
    const dispatchBlock = vi.fn(async (blockRef: string) => operation(blockRef, "running"));
    const waitForTerminal = vi.fn(async (current: RemoteOperationObservation) =>
      operation(current.blockRef, "completed")
    );

    await runRemoteTaskEndpoint({ task, readRuntimeStatus, dispatchBlock, waitForTerminal });

    expect(dispatchBlock.mock.calls.map(([blockRef]) => blockRef)).toEqual([
      "T-001#B-001",
      "T-001#B-002"
    ]);
    expect(waitForTerminal).toHaveBeenCalledTimes(2);
    expect(readRuntimeStatus).toHaveBeenCalledTimes(3);
  });

  it("stops with the Runtime reason instead of falling back when the Task is blocked", async () => {
    const dispatchBlock = vi.fn();

    await expect(
      runRemoteTaskEndpoint({
        task,
        readRuntimeStatus: async () =>
          runtimeStatus({ taskStatus: "in_progress", blockedReason: "dependency_failed" }),
        dispatchBlock,
        waitForTerminal: vi.fn()
      })
    ).rejects.toThrow("dependency_failed");
    expect(dispatchBlock).not.toHaveBeenCalled();
  });
});

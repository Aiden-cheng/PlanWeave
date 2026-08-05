/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import type { DesktopGraphViewModel, DesktopProjectSummary } from "@planweave-ai/runtime";
import type { RemoteOperationObservation } from "@planweave-ai/collaboration-protocol/remote-run";
import { describe, expect, it, vi } from "vitest";
import { agentEndpointPreferenceKey } from "../renderer/collaboration/agentEndpointPreferences";
import type { AvailableAgentEndpoint } from "../renderer/collaboration/agentEndpointViewModel";
import { useWorkspaceAgentEndpointRun } from "../renderer/hooks/useWorkspaceAgentEndpointRun";

const graph: DesktopGraphViewModel = {
  projectId: "project-local",
  projectTitle: "Project",
  graphVersion: "graph-v1",
  packageFingerprint: "package-v1",
  executorOptions: ["codex"],
  autoRunPreflightExecutorHint: "codex",
  tasks: [
    {
      taskId: "T-001",
      title: "Task",
      status: "ready",
      executor: "codex",
      executorLabel: "codex",
      promptMarkdown: "# Task",
      promptMissing: false,
      promptPreview: "Task",
      sharedResources: [],
      blocks: [
        {
          ref: "T-001#B-001",
          blockId: "B-001",
          type: "implementation",
          title: "Block",
          status: "ready",
          executor: null,
          requiredCapabilities: ["acp.codex"],
          promptMissing: false,
          exceptionReason: null,
          dispatchable: true,
          remoteExecution: null
        }
      ],
      blockPreview: [],
      hiddenBlockRefs: [],
      overflowBlockCount: 0,
      exceptions: []
    }
  ],
  edges: [],
  sharedResourceGroups: [],
  diagnostics: [],
  dirtyPromptRefs: []
};

const project: DesktopProjectSummary = {
  projectId: "project-local",
  name: "Project",
  kind: "external",
  rootPath: "/workspace/project",
  sourceRoot: "/workspace/project",
  workspaceRoot: "/workspace/project/.planweave",
  activeCanvasId: "canvas-main",
  taskCanvases: []
};

const remoteEndpoint: AvailableAgentEndpoint = {
  id: "remote:endpoint-windows",
  source: "remote",
  executorName: "codex",
  displayName: "Codex",
  locationName: "LINANIML",
  available: true,
  unavailableReason: null,
  capabilities: ["acp.codex"],
  remoteEndpointId: "endpoint-windows"
};

const taskPreferenceKey = agentEndpointPreferenceKey({
  projectRoot: project.rootPath,
  canvasId: "canvas-main",
  scope: { kind: "task", taskId: "T-001" }
});

function operation(state: RemoteOperationObservation["state"]): RemoteOperationObservation {
  return {
    operationId: "operation-1",
    projectId: "project-server",
    canvasId: "canvas-main",
    blockRef: "T-001#B-001",
    state,
    dispatchId: "dispatch-1",
    executionAttemptId: "attempt-1",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:01.000Z",
    attempt: {
      executionAttemptId: "attempt-1",
      dispatchId: "dispatch-1",
      status: state === "completed" ? "completed" : "running",
      stateVersion: 1
    },
    runtime: { ref: "T-001#B-001", status: state === "completed" ? "completed" : "in_progress" }
  };
}

function renderRun(input?: { endpoint?: AvailableAgentEndpoint }) {
  const dispatch = vi.fn(async () => operation("running"));
  const ensureWorkAuthority = vi.fn(async () => ({
    revisions: { responsibilityRevision: 7, reviewerRevision: 11 }
  }));
  const setError = vi.fn();
  const startLocal = vi.fn(async () => undefined);
  const readRuntimeStatus = vi
    .fn()
    .mockResolvedValueOnce({
      schemaVersion: "canvas-runtime-status/v2",
      scope: { workspaceId: "workspace-1", projectId: "project-server", canvasId: "canvas-main" },
      packageFingerprint: `pkg-${"a".repeat(64)}`,
      capturedAt: "2026-08-05T00:00:00.000Z",
      tasks: [{ taskId: "T-001", status: "ready", openFeedbackCount: 0 }],
      blocks: [
        {
          ref: "T-001#B-001",
          status: "ready",
          completionReason: null,
          blockedReason: null,
          divergenceReason: null,
          dispatchable: true
        }
      ]
    })
    .mockResolvedValue({
      schemaVersion: "canvas-runtime-status/v2",
      scope: { workspaceId: "workspace-1", projectId: "project-server", canvasId: "canvas-main" },
      packageFingerprint: `pkg-${"a".repeat(64)}`,
      capturedAt: "2026-08-05T00:00:02.000Z",
      tasks: [{ taskId: "T-001", status: "implemented", openFeedbackCount: 0 }],
      blocks: [
        {
          ref: "T-001#B-001",
          status: "completed",
          completionReason: "passed",
          blockedReason: null,
          divergenceReason: null,
          dispatchable: false
        }
      ]
    });
  const waitForTerminal = vi.fn(async () => operation("completed"));
  const hook = renderHook(() =>
    useWorkspaceAgentEndpointRun({
      activeProjectId: "project-server",
      agentEndpoints: [input?.endpoint ?? remoteEndpoint],
      collaborationController: { ensureWorkAuthority },
      graph,
      preferences: {
        [taskPreferenceKey]: {
          executorName: "codex",
          remoteEndpointId: "endpoint-windows"
        }
      },
      selectedCanvasId: "canvas-main",
      selectedProject: project,
      setError,
      startLocal,
      api: {
        dispatchCollaborationRemoteOperation: dispatch,
        observeCollaborationRemoteOperation: vi.fn(async () => operation("completed")),
        onCollaborationObserverSignal: vi.fn(() => () => undefined),
        readCollaborationCanvasRuntimeStatus: readRuntimeStatus
      },
      createId: () => "operation-1",
      waitForTerminal
    })
  );
  return {
    ...hook,
    dispatch,
    ensureWorkAuthority,
    readRuntimeStatus,
    setError,
    startLocal,
    waitForTerminal
  };
}

describe("workspace Agent Endpoint routing", () => {
  it("dispatches an inherited Block to the exact remote endpoint selected on its Task", async () => {
    const { result, dispatch, ensureWorkAuthority, setError, startLocal } = renderRun();

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(ensureWorkAuthority).toHaveBeenCalledWith({
      kind: "block",
      canvasId: "canvas-main",
      blockRef: "T-001#B-001"
    });
    expect(dispatch).toHaveBeenCalledWith({
      schemaVersion: "remote-run/v3",
      projectId: "project-server",
      canvasId: "canvas-main",
      blockRef: "T-001#B-001",
      agentEndpointId: "endpoint-windows",
      idempotencyKey: "desktop-dispatch-operation-1",
      expectedResponsibilityRevision: 7,
      expectedReviewerRevision: 11
    });
    expect(startLocal).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("keeps logical executor capability requirements as a dispatch gate", async () => {
    const { result, dispatch, ensureWorkAuthority, setError } = renderRun({
      endpoint: { ...remoteEndpoint, capabilities: [] }
    });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(ensureWorkAuthority).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith("agent_endpoint_incompatible");
  });

  it("runs a remote Task through its next authoritative Block and waits for completion", async () => {
    const {
      result,
      dispatch,
      ensureWorkAuthority,
      readRuntimeStatus,
      setError,
      startLocal,
      waitForTerminal
    } = renderRun();

    await act(() => result.current({ kind: "task", taskId: "T-001" }));

    expect(readRuntimeStatus).toHaveBeenCalledTimes(2);
    expect(ensureWorkAuthority).toHaveBeenCalledWith({
      kind: "block",
      canvasId: "canvas-main",
      blockRef: "T-001#B-001"
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        blockRef: "T-001#B-001",
        agentEndpointId: "endpoint-windows"
      })
    );
    expect(waitForTerminal).toHaveBeenCalledTimes(1);
    expect(startLocal).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });
});

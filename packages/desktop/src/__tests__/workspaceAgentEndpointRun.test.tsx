/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import type {
  DesktopAutoRunState,
  DesktopGraphViewModel,
  DesktopProjectSummary
} from "@planweave-ai/runtime";
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

function operation(
  state: RemoteOperationObservation["state"],
  failure?: RemoteOperationObservation["failure"]
): RemoteOperationObservation {
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
      status: state === "completed" ? "completed" : state === "failed" ? "failed" : "running",
      stateVersion: 1
    },
    ...(failure ? { failure } : {}),
    runtime: { ref: "T-001#B-001", status: state === "completed" ? "completed" : "in_progress" }
  };
}

function localRunState(phase: DesktopAutoRunState["phase"]): DesktopAutoRunState {
  return {
    runId: "DESKTOP-RUN-LOCAL",
    projectRoot: project.rootPath,
    canvasId: "canvas-main",
    scope: { kind: "block", blockRef: "T-001#B-001" },
    phase,
    stepCount: phase === "completed" ? 1 : 0,
    stepLimit: 20,
    currentRef: phase === "running" ? "T-001#B-001" : null,
    currentExecutor: phase === "running" ? "codex" : null,
    elapsedMs: 1,
    latestOutputSummary: null,
    latestRecordId: null,
    latestRecordPath: null,
    explanation: {
      phase,
      currentRef: phase === "running" ? "T-001#B-001" : null,
      currentExecutor: phase === "running" ? "codex" : null,
      latestRecordId: null,
      latestRecordPath: null,
      latestOutputSummary: null,
      error: null,
      nextAction: {
        kind: phase === "completed" ? "wait" : "wait",
        message: "Wait.",
        command: null,
        targetPath: null,
        ref: null
      }
    },
    statePath: "/workspace/run/state.json",
    eventLogPath: "/workspace/run/events.ndjson",
    options: { tmuxEnabled: false },
    error: null,
    startedAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:01.000Z"
  };
}

function renderRun(input?: {
  endpoint?: AvailableAgentEndpoint;
  endpoints?: AvailableAgentEndpoint[];
  graph?: DesktopGraphViewModel;
  preferences?: Record<string, { executorName: string; remoteEndpointId: string }>;
  readRuntimeStatus?: ReturnType<typeof vi.fn>;
  activeProjectId?: string | null;
  remoteTerminal?: RemoteOperationObservation;
}) {
  const dispatch = vi.fn(async () => operation("running"));
  const observe = vi.fn(async () => operation("running"));
  const executeAction = vi.fn(async () => ({
    request: { kind: "retry_new_attempt" },
    state: "settled"
  }));
  const ensureWorkAuthority = vi.fn(async () => ({
    revisions: { responsibilityRevision: 7, reviewerRevision: 11 }
  }));
  const setError = vi.fn();
  const startLocal = vi.fn(async () => localRunState("running"));
  const readRuntimeStatus =
    input?.readRuntimeStatus ??
    vi
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
  const waitForTerminal = vi.fn(async () => input?.remoteTerminal ?? operation("completed"));
  const waitForLocalTerminal = vi.fn(async () => localRunState("completed"));
  const hook = renderHook(() => {
    const startWithEndpoint = useWorkspaceAgentEndpointRun({
      activeProjectId:
        input?.activeProjectId === undefined ? "project-server" : input.activeProjectId,
      agentEndpoints: input?.endpoints ?? [input?.endpoint ?? remoteEndpoint],
      collaborationController: { ensureWorkAuthority },
      graph: input?.graph ?? graph,
      preferences:
        input?.preferences ??
        (input?.endpoint?.source === "local"
          ? {}
          : {
              [taskPreferenceKey]: {
                executorName: "codex",
                remoteEndpointId: "endpoint-windows"
              }
            }),
      selectedCanvasId: "canvas-main",
      selectedProject: project,
      setError,
      api: {
        dispatchCollaborationRemoteOperation: dispatch,
        observeCollaborationRemoteOperation: observe,
        executeCollaborationRemoteOperationAction: executeAction,
        onCollaborationObserverSignal: vi.fn(() => () => undefined),
        readCollaborationCanvasRuntimeStatus: readRuntimeStatus
      },
      createId: () => "operation-1",
      localAutoRunApi: {
        getAutoRunState: vi.fn(async () => localRunState("completed")),
        onAutoRunChanged: vi.fn(() => () => undefined)
      },
      waitForLocalTerminal,
      waitForTerminal
    });
    return (scope: Parameters<typeof startWithEndpoint>[0]) => startWithEndpoint(scope, startLocal);
  });
  return {
    ...hook,
    dispatch,
    observe,
    executeAction,
    ensureWorkAuthority,
    readRuntimeStatus,
    setError,
    startLocal,
    waitForLocalTerminal,
    waitForTerminal
  };
}

describe("workspace Agent Endpoint routing", () => {
  it("does not silently replace remote Task endpoints with local Project Auto Run", async () => {
    const { result, dispatch, setError, startLocal, waitForTerminal } = renderRun();

    await act(() => result.current({ kind: "project" }));

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

  it("retries an interrupted remote attempt instead of dispatching a conflicting operation", async () => {
    const graphWithInterruptedOwnership: DesktopGraphViewModel = {
      ...graph,
      tasks: graph.tasks.map((task) => ({
        ...task,
        blocks: task.blocks.map((block) => ({
          ...block,
          status: "in_progress",
          remoteExecution: {
            identity: { operationId: "operation-interrupted" },
            phase: "active",
            status: "interrupted",
            actionRequired: true,
            source: { revision: "source-1", graphFingerprint: "fingerprint-1" },
            dispatchAttempt: {
              dispatchId: "dispatch-interrupted",
              executionAttemptId: "attempt-interrupted"
            }
          }
        }))
      }))
    };
    const interrupted = {
      ...operation("interrupted"),
      operationId: "operation-interrupted",
      dispatchId: "dispatch-interrupted",
      executionAttemptId: "attempt-interrupted",
      attempt: {
        executionAttemptId: "attempt-interrupted",
        dispatchId: "dispatch-interrupted",
        status: "interrupted" as const,
        leaseId: "lease-interrupted",
        stateVersion: 3
      },
      runtime: {
        ref: "T-001#B-001",
        status: "interrupted" as const,
        interruption: { resumable: false as const }
      }
    };
    const recovered = {
      ...operation("running"),
      operationId: "operation-interrupted",
      dispatchId: "dispatch-retry-operation-1",
      executionAttemptId: "attempt-retry-operation-1"
    };
    const { result, dispatch, observe, executeAction, waitForTerminal, setError } = renderRun({
      graph: graphWithInterruptedOwnership
    });
    observe.mockResolvedValueOnce(interrupted).mockResolvedValue(recovered);

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith({ operationId: "operation-interrupted" });
    expect(executeAction).toHaveBeenCalledWith({
      operationId: "operation-interrupted",
      action: expect.objectContaining({
        kind: "retry_new_attempt",
        priorLeaseId: "lease-interrupted",
        newDispatchId: "dispatch-retry-operation-1",
        newExecutionAttemptId: "attempt-retry-operation-1"
      })
    });
    expect(waitForTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        initial: expect.objectContaining({ operationId: "operation-interrupted" })
      })
    );
    expect(setError).not.toHaveBeenCalled();
  });

  it("resumes a resumable interrupted remote attempt after Host reconnect", async () => {
    const graphWithInterruptedOwnership: DesktopGraphViewModel = {
      ...graph,
      tasks: graph.tasks.map((task) => ({
        ...task,
        blocks: task.blocks.map((block) => ({
          ...block,
          status: "in_progress",
          remoteExecution: {
            identity: { operationId: "operation-resume" },
            phase: "active",
            status: "interrupted",
            actionRequired: true,
            source: { revision: "source-1", graphFingerprint: "fingerprint-1" },
            dispatchAttempt: {
              dispatchId: "dispatch-resume",
              executionAttemptId: "attempt-resume"
            }
          }
        }))
      }))
    };
    const interrupted = {
      ...operation("interrupted"),
      operationId: "operation-resume",
      dispatchId: "dispatch-resume",
      executionAttemptId: "attempt-resume",
      attempt: {
        executionAttemptId: "attempt-resume",
        dispatchId: "dispatch-resume",
        status: "interrupted" as const,
        leaseId: "lease-resume",
        stateVersion: 2
      },
      runtime: {
        ref: "T-001#B-001",
        status: "interrupted" as const,
        interruption: {
          resumable: true as const,
          recovery: { acpSessionId: "session-1", recoveryId: "recovery-1" }
        }
      }
    };
    const resumed = {
      ...operation("running"),
      operationId: "operation-resume",
      dispatchId: "dispatch-resume",
      executionAttemptId: "attempt-resume"
    };
    const { result, dispatch, observe, executeAction, waitForTerminal, setError } = renderRun({
      graph: graphWithInterruptedOwnership
    });
    observe.mockResolvedValueOnce(interrupted).mockResolvedValue(resumed);

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(executeAction).toHaveBeenCalledWith({
      operationId: "operation-resume",
      action: expect.objectContaining({
        kind: "resume_same_session",
        priorLeaseId: "lease-resume"
      })
    });
    expect(waitForTerminal).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it("reattaches to a non-terminal remote Block operation instead of dispatching a conflict", async () => {
    const existingOperationId = "operation-existing";
    const graphWithRemoteOwnership: DesktopGraphViewModel = {
      ...graph,
      tasks: graph.tasks.map((task) => ({
        ...task,
        blocks: task.blocks.map((block) => ({
          ...block,
          status: "in_progress",
          remoteExecution: {
            identity: { operationId: existingOperationId },
            phase: "preparing",
            status: "owned",
            actionRequired: false,
            source: { revision: "source-1", graphFingerprint: "fingerprint-1" },
            dispatchAttempt: null
          }
        }))
      }))
    };
    const { result, dispatch, observe, ensureWorkAuthority, waitForTerminal, setError } = renderRun(
      {
        graph: graphWithRemoteOwnership
      }
    );

    await act(() => result.current({ kind: "project" }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith({ operationId: existingOperationId });
    expect(ensureWorkAuthority).not.toHaveBeenCalled();
    expect(waitForTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        initial: expect.objectContaining({ operationId: "operation-1" })
      })
    );
    expect(setError).not.toHaveBeenCalled();
  });

  it("inherits the Task endpoint for a compatible Block with an explicit logical executor", async () => {
    const explicitExecutorGraph: DesktopGraphViewModel = {
      ...graph,
      tasks: graph.tasks.map((task) => ({
        ...task,
        blocks: task.blocks.map((block) => ({ ...block, executor: "codex" }))
      }))
    };
    const { result, dispatch, setError, startLocal } = renderRun({ graph: explicitExecutorGraph });

    await act(() => result.current({ kind: "project" }));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        blockRef: "T-001#B-001",
        agentEndpointId: "endpoint-windows"
      })
    );
    expect(startLocal).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("fails Project preflight before partial execution when a selected endpoint is unavailable", async () => {
    const { result, dispatch, readRuntimeStatus, setError, startLocal } = renderRun({
      endpoint: {
        ...remoteEndpoint,
        available: false,
        unavailableReason: "agent_endpoint_host_offline"
      }
    });

    await act(() => result.current({ kind: "project" }));

    expect(setError).toHaveBeenCalledWith("agent_endpoint_host_offline");
    expect(readRuntimeStatus).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(startLocal).not.toHaveBeenCalled();
  });

  it("preserves the existing Runtime Auto Run path for an all-local Project", async () => {
    const localEndpoint: AvailableAgentEndpoint = {
      id: "local:codex",
      source: "local",
      executorName: "codex",
      displayName: "Codex",
      locationName: null,
      available: true,
      unavailableReason: null,
      capabilities: ["acp.codex"],
      remoteEndpointId: null
    };
    const { result, dispatch, setError, startLocal } = renderRun({ endpoint: localEndpoint });

    await act(() => result.current({ kind: "project" }));

    expect(startLocal).toHaveBeenCalledWith({ kind: "project" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
  });

  it("returns an explicit local-review Block to the local adapter after a remote implementation", async () => {
    const mixedGraph: DesktopGraphViewModel = {
      ...graph,
      tasks: [
        {
          ...graph.tasks[0]!,
          blocks: [
            graph.tasks[0]!.blocks[0]!,
            {
              ...graph.tasks[0]!.blocks[0]!,
              ref: "T-001#R-001",
              blockId: "R-001",
              type: "review",
              title: "Review",
              status: "planned",
              executor: "local-review",
              requiredCapabilities: []
            }
          ]
        }
      ]
    };
    const statusBase = {
      schemaVersion: "canvas-runtime-status/v2" as const,
      scope: { workspaceId: "workspace-1", projectId: "project-server", canvasId: "canvas-main" },
      packageFingerprint: `pkg-${"a".repeat(64)}`,
      capturedAt: "2026-08-05T00:00:00.000Z"
    };
    const readRuntimeStatus = vi
      .fn()
      .mockResolvedValueOnce({
        ...statusBase,
        tasks: [{ taskId: "T-001", status: "ready", openFeedbackCount: 0 }],
        blocks: [
          {
            ref: "T-001#B-001",
            status: "ready",
            completionReason: null,
            blockedReason: null,
            divergenceReason: null,
            dispatchable: true
          },
          {
            ref: "T-001#R-001",
            status: "planned",
            completionReason: null,
            blockedReason: null,
            divergenceReason: null,
            dispatchable: false
          }
        ]
      })
      .mockResolvedValueOnce({
        ...statusBase,
        tasks: [{ taskId: "T-001", status: "in_progress", openFeedbackCount: 0 }],
        blocks: [
          {
            ref: "T-001#B-001",
            status: "completed",
            completionReason: "submitted",
            blockedReason: null,
            divergenceReason: null,
            dispatchable: false
          },
          {
            ref: "T-001#R-001",
            status: "ready",
            completionReason: null,
            blockedReason: null,
            divergenceReason: null,
            dispatchable: true
          }
        ]
      })
      .mockResolvedValue({
        ...statusBase,
        tasks: [{ taskId: "T-001", status: "implemented", openFeedbackCount: 0 }],
        blocks: [
          {
            ref: "T-001#B-001",
            status: "completed",
            completionReason: "submitted",
            blockedReason: null,
            divergenceReason: null,
            dispatchable: false
          },
          {
            ref: "T-001#R-001",
            status: "completed",
            completionReason: "passed",
            blockedReason: null,
            divergenceReason: null,
            dispatchable: false
          }
        ]
      });
    const localReview: AvailableAgentEndpoint = {
      id: "local:local-review",
      source: "local",
      executorName: "local-review",
      displayName: "Local Review",
      locationName: null,
      available: true,
      unavailableReason: null,
      capabilities: [],
      remoteEndpointId: null
    };
    const { result, dispatch, setError, startLocal } = renderRun({
      endpoints: [remoteEndpoint, localReview],
      graph: mixedGraph,
      preferences: {
        [taskPreferenceKey]: {
          executorName: "codex",
          remoteEndpointId: "endpoint-windows"
        }
      },
      readRuntimeStatus
    });

    await act(() => result.current({ kind: "project" }));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ blockRef: "T-001#B-001" }));
    expect(startLocal).toHaveBeenCalledTimes(1);
    expect(startLocal).toHaveBeenCalledWith({ kind: "block", blockRef: "T-001#R-001" });
    expect(setError).not.toHaveBeenCalled();
  });

  it("dispatches an inherited Block to the exact remote endpoint selected on its Task", async () => {
    const graphWithFollowingBlock: DesktopGraphViewModel = {
      ...graph,
      tasks: graph.tasks.map((task) => ({
        ...task,
        blocks: [
          ...task.blocks,
          {
            ...task.blocks[0]!,
            ref: "T-001#B-002",
            blockId: "B-002",
            title: "Following Block"
          }
        ]
      }))
    };
    const { result, dispatch, ensureWorkAuthority, setError, startLocal } = renderRun({
      graph: graphWithFollowingBlock
    });

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
    expect(dispatch).toHaveBeenCalledTimes(1);
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

  it("surfaces the normalized Host failure instead of a generic remote state", async () => {
    const { result, setError } = renderRun({
      remoteTerminal: operation("failed", {
        code: "acp_authentication_required",
        message: "ACP authentication is required.",
        retryable: false
      })
    });

    await act(() => result.current({ kind: "block", blockRef: "T-001#B-001" }));

    expect(setError).toHaveBeenCalledWith(
      "ACP authentication is required. (acp_authentication_required)"
    );
  });
});

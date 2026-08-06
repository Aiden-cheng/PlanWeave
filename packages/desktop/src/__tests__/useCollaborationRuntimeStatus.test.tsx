// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { graph as graphFixture } from "./helpers/graphFixtures";
import {
  COLLABORATION_RUNTIME_STATUS_POLL_MS,
  mergeCollaborationRuntimeStatus,
  useCollaborationRuntimeStatus
} from "../renderer/hooks/useCollaborationRuntimeStatus";

afterEach(() => {
  vi.useRealTimers();
});

const scope = { workspaceId: "w", projectId: "remote-project", canvasId: "default" };

const graphWithBlock = {
  ...graphFixture,
  tasks: graphFixture.tasks.map((task) =>
    task.taskId === "T-ALPHA"
      ? {
          ...task,
          blocks: [
            {
              ref: "T-ALPHA#B-001",
              blockId: "B-001",
              type: "implementation" as const,
              title: "Alpha implementation",
              status: "ready" as const,
              executor: null,
              requiredCapabilities: [],
              promptMissing: false,
              exceptionReason: null,
              dispatchable: false,
              remoteExecution: null
            }
          ],
          blockPreview: []
        }
      : task
  )
};

const localAuthoritativeGraph = {
  ...graphWithBlock,
  tasks: graphWithBlock.tasks.map((task) => ({
    ...task,
    blocks: task.blocks.map((block) => ({ ...block, dispatchable: true })),
    blockPreview: task.blockPreview.map((block) => ({ ...block, dispatchable: true }))
  }))
};

const remoteStatus = {
  schemaVersion: "canvas-runtime-status/v2" as const,
  scope,
  packageFingerprint: graphFixture.packageFingerprint,
  capturedAt: "2026-08-01T00:00:00.000Z",
  tasks: [
    { taskId: "T-ALPHA", status: "implemented" as const, openFeedbackCount: 0 },
    { taskId: "T-BETA", status: "ready" as const, openFeedbackCount: 0 }
  ],
  blocks: [
    {
      ref: "T-ALPHA#B-001",
      status: "ready" as const,
      completionReason: null,
      blockedReason: null,
      divergenceReason: null,
      dispatchable: true
    }
  ]
};

function api(read = vi.fn().mockResolvedValue(remoteStatus)) {
  return {
    readCollaborationCanvasRuntimeStatus: read,
    resolveCollaborationCanvasScope: vi.fn().mockResolvedValue({
      workspaceId: "w",
      projectId: "remote-project",
      canvasId: "default"
    })
  };
}

function hookInput(override: Partial<Parameters<typeof useCollaborationRuntimeStatus>[0]> = {}) {
  return {
    enabled: true,
    sessionConnected: true,
    profileId: "profile-1",
    activeProjectId: "remote-project",
    localProjectId: "local-replica",
    localCanvasId: "default",
    graph: graphWithBlock,
    api: api(),
    ...override
  };
}

describe("collaboration runtime status", () => {
  it("preserves the local Runtime graph when collaboration status projection is disabled", () => {
    const bridge = api();
    const { result } = renderHook(() =>
      useCollaborationRuntimeStatus(
        hookInput({
          api: bridge,
          enabled: false,
          graph: localAuthoritativeGraph,
          sessionConnected: false
        })
      )
    );

    expect(bridge.resolveCollaborationCanvasScope).not.toHaveBeenCalled();
    expect(bridge.readCollaborationCanvasRuntimeStatus).not.toHaveBeenCalled();
    expect(result.current.graph).toBe(localAuthoritativeGraph);
    expect(result.current.graph?.tasks[0]?.status).toBe("ready");
    expect(result.current.graph?.tasks[0]?.blocks[0]?.dispatchable).toBe(true);
  });

  it("overlays only the exact expected scope, graph identity, and package fingerprint", () => {
    const merged = mergeCollaborationRuntimeStatus(graphWithBlock, remoteStatus, scope);
    expect(merged.tasks[0]?.status).toBe("implemented");
    expect(merged.tasks[0]?.blocks[0]?.dispatchable).toBe(true);

    for (const invalidStatus of [
      { ...remoteStatus, tasks: remoteStatus.tasks.slice(0, 1) },
      {
        ...remoteStatus,
        tasks: [
          ...remoteStatus.tasks,
          { taskId: "T-EXTRA", status: "ready" as const, openFeedbackCount: 0 }
        ]
      },
      { ...remoteStatus, blocks: [] },
      {
        ...remoteStatus,
        blocks: [
          ...remoteStatus.blocks,
          {
            ref: "T-ALPHA#B-EXTRA",
            status: "ready" as const,
            completionReason: null,
            blockedReason: null,
            divergenceReason: null,
            dispatchable: true
          }
        ]
      }
    ]) {
      const failClosed = mergeCollaborationRuntimeStatus(graphWithBlock, invalidStatus, scope);
      expect(failClosed.tasks[0]?.status).toBe("ready");
      expect(failClosed.tasks[0]?.blocks[0]?.dispatchable).toBe(false);
    }

    const contentChanged = mergeCollaborationRuntimeStatus(
      { ...graphWithBlock, packageFingerprint: `pkg-${"b".repeat(64)}` },
      remoteStatus,
      scope
    );
    expect(contentChanged.tasks[0]?.status).toBe("implemented");
    expect(contentChanged.tasks[0]?.blocks[0]?.status).toBe("ready");
    expect(contentChanged.tasks[0]?.blocks[0]?.dispatchable).toBe(false);

    const scopeMismatch = mergeCollaborationRuntimeStatus(graphWithBlock, remoteStatus, {
      ...scope,
      canvasId: "other"
    });
    expect(scopeMismatch.tasks[0]?.blocks[0]?.dispatchable).toBe(false);

    const workspaceMismatch = mergeCollaborationRuntimeStatus(graphWithBlock, remoteStatus, {
      ...scope,
      workspaceId: "other-workspace"
    });
    expect(workspaceMismatch.tasks[0]?.blocks[0]?.dispatchable).toBe(false);
  });

  it("clears a prior overlay immediately when the profile or canvas identity changes", async () => {
    const bridge = api();
    const { result, rerender } = renderHook(({ input }) => useCollaborationRuntimeStatus(input), {
      initialProps: { input: hookInput({ api: bridge }) }
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.graph?.tasks[0]?.status).toBe("implemented");

    rerender({ input: hookInput({ api: bridge, profileId: "profile-2" }) });
    expect(result.current.graph?.tasks[0]?.status).toBe("ready");
    expect(result.current.graph?.tasks[0]?.blocks[0]?.dispatchable).toBe(false);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.graph?.tasks[0]?.status).toBe("implemented");
  });

  it("keeps the last committed status while same-canvas content refresh is pending", async () => {
    let resolveRefresh: ((status: typeof remoteStatus) => void) | null = null;
    const pendingRefresh = new Promise<typeof remoteStatus>((resolve) => {
      resolveRefresh = resolve;
    });
    const read = vi.fn().mockResolvedValueOnce(remoteStatus).mockReturnValueOnce(pendingRefresh);
    const bridge = api(read);
    const { result, rerender } = renderHook(({ input }) => useCollaborationRuntimeStatus(input), {
      initialProps: { input: hookInput({ api: bridge }) }
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.graph?.tasks[0]?.status).toBe("implemented");

    const changedGraph = {
      ...graphWithBlock,
      packageFingerprint: `pkg-${"b".repeat(64)}`
    };
    rerender({ input: hookInput({ api: bridge, graph: changedGraph }) });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.graph?.tasks[0]?.status).toBe("implemented");
    expect(result.current.graph?.tasks[0]?.blocks[0]?.dispatchable).toBe(false);

    await act(async () => {
      resolveRefresh?.(remoteStatus);
      await pendingRefresh;
    });
  });

  it("preserves status but disables dispatch when shared content changes ahead of Runtime", async () => {
    const bridge = api();
    const changedGraph = {
      ...graphWithBlock,
      packageFingerprint: `pkg-${"b".repeat(64)}`
    };
    const { result } = renderHook(() =>
      useCollaborationRuntimeStatus(hookInput({ api: bridge, graph: changedGraph }))
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.graph?.tasks[0]?.status).toBe("implemented");
    expect(result.current.graph?.tasks[0]?.blocks[0]?.status).toBe("ready");
    expect(result.current.graph?.tasks[0]?.blocks[0]?.dispatchable).toBe(false);
  });

  it("keeps the last confirmed overlay read-only when a refresh fails", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn()
      .mockResolvedValueOnce(remoteStatus)
      .mockRejectedValueOnce(new Error("network_down"));
    const bridge = api(read);
    const { result } = renderHook(() => useCollaborationRuntimeStatus(hookInput({ api: bridge })));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.graph?.tasks[0]?.status).toBe("implemented");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLLABORATION_RUNTIME_STATUS_POLL_MS);
    });
    expect(result.current.graph?.tasks[0]?.status).toBe("implemented");
    expect(result.current.graph?.tasks[0]?.blocks[0]?.dispatchable).toBe(false);
    expect(result.current.error).toBe("network_down");
  });

  it("loads the persisted status once while the collaboration session is offline", async () => {
    const bridge = api();
    const { result } = renderHook(() =>
      useCollaborationRuntimeStatus(hookInput({ api: bridge, sessionConnected: false }))
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bridge.readCollaborationCanvasRuntimeStatus).toHaveBeenCalledTimes(1);
    expect(result.current.graph?.tasks[0]?.status).toBe("implemented");
    expect(result.current.graph?.tasks[0]?.blocks[0]?.dispatchable).toBe(false);
  });
});

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

const remoteStatus = {
  schemaVersion: "canvas-runtime-status/v1" as const,
  scope: { workspaceId: "w", projectId: "remote-project", canvasId: "default" },
  packageFingerprint: graphFixture.packageFingerprint,
  capturedAt: "2026-08-01T00:00:00.000Z",
  tasks: [{ taskId: "T-ALPHA", status: "implemented" as const, openFeedbackCount: 0 }],
  blocks: []
};

describe("collaboration runtime status", () => {
  it("overlays only a projection for the same package fingerprint", () => {
    const merged = mergeCollaborationRuntimeStatus(graphFixture, remoteStatus);
    expect(merged.tasks[0]?.status).toBe("implemented");

    expect(
      mergeCollaborationRuntimeStatus(graphFixture, {
        ...remoteStatus,
        packageFingerprint: `pkg-${"b".repeat(64)}`
      })
    ).toBe(graphFixture);
  });

  it("reads the remote status by local replica identity and refreshes it", async () => {
    vi.useFakeTimers();
    const readCollaborationCanvasRuntimeStatus = vi.fn().mockResolvedValue(remoteStatus);
    const api = { readCollaborationCanvasRuntimeStatus };
    const { result } = renderHook(() =>
      useCollaborationRuntimeStatus({
        enabled: true,
        sessionConnected: true,
        localProjectId: "local-replica",
        localCanvasId: "default",
        graph: graphFixture,
        api
      })
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.graph?.tasks[0]?.status).toBe("implemented");
    expect(readCollaborationCanvasRuntimeStatus).toHaveBeenCalledWith({
      localProjectId: "local-replica",
      canvasId: "default"
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COLLABORATION_RUNTIME_STATUS_POLL_MS);
    });
    expect(readCollaborationCanvasRuntimeStatus).toHaveBeenCalledTimes(2);
  });
});

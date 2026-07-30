/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { OnSelectionChangeParams } from "@xyflow/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCollaborationCanvasPresence } from "../renderer/hooks/useCollaborationCanvasPresence";
import type { CanvasPresenceBridge } from "../renderer/collaboration/CanvasPresenceController";
import type { CollaborationPresenceSignal } from "../shared/collaboration";
import { createTranslator } from "../renderer/i18n";

const t = createTranslator("en");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function bridgeFixture() {
  let onSignal: ((signal: CollaborationPresenceSignal) => void) | null = null;
  const api: CanvasPresenceBridge = {
    startCollaborationPresence: vi.fn().mockResolvedValue(undefined),
    stopCollaborationPresence: vi.fn().mockResolvedValue(undefined),
    publishCollaborationPresence: vi.fn().mockResolvedValue(undefined),
    onCollaborationPresenceSignal: vi.fn((callback) => {
      onSignal = callback;
      return () => {
        onSignal = null;
      };
    })
  };
  return {
    api,
    emit: (signal: CollaborationPresenceSignal) => onSignal?.(signal)
  };
}

const selection: OnSelectionChangeParams = {
  nodes: [{ id: "T-002" }],
  edges: [{ id: "T-002-depends_on-T-001" }]
};

describe("useCollaborationCanvasPresence", () => {
  it("does not start presence before collaboration is connected", async () => {
    const fixture = bridgeFixture();

    renderHook(() =>
      useCollaborationCanvasPresence({
        api: fixture.api,
        canvasId: "canvas-main",
        enabled: true,
        sessionConnected: false,
        profileId: "profile-1",
        selectedProjectId: "project-1",
        activeProjectId: "project-1",
        t
      })
    );
    await act(async () => Promise.resolve());

    expect(fixture.api.startCollaborationPresence).not.toHaveBeenCalled();
  });

  it("publishes selection only on change and coalesces pointer updates to 20Hz", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const fixture = bridgeFixture();
    const { result } = renderHook(() =>
      useCollaborationCanvasPresence({
        api: fixture.api,
        canvasId: "canvas-main",
        enabled: true,
        sessionConnected: true,
        profileId: "profile-1",
        selectedProjectId: "project-1",
        activeProjectId: "project-1",
        t
      })
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(fixture.api.startCollaborationPresence).toHaveBeenCalled();

    act(() => result.current.onSelectionChange(selection));
    expect(fixture.api.publishCollaborationPresence).toHaveBeenCalledTimes(1);
    act(() => result.current.onSelectionChange(selection));
    expect(fixture.api.publishCollaborationPresence).toHaveBeenCalledTimes(1);

    act(() => result.current.onPointerMove({ x: 10, y: 20 }));
    act(() => result.current.onPointerMove({ x: 11, y: 21 }));
    act(() => frame?.(0));
    expect(fixture.api.publishCollaborationPresence).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(20);
      result.current.onPointerMove({ x: 12, y: 22 });
      frame?.(20);
    });
    expect(fixture.api.publishCollaborationPresence).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(30);
      frame?.(50);
    });
    expect(fixture.api.publishCollaborationPresence).toHaveBeenCalledTimes(3);
    expect(fixture.api.publishCollaborationPresence).toHaveBeenLastCalledWith({
      pointer: { x: 12, y: 22 },
      selectionIds: ["T-002", "T-002-depends_on-T-001"]
    });
  });

  it("renders validated remote snapshots and clears them when the canvas is hidden", async () => {
    const fixture = bridgeFixture();
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useCollaborationCanvasPresence({
          api: fixture.api,
          canvasId: "canvas-main",
          enabled,
          sessionConnected: true,
          profileId: "profile-1",
          selectedProjectId: "project-1",
          activeProjectId: "project-1",
          t
        }),
      { initialProps: { enabled: true } }
    );
    await waitFor(() => expect(fixture.api.startCollaborationPresence).toHaveBeenCalled());
    act(() =>
      fixture.emit({
        profileId: "profile-1",
        message: {
          type: "canvas.presence.snapshot",
          protocolVersion: 1,
          projectId: "project-1",
          canvasId: "canvas-main",
          sessions: [
            {
              identity: {
                sessionId: "session-b",
                humanPrincipalId: "human-b",
                displayName: "  Bob "
              },
              pointer: { x: 10, y: 20 },
              selectionIds: ["T-001"]
            }
          ]
        }
      })
    );
    expect(result.current.remoteSessions[0]?.displayName).toBe("Bob");
    rerender({ enabled: false });
    await waitFor(() => expect(result.current.remoteSessions).toEqual([]));
    expect(fixture.api.stopCollaborationPresence).toHaveBeenCalled();
  });

  it("does not connect or publish when the selected project differs from the active profile", async () => {
    const fixture = bridgeFixture();
    const { result, rerender } = renderHook(
      ({ activeProjectId }) =>
        useCollaborationCanvasPresence({
          api: fixture.api,
          canvasId: "default",
          enabled: true,
          sessionConnected: true,
          profileId: "profile-1",
          selectedProjectId: "project-a",
          activeProjectId,
          t
        }),
      { initialProps: { activeProjectId: "project-b" } }
    );

    await act(async () => Promise.resolve());
    expect(fixture.api.startCollaborationPresence).not.toHaveBeenCalled();
    act(() => result.current.onSelectionChange(selection));
    expect(fixture.api.publishCollaborationPresence).not.toHaveBeenCalled();

    rerender({ activeProjectId: "project-a" });
    await waitFor(() => expect(fixture.api.startCollaborationPresence).toHaveBeenCalledTimes(1));
    rerender({ activeProjectId: "project-b" });
    await waitFor(() => expect(fixture.api.stopCollaborationPresence).toHaveBeenCalled());
  });
});

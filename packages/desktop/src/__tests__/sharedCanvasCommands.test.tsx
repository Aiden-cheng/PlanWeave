/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { exampleCanvasReconnectAfterDisconnect } from "@planweave-ai/collaboration-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";
import type {
  CollaborationCanvasCommandSessionView,
  CollaborationCanvasReconnectResult
} from "../shared/collaboration";
import type { CanvasCommandBridge } from "../renderer/collaboration/CanvasCommandController";
import {
  SHARED_CANVAS_RECONNECT_INTERVAL_MS,
  useSharedCanvasCommands
} from "../renderer/hooks/useSharedCanvasCommands";

const initialSession: CollaborationCanvasCommandSessionView = {
  canvasId: "default",
  revision: 0,
  contentDigest: null,
  lastOperationId: null,
  lastJournalEntryId: null,
  pendingOperationId: null,
  lastConflict: null,
  lastRejectCode: null
};
const translator = createTranslator("en");

const remoteSession: CollaborationCanvasCommandSessionView = {
  ...initialSession,
  revision: exampleCanvasReconnectAfterDisconnect.headRevision,
  contentDigest: exampleCanvasReconnectAfterDisconnect.headContentDigest,
  lastOperationId: exampleCanvasReconnectAfterDisconnect.entries[0]!.operationId,
  lastJournalEntryId: exampleCanvasReconnectAfterDisconnect.entries[0]!.entryId
};

function reconnectResult(
  session: CollaborationCanvasCommandSessionView | null,
  entries: typeof exampleCanvasReconnectAfterDisconnect.entries = []
): CollaborationCanvasReconnectResult {
  return {
    response: { ...exampleCanvasReconnectAfterDisconnect, entries },
    entriesToApply: [...entries],
    snapshotRequired: false,
    session
  };
}

function createBridge(options?: {
  bindError?: Error;
  reconnect?: CanvasCommandBridge["reconnectCollaborationCanvas"];
}) {
  const reconnect = vi.fn<CanvasCommandBridge["reconnectCollaborationCanvas"]>(
    options?.reconnect ?? (async () => reconnectResult(initialSession))
  );
  return {
    api: {
      submitCollaborationCanvasCommand: async () => {
        throw new Error("not used by this hook test");
      },
      reconnectCollaborationCanvas: reconnect,
      bindCollaborationCanvasCommandSession: async () => {
        if (options?.bindError) throw options.bindError;
        return initialSession;
      },
      getCollaborationCanvasCommandSession: async () => initialSession
    },
    reconnect
  };
}

function hookInput(api: CanvasCommandBridge, onAuthoritativeChange?: () => void | Promise<void>) {
  return {
    api,
    enabled: true,
    canvasId: "default",
    projectRoot: "/tmp/project-root",
    profileId: "profile-1",
    selectedProjectId: "project-1",
    activeProjectId: "project-1",
    t: translator,
    onAuthoritativeChange
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

afterEach(() => {
  vi.useRealTimers();
  cleanupRendererTestEnvironment();
});

describe("useSharedCanvasCommands", () => {
  it("keeps the command facade stable when its inputs and snapshot are unchanged", () => {
    const t = createTranslator("en");
    const { result, rerender } = renderHook(() =>
      useSharedCanvasCommands({
        api: null,
        enabled: false,
        canvasId: null,
        projectRoot: null,
        profileId: null,
        selectedProjectId: null,
        activeProjectId: null,
        t
      })
    );
    const initialFacade = result.current;

    rerender();

    expect(result.current).toBe(initialFacade);
  });

  it("polls a remote delta and refreshes the authoritative canvas", async () => {
    vi.useFakeTimers();
    const onAuthoritativeChange = vi.fn();
    const bridge = createBridge({
      reconnect: vi
        .fn<CanvasCommandBridge["reconnectCollaborationCanvas"]>()
        .mockResolvedValueOnce(reconnectResult(initialSession))
        .mockResolvedValueOnce(
          reconnectResult(remoteSession, exampleCanvasReconnectAfterDisconnect.entries)
        )
    });

    const { result } = renderHook(() =>
      useSharedCanvasCommands(hookInput(bridge.api, onAuthoritativeChange))
    );
    await flushEffects();
    expect(bridge.reconnect).toHaveBeenCalledTimes(1);
    onAuthoritativeChange.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARED_CANVAS_RECONNECT_INTERVAL_MS);
    });

    expect(bridge.reconnect).toHaveBeenCalledTimes(2);
    expect(onAuthoritativeChange).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot.session?.revision).toBe(remoteSession.revision);
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const { unmount } = renderHook(() => useSharedCanvasCommands(hookInput(bridge.api)));
    await flushEffects();
    expect(bridge.reconnect).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARED_CANVAS_RECONNECT_INTERVAL_MS * 2);
    });

    expect(bridge.reconnect).toHaveBeenCalledTimes(1);
  });

  it("does not overlap background reconnect requests", async () => {
    vi.useFakeTimers();
    let resolveRemoteReconnect: (() => void) | null = null;
    const remoteReconnect = new Promise<void>((resolve) => {
      resolveRemoteReconnect = resolve;
    });
    const bridge = createBridge({
      reconnect: vi
        .fn<CanvasCommandBridge["reconnectCollaborationCanvas"]>()
        .mockResolvedValueOnce(reconnectResult(initialSession))
        .mockImplementationOnce(async () => {
          await remoteReconnect;
          return reconnectResult(initialSession);
        })
        .mockResolvedValue(reconnectResult(initialSession))
    });
    renderHook(() => useSharedCanvasCommands(hookInput(bridge.api)));
    await flushEffects();

    await act(async () => {
      vi.advanceTimersByTime(SHARED_CANVAS_RECONNECT_INTERVAL_MS * 3);
    });
    expect(bridge.reconnect).toHaveBeenCalledTimes(2);

    resolveRemoteReconnect?.();
    await flushEffects();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARED_CANVAS_RECONNECT_INTERVAL_MS);
    });
    expect(bridge.reconnect).toHaveBeenCalledTimes(3);
  });

  it("does not poll when local canvas binding fails", async () => {
    vi.useFakeTimers();
    const bridge = createBridge({ bindError: new Error("local canvas binding failed") });
    renderHook(() => useSharedCanvasCommands(hookInput(bridge.api)));
    await flushEffects();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARED_CANVAS_RECONNECT_INTERVAL_MS * 2);
    });
    expect(bridge.reconnect).not.toHaveBeenCalled();
  });
});

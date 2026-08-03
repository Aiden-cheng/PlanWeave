/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import {
  exampleCanvasReconnectAfterDisconnect,
  exampleCanvasReconnectTruncatedJournal
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import { createTranslator } from "../renderer/i18n";
import type {
  CollaborationCanvasCommandSessionView,
  CollaborationCanvasReconnectResult,
  CollaborationObserverSignal
} from "../shared/collaboration";
import {
  collaborationCanvasReplicaProjectionSchema,
  type CollaborationCanvasReplicaProjection,
  type CollaborationCanvasReplicaSignal
} from "../shared/canvasReplicaIpc";
import {
  SHARED_CANVAS_RECONNECT_INTERVAL_MS,
  type SharedCanvasCommandBridge,
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
  reconnect?: SharedCanvasCommandBridge["reconnectCollaborationCanvas"];
  resolveScope?: SharedCanvasCommandBridge["resolveCollaborationCanvasScope"];
}) {
  const observerListeners = new Set<(signal: CollaborationObserverSignal) => void>();
  const replicaListeners = new Set<(signal: CollaborationCanvasReplicaSignal) => void>();
  const reconnect = vi.fn<SharedCanvasCommandBridge["reconnectCollaborationCanvas"]>(
    options?.reconnect ?? (async () => reconnectResult(initialSession))
  );
  const bind = vi.fn<SharedCanvasCommandBridge["bindCollaborationCanvasCommandSession"]>(async () => {
    if (options?.bindError) throw options.bindError;
    return initialSession;
  });
  return {
    api: {
      submitCollaborationCanvasCommand: async () => {
        throw new Error("not used by this hook test");
      },
      reconnectCollaborationCanvas: reconnect,
      bindCollaborationCanvasCommandSession: bind,
      getCollaborationCanvasCommandSession: async () => initialSession,
      resolveCollaborationCanvasScope:
        options?.resolveScope ??
        (async ({ canvasId }) => ({
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId
        })),
      onCollaborationObserverSignal: (listener: (signal: CollaborationObserverSignal) => void) => {
        observerListeners.add(listener);
        return () => observerListeners.delete(listener);
      },
      getCollaborationCanvasReplicaProjection: async () => null,
      onCollaborationCanvasReplicaSignal: (listener: (signal: CollaborationCanvasReplicaSignal) => void) => {
        replicaListeners.add(listener);
        return () => replicaListeners.delete(listener);
      }
    },
    reconnect,
    bind,
    emitObserver(signal: CollaborationObserverSignal) {
      for (const listener of observerListeners) listener(signal);
    },
    emitReplica(projection: CollaborationCanvasReplicaProjection) {
      for (const listener of replicaListeners) {
        listener({ type: "canvas.replica.changed", projection });
      }
    }
  };
}

function replicaProjection(revision: number): CollaborationCanvasReplicaProjection {
  return collaborationCanvasReplicaProjectionSchema.parse({
    authorityId: "authority-1",
    localProjectId: "project-1",
    localCanvasId: "default",
    workspaceId: "workspace-1",
    projectId: "project-1",
    canvasId: "default",
    revision,
    contentDigest: "a".repeat(64),
    canEdit: true,
    optimisticOperationIds: [],
    rejections: [],
    content: {
      projectTitle: "Shared",
      graphVersion: "1",
      packageFingerprint: `pkg-${"b".repeat(64)}`,
      tasks: [],
      edges: [],
      sharedResourceGroups: [],
      diagnostics: [],
      layout: {
        version: "desktop-layout/v1",
        projectId: "project-1",
        nodes: [],
        updatedAt: "2026-08-02T00:00:00.000Z"
      },
      blockDependenciesByRef: {},
      taskOpenFeedbackCountByTaskId: {},
      blockPromptMarkdownByRef: {}
    }
  });
}

function hookInput(api: SharedCanvasCommandBridge, onAuthoritativeChange?: () => void | Promise<void>) {
  return {
    api,
    enabled: true,
    sessionConnected: true,
    canvasId: "default",
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
  it("adopts a live replica projection without refreshing local disk state", async () => {
    vi.useFakeTimers();
    const bridge = createBridge();
    const { result } = renderHook(() => useSharedCanvasCommands(hookInput(bridge.api)));
    await flushEffects();

    act(() => bridge.emitReplica(replicaProjection(4)));

    expect(result.current.projection?.revision).toBe(4);
    expect(result.current.projection?.content.projectTitle).toBe("Shared");
  });

  it("does not bind a command session before collaboration is connected", async () => {
    vi.useFakeTimers();
    const bridge = createBridge();

    const { result } = renderHook(() =>
      useSharedCanvasCommands({
        ...hookInput(bridge.api),
        sessionConnected: false
      })
    );
    await flushEffects();

    expect(bridge.bind).not.toHaveBeenCalled();
    expect(bridge.reconnect).not.toHaveBeenCalled();
    expect(result.current.enabled).toBe(true);
  });

  it("keeps the command facade stable when its inputs and snapshot are unchanged", () => {
    const t = createTranslator("en");
    const { result, rerender } = renderHook(() =>
      useSharedCanvasCommands({
        api: null,
        enabled: false,
        sessionConnected: false,
        canvasId: null,
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
        .fn<SharedCanvasCommandBridge["reconnectCollaborationCanvas"]>()
        .mockResolvedValueOnce(reconnectResult(initialSession))
        .mockResolvedValueOnce(
          reconnectResult(remoteSession, exampleCanvasReconnectAfterDisconnect.entries)
        )
    });

    const { result } = renderHook(() =>
      useSharedCanvasCommands(hookInput(bridge.api, onAuthoritativeChange))
    );
    await flushEffects();
    expect(bridge.bind).toHaveBeenCalledWith({
      localProjectId: "project-1",
      canvasId: "default"
    });
    expect(bridge.reconnect).toHaveBeenCalledTimes(1);
    onAuthoritativeChange.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARED_CANVAS_RECONNECT_INTERVAL_MS);
    });

    expect(bridge.reconnect).toHaveBeenCalledTimes(2);
    expect(onAuthoritativeChange).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot.session?.revision).toBe(remoteSession.revision);
  });

  it("refreshes the renderer after a snapshot-only reconnect", async () => {
    vi.useFakeTimers();
    const onAuthoritativeChange = vi.fn();
    const bridge = createBridge({
      reconnect: vi
        .fn<SharedCanvasCommandBridge["reconnectCollaborationCanvas"]>()
        .mockResolvedValueOnce(reconnectResult(initialSession))
        .mockResolvedValueOnce({
          response: exampleCanvasReconnectTruncatedJournal,
          entriesToApply: [],
          snapshotRequired: true,
          session: remoteSession
        })
    });
    renderHook(() => useSharedCanvasCommands(hookInput(bridge.api, onAuthoritativeChange)));
    await flushEffects();
    onAuthoritativeChange.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARED_CANVAS_RECONNECT_INTERVAL_MS);
    });

    expect(onAuthoritativeChange).toHaveBeenCalledTimes(1);
  });

  it("reconnects immediately when the observer reports a newer revision for this canvas", async () => {
    vi.useFakeTimers();
    const onAuthoritativeChange = vi.fn();
    const bridge = createBridge({
      reconnect: vi
        .fn<SharedCanvasCommandBridge["reconnectCollaborationCanvas"]>()
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

    bridge.emitObserver({
      type: "human.observer.event",
      profileId: "profile-1",
      projectId: "project-1",
      event: {
        type: "human.observer.event",
        protocolVersion: 1,
        cursor: 2,
        previousCursor: 1,
        occurredAt: "2030-01-01T00:00:00.000Z",
        kind: "canvas",
        canvasId: "default",
        canvasRevision: remoteSession.revision,
        canvasContentDigest: remoteSession.contentDigest
      }
    } as unknown as CollaborationObserverSignal);
    await flushEffects();

    expect(bridge.reconnect).toHaveBeenCalledTimes(2);
    expect(onAuthoritativeChange).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot.session?.revision).toBe(remoteSession.revision);
  });

  it("binds an imported local replica to its remote canvas scope", async () => {
    vi.useFakeTimers();
    const bridge = createBridge({
      resolveScope: async () => ({ projectId: "remote-project", canvasId: "remote-canvas" })
    });

    renderHook(() =>
      useSharedCanvasCommands({
        ...hookInput(bridge.api),
        selectedProjectId: "local-replica",
        activeProjectId: "remote-project"
      })
    );
    await flushEffects();

    expect(bridge.bind).toHaveBeenCalledWith({
      localProjectId: "local-replica",
      canvasId: "default"
    });
  });

  it("keeps an unrelated local project on direct runtime writes after scope resolution", async () => {
    vi.useFakeTimers();
    const bridge = createBridge({ resolveScope: async () => null });

    const { result } = renderHook(() =>
      useSharedCanvasCommands({
        ...hookInput(bridge.api),
        selectedProjectId: "unrelated-local-project"
      })
    );
    await flushEffects();

    expect(result.current.enabled).toBe(false);
    expect(bridge.bind).not.toHaveBeenCalled();
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
        .fn<SharedCanvasCommandBridge["reconnectCollaborationCanvas"]>()
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

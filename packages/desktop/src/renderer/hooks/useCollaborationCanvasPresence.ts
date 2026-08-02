import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { XYPosition, OnSelectionChangeParams } from "@xyflow/react";
import {
  CANVAS_PRESENCE_MAX_SELECTION_IDS,
  canvasPresenceSelectionIdSchema
} from "@planweave-ai/collaboration-contracts";
import { collaborationBridge } from "../bridge";
import {
  CanvasPresenceController,
  type CanvasPresenceBridge,
  type CanvasPresenceLabels,
  type CanvasPresenceRemoteSession
} from "../collaboration/CanvasPresenceController";
import type { createTranslator } from "../i18n";

const POINTER_INTERVAL_MS = 50;

export type CollaborationCanvasPresenceResult = {
  remoteSessions: CanvasPresenceRemoteSession[];
  error: string | null;
  onPointerMove: (position: XYPosition) => void;
  onPointerLeave: () => void;
  onSelectionChange: (selection: OnSelectionChangeParams) => void;
};

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function normalizeSelectionIds(selection: OnSelectionChangeParams): string[] {
  const ids = [...selection.nodes, ...selection.edges]
    .map((item) => item.id)
    .map((id) => canvasPresenceSelectionIdSchema.safeParse(id))
    .filter((result) => result.success)
    .map((result) => result.data);
  return [...new Set(ids)].sort().slice(0, CANVAS_PRESENCE_MAX_SELECTION_IDS);
}

/**
 * Binds the active ReactFlow canvas to one ephemeral presence controller.
 * Pointer traffic is coalesced on animation frames and never exceeds 20Hz.
 */
export function useCollaborationCanvasPresence(input: {
  enabled: boolean;
  sessionConnected: boolean;
  canvasId: string | null;
  profileId: string | null;
  selectedProjectId: string | null;
  activeProjectId: string | null;
  t: ReturnType<typeof createTranslator>;
  api?: CanvasPresenceBridge | null;
}): CollaborationCanvasPresenceResult {
  const api = input.api === undefined ? collaborationBridge : input.api;
  const [resolvedScope, setResolvedScope] = useState<{
    localProjectId: string;
    localCanvasId: string;
    remoteProjectId: string;
    remoteCanvasId: string;
  } | null>(null);
  const currentScope =
    resolvedScope &&
    resolvedScope.localProjectId === input.selectedProjectId &&
    resolvedScope.localCanvasId === input.canvasId &&
    resolvedScope.remoteProjectId === input.activeProjectId
      ? resolvedScope
      : null;
  const scopeEnabled =
    input.enabled && input.sessionConnected && input.profileId !== null && currentScope !== null;
  const labels = useMemo<CanvasPresenceLabels>(
    () => ({
      error: (code) => input.t("canvasPresenceError").replace("{code}", code)
    }),
    [input.t]
  );
  const controllerRef = useRef<CanvasPresenceController | null>(null);
  const desiredPointerRef = useRef<XYPosition | null>(null);
  const desiredSelectionRef = useRef<string[]>([]);
  const lastPublishedRef = useRef<{ pointer: XYPosition | null; selectionIds: string[] } | null>(
    null
  );
  const lastPointerPublishedAtRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const [remoteSessions, setRemoteSessions] = useState<CanvasPresenceRemoteSession[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (
      !api ||
      !input.enabled ||
      !input.sessionConnected ||
      !input.profileId ||
      !input.selectedProjectId ||
      !input.canvasId ||
      !input.activeProjectId
    ) {
      setResolvedScope(null);
      return undefined;
    }
    const localProjectId = input.selectedProjectId;
    const localCanvasId = input.canvasId;
    const activeProjectId = input.activeProjectId;
    let active = true;
    setResolvedScope(null);
    void api
      .resolveCollaborationCanvasScope({
        localProjectId,
        canvasId: localCanvasId
      })
      .then((scope) => {
        if (!active || !scope || scope.projectId !== activeProjectId) return;
        setResolvedScope({
          localProjectId,
          localCanvasId,
          remoteProjectId: scope.projectId,
          remoteCanvasId: scope.canvasId
        });
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
    };
  }, [
    api,
    input.activeProjectId,
    input.canvasId,
    input.enabled,
    input.profileId,
    input.selectedProjectId,
    input.sessionConnected
  ]);

  useEffect(() => {
    if (!api) {
      controllerRef.current = null;
      setRemoteSessions([]);
      setError(null);
      return undefined;
    }
    const controller = new CanvasPresenceController({ api, labels });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe((snapshot) => {
      setRemoteSessions(snapshot.sessions);
      setError(snapshot.error);
    });
    return () => {
      unsubscribe();
      controllerRef.current = null;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      void controller.stop();
      setRemoteSessions([]);
      setError(null);
    };
  }, [api, labels]);

  useEffect(() => {
    const controller = controllerRef.current;
    const shouldRun = Boolean(controller && scopeEnabled && currentScope && input.profileId);
    if (!controller || !shouldRun) {
      desiredPointerRef.current = null;
      desiredSelectionRef.current = [];
      lastPublishedRef.current = null;
      setRemoteSessions([]);
      return undefined;
    }
    setError(null);
    const canvasId = currentScope?.remoteCanvasId ?? null;
    const profileId = input.profileId;
    if (!canvasId || !profileId) return undefined;
    const scope = {
      canvasId,
      profileId
    };
    let active = true;
    void controller.start(scope).catch((caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => {
      active = false;
      void controller.stop();
      desiredPointerRef.current = null;
      desiredSelectionRef.current = [];
      lastPublishedRef.current = null;
      setRemoteSessions([]);
    };
  }, [currentScope?.remoteCanvasId, input.profileId, scopeEnabled]);

  const publish = useCallback(
    (pointer: XYPosition | null, selectionIds: string[]) => {
      if (!scopeEnabled || !currentScope || !input.profileId) return;
      const controller = controllerRef.current;
      if (!controller) return;
      const previous = lastPublishedRef.current;
      if (
        previous &&
        previous.pointer?.x === pointer?.x &&
        previous.pointer?.y === pointer?.y &&
        sameIds(previous.selectionIds, selectionIds)
      ) {
        return;
      }
      lastPublishedRef.current = { pointer, selectionIds };
      void controller
        .publish({ pointer, selectionIds })
        .catch((caught: unknown) =>
          setError(caught instanceof Error ? caught.message : String(caught))
        );
    },
    [currentScope, input.profileId, scopeEnabled]
  );

  const flushPointer = useCallback(() => {
    frameRef.current = null;
    const elapsed = Date.now() - lastPointerPublishedAtRef.current;
    if (elapsed < POINTER_INTERVAL_MS) {
      frameRef.current = requestAnimationFrame(flushPointer);
      return;
    }
    lastPointerPublishedAtRef.current = Date.now();
    publish(desiredPointerRef.current, desiredSelectionRef.current);
  }, [publish]);

  const queuePointer = useCallback(
    (position: XYPosition | null) => {
      desiredPointerRef.current = position;
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(flushPointer);
    },
    [flushPointer]
  );

  const onSelectionChange = useCallback(
    (selection: OnSelectionChangeParams) => {
      const nextIds = normalizeSelectionIds(selection);
      if (sameIds(desiredSelectionRef.current, nextIds)) return;
      desiredSelectionRef.current = nextIds;
      publish(desiredPointerRef.current, nextIds);
    },
    [publish]
  );

  const onPointerLeave = useCallback(() => {
    // Leave must publish null immediately — do not wait for the 20Hz pointer coalescer.
    desiredPointerRef.current = null;
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    lastPointerPublishedAtRef.current = 0;
    publish(null, desiredSelectionRef.current);
  }, [publish]);

  return useMemo(
    () => ({
      remoteSessions,
      error,
      onPointerMove: queuePointer,
      onPointerLeave,
      onSelectionChange
    }),
    [error, onPointerLeave, onSelectionChange, queuePointer, remoteSessions]
  );
}

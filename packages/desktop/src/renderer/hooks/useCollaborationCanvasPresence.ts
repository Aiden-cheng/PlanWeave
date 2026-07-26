import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { XYPosition, OnSelectionChangeParams } from "@xyflow/react";
import { collaborationBridge } from "../bridge";
import {
  CanvasPresenceController,
  type CanvasPresenceBridge,
  type CanvasPresenceRemoteSession
} from "../collaboration/CanvasPresenceController";

const MAX_SELECTION_IDS = 32;
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
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    .map((id) => id.trim());
  return [...new Set(ids)].sort().slice(0, MAX_SELECTION_IDS);
}

/**
 * Binds the active ReactFlow canvas to one ephemeral presence controller.
 * Pointer traffic is coalesced on animation frames and never exceeds 20Hz.
 */
export function useCollaborationCanvasPresence(input: {
  enabled: boolean;
  canvasId: string | null;
  profileId: string | null;
  api?: CanvasPresenceBridge | null;
}): CollaborationCanvasPresenceResult {
  const api = input.api === undefined ? collaborationBridge : input.api;
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
    if (!api) {
      controllerRef.current = null;
      setRemoteSessions([]);
      setError(null);
      return undefined;
    }
    const controller = new CanvasPresenceController({ api });
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
  }, [api]);

  useEffect(() => {
    const controller = controllerRef.current;
    const shouldRun = Boolean(controller && input.enabled && input.canvasId && input.profileId);
    if (!controller || !shouldRun) {
      desiredPointerRef.current = null;
      desiredSelectionRef.current = [];
      lastPublishedRef.current = null;
      setRemoteSessions([]);
      return undefined;
    }
    setError(null);
    const canvasId = input.canvasId;
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
  }, [input.canvasId, input.enabled, input.profileId]);

  const publish = useCallback(
    (pointer: XYPosition | null, selectionIds: string[]) => {
      if (!input.enabled || !input.canvasId || !input.profileId) return;
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
    [input.canvasId, input.enabled, input.profileId]
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

  return useMemo(
    () => ({
      remoteSessions,
      error,
      onPointerMove: queuePointer,
      onPointerLeave: () => queuePointer(null),
      onSelectionChange
    }),
    [error, onSelectionChange, queuePointer, remoteSessions]
  );
}

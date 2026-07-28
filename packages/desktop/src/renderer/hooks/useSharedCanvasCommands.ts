import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasCommandIntent } from "@planweave-ai/collaboration-contracts";
import { collaborationBridge } from "../bridge";
import {
  CanvasCommandController,
  type CanvasCommandBridge,
  type CanvasCommandControllerSnapshot,
  type CanvasCommandLabels
} from "../collaboration/CanvasCommandController";
import type { createTranslator } from "../i18n";

export const SHARED_CANVAS_RECONNECT_INTERVAL_MS = 3_000;

export type SharedCanvasSubmitResult = {
  ok: boolean;
  error: string | null;
  staleConflict: CanvasCommandControllerSnapshot["lastStaleConflict"];
};

export type SharedCanvasCommandsResult = {
  /** True when shared-mode durable mutations must go through canvas commands. */
  enabled: boolean;
  snapshot: CanvasCommandControllerSnapshot;
  submit: (input: {
    intent: CanvasCommandIntent;
    operationId?: string;
    expectedRevision?: number;
  }) => Promise<SharedCanvasSubmitResult>;
  reconnect: () => Promise<boolean>;
};

/**
 * Binds shared-mode canvas command session when collaboration is connected
 * for the active profile/project/canvas. Local/offline mode leaves enabled=false
 * so graph hooks keep using direct runtime bridge writes.
 */
export function useSharedCanvasCommands(input: {
  enabled: boolean;
  canvasId: string | null;
  profileId: string | null;
  selectedProjectId: string | null;
  activeProjectId: string | null;
  t: ReturnType<typeof createTranslator>;
  api?: CanvasCommandBridge | null;
  /** Called after accepted mutation or successful reconnect so ReactFlow can refresh. */
  onAuthoritativeChange?: () => void | Promise<void>;
}): SharedCanvasCommandsResult {
  const api = input.api === undefined ? collaborationBridge : input.api;
  const scopeEnabled =
    input.enabled &&
    input.selectedProjectId !== null &&
    input.selectedProjectId === input.activeProjectId &&
    input.canvasId !== null &&
    input.profileId !== null;

  const labels = useMemo<CanvasCommandLabels>(
    () => ({
      staleRevision: (expected, authoritative) =>
        input
          .t("canvasCommandStaleRevision")
          .replace("{expected}", String(expected))
          .replace("{authoritative}", String(authoritative)),
      rejected: (code) => input.t("canvasCommandRejected").replace("{code}", code),
      reconnectFailed: (code) => input.t("canvasCommandReconnectFailed").replace("{code}", code),
      notConnected: input.t("canvasCommandNotConnected")
    }),
    [input.t]
  );

  const controllerRef = useRef<CanvasCommandController | null>(null);
  const onChangeRef = useRef(input.onAuthoritativeChange);
  onChangeRef.current = input.onAuthoritativeChange;
  const [snapshot, setSnapshot] = useState<CanvasCommandControllerSnapshot>({
    session: null,
    lastError: null,
    lastStaleConflict: null,
    busy: false
  });

  useEffect(() => {
    if (!api) {
      controllerRef.current = null;
      setSnapshot({ session: null, lastError: null, lastStaleConflict: null, busy: false });
      return undefined;
    }
    const controller = new CanvasCommandController({ api, labels });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      controllerRef.current = null;
      void controller.unbind();
    };
  }, [api, labels]);

  useEffect(() => {
    const controller = controllerRef.current;
    const canvasId = input.canvasId;
    if (!controller || !scopeEnabled || !canvasId) {
      void controller?.unbind();
      return undefined;
    }
    let active = true;
    let pollInFlight = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const reportRefreshFailure = (error: unknown) => {
      if (active) controller.reportRefreshFailure(error);
    };
    const refreshAuthoritativeState = async () => {
      try {
        await onChangeRef.current?.();
      } catch (error) {
        reportRefreshFailure(error);
      }
    };
    const poll = async () => {
      if (!active || pollInFlight) return;
      pollInFlight = true;
      try {
        const result = await controller.reconnectInBackground();
        if (!active || !result || result.entriesToApply.length === 0) return;
        await refreshAuthoritativeState();
      } finally {
        pollInFlight = false;
      }
    };
    const bindAndStartPolling = async () => {
      try {
        await controller.bind({ canvasId });
        if (!active) return;
        const snap = controller.getSnapshot();
        if (!snap.session || snap.lastError) return;
        await refreshAuthoritativeState();
        if (!active || controller.getSnapshot().lastError) return;
        intervalId = setInterval(() => {
          void poll();
        }, SHARED_CANVAS_RECONNECT_INTERVAL_MS);
      } catch (error) {
        reportRefreshFailure(error);
      }
    };
    void bindAndStartPolling();
    return () => {
      active = false;
      if (intervalId !== null) clearInterval(intervalId);
    };
  }, [api, labels, scopeEnabled, input.canvasId]);

  const submit = useCallback(
    async (submitInput: {
      intent: CanvasCommandIntent;
      operationId?: string;
      expectedRevision?: number;
    }): Promise<SharedCanvasSubmitResult> => {
      const controller = controllerRef.current;
      if (!controller || !scopeEnabled) {
        return { ok: false, error: labels.notConnected, staleConflict: null };
      }
      const result = await controller.submit(submitInput);
      const snap = controller.getSnapshot();
      if (result.outcome.type === "canvas.command.accepted") {
        await onChangeRef.current?.();
        return { ok: true, error: null, staleConflict: null };
      }
      return {
        ok: false,
        error: snap.lastError,
        staleConflict: snap.lastStaleConflict
      };
    },
    [labels.notConnected, scopeEnabled]
  );

  const reconnect = useCallback(async () => {
    const controller = controllerRef.current;
    if (!controller || !scopeEnabled) return false;
    const result = await controller.reconnect();
    if (result.response.type !== "canvas.reconnect.error") {
      await onChangeRef.current?.();
      return true;
    }
    return false;
  }, [scopeEnabled]);

  return useMemo(
    () => ({
      enabled: Boolean(scopeEnabled),
      snapshot,
      submit,
      reconnect
    }),
    [reconnect, scopeEnabled, snapshot, submit]
  );
}

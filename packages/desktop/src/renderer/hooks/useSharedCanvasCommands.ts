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
    if (!controller || !scopeEnabled || !input.canvasId) {
      void controller?.unbind();
      return undefined;
    }
    let active = true;
    void controller.bind(input.canvasId).then(async () => {
      if (!active) return;
      const snap = controller.getSnapshot();
      if (snap.session && !snap.lastError) {
        await onChangeRef.current?.();
      }
    });
    return () => {
      active = false;
    };
  }, [scopeEnabled, input.canvasId]);

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

  return {
    enabled: Boolean(scopeEnabled),
    snapshot,
    submit,
    reconnect
  };
}

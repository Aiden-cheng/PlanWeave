import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasCommandIntent } from "@planweave-ai/collaboration-protocol/canvas/commands";
import { collaborationBridge } from "../bridge";
import {
  CanvasCommandController,
  type CanvasCommandBridge,
  type CanvasCommandControllerSnapshot,
  type CanvasCommandLabels
} from "../collaboration/CanvasCommandController";
import type { createTranslator } from "../i18n";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration";
import type { CollaborationCanvasReplicaProjection } from "../../shared/canvasReplicaIpc";

export type SharedCanvasCommandBridge = CanvasCommandBridge &
  Pick<
    PlanWeaveCollaborationApi,
    | "resolveCollaborationCanvasScope"
    | "onCollaborationObserverSignal"
    | "flushCollaborationCanvasReplicaMaterialization"
  > &
  Partial<
    Pick<
      PlanWeaveCollaborationApi,
      "getCollaborationCanvasReplicaProjection" | "onCollaborationCanvasReplicaSignal"
    >
  >;

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
  /** Authoritative in-memory projection used by the shared canvas renderer. */
  projection: CollaborationCanvasReplicaProjection | null;
  /** Shared authority is configured but the command session is currently unavailable. */
  offline: boolean;
  submit: (input: { intent: CanvasCommandIntent }) => Promise<SharedCanvasSubmitResult>;
  reconnect: () => Promise<boolean>;
};

/**
 * Binds shared-mode canvas command session when collaboration is connected
 * for the active profile/project/canvas. Local/offline mode leaves enabled=false
 * so graph hooks keep using direct runtime bridge writes.
 */
export function useSharedCanvasCommands(input: {
  enabled: boolean;
  sessionConnected: boolean;
  canvasId: string | null;
  profileId: string | null;
  selectedProjectId: string | null;
  activeProjectId: string | null;
  /** This device owns the selected authority, but its Server is not running. */
  localOwnerDirectWriteAvailable: boolean;
  t: ReturnType<typeof createTranslator>;
  api?: SharedCanvasCommandBridge | null;
  /** Called after accepted mutation or successful reconnect so ReactFlow can refresh. */
  onAuthoritativeChange?: () => void | Promise<void>;
}): SharedCanvasCommandsResult {
  const api = input.api === undefined ? collaborationBridge : input.api;
  const [scopeResolution, setScopeResolution] = useState<
    | { phase: "idle" }
    | { phase: "resolving"; localProjectId: string; localCanvasId: string }
    | {
        phase: "resolved";
        localProjectId: string;
        localCanvasId: string;
        remoteProjectId: string;
        remoteCanvasId: string;
      }
    | { phase: "unmapped"; localProjectId: string; localCanvasId: string }
  >({ phase: "idle" });
  const currentScope =
    scopeResolution.phase === "resolved" &&
    scopeResolution.localProjectId === input.selectedProjectId &&
    scopeResolution.localCanvasId === input.canvasId &&
    scopeResolution.remoteProjectId === input.activeProjectId
      ? scopeResolution
      : null;
  const scopeMayBeShared =
    scopeResolution.phase === "resolving" &&
    scopeResolution.localProjectId === input.selectedProjectId &&
    scopeResolution.localCanvasId === input.canvasId;
  const scopeKnownUnmapped =
    scopeResolution.phase === "unmapped" &&
    scopeResolution.localProjectId === input.selectedProjectId &&
    scopeResolution.localCanvasId === input.canvasId;
  const collaborationConfigured =
    input.enabled &&
    !input.localOwnerDirectWriteAvailable &&
    input.selectedProjectId !== null &&
    input.activeProjectId !== null &&
    input.canvasId !== null &&
    input.profileId !== null;
  const authorityEnabled =
    collaborationConfigured &&
    (scopeMayBeShared || currentScope !== null || (!input.sessionConnected && !scopeKnownUnmapped));
  const sessionEnabled = authorityEnabled && input.sessionConnected && currentScope !== null;
  const resolvedSharedAuthority = currentScope !== null;

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
  const refreshGenerationRef = useRef(0);
  const refreshScopeIdentity = JSON.stringify([
    input.activeProjectId,
    input.canvasId,
    input.profileId,
    input.selectedProjectId
  ]);
  const [snapshot, setSnapshot] = useState<CanvasCommandControllerSnapshot>({
    session: null,
    connectionPhase: "idle",
    lastError: null,
    lastStaleConflict: null,
    busy: false
  });
  const [projection, setProjection] = useState<CollaborationCanvasReplicaProjection | null>(null);
  const lastConfirmedProjectionRef = useRef<{
    profileId: string | null;
    projection: CollaborationCanvasReplicaProjection;
  } | null>(null);

  const refreshAfterMaterialization = useCallback(() => {
    if (!api || !onChangeRef.current) return;
    const generation = ++refreshGenerationRef.current;
    void api
      .flushCollaborationCanvasReplicaMaterialization()
      .then(async () => {
        if (generation !== refreshGenerationRef.current) return;
        await onChangeRef.current?.();
      })
      .catch((error: unknown) => {
        if (generation === refreshGenerationRef.current) {
          controllerRef.current?.reportRefreshFailure(error);
        }
      });
  }, [api]);

  useEffect(() => {
    void refreshScopeIdentity;
    return () => {
      refreshGenerationRef.current += 1;
    };
  }, [refreshScopeIdentity]);

  useEffect(() => {
    if (
      !api ||
      !collaborationConfigured ||
      !input.selectedProjectId ||
      !input.canvasId ||
      !input.activeProjectId
    ) {
      setScopeResolution({ phase: "idle" });
      return undefined;
    }
    const localProjectId = input.selectedProjectId;
    const localCanvasId = input.canvasId;
    const activeProjectId = input.activeProjectId;
    let active = true;
    setScopeResolution({ phase: "resolving", localProjectId, localCanvasId });
    void api
      .resolveCollaborationCanvasScope({ localProjectId, canvasId: localCanvasId })
      .then((scope) => {
        if (!active) return;
        if (!scope || scope.projectId !== activeProjectId) {
          setScopeResolution({ phase: "unmapped", localProjectId, localCanvasId });
          return;
        }
        setScopeResolution({
          phase: "resolved",
          localProjectId,
          localCanvasId,
          remoteProjectId: scope.projectId,
          remoteCanvasId: scope.canvasId
        });
      })
      .catch(() => {
        if (active) {
          setScopeResolution({ phase: "unmapped", localProjectId, localCanvasId });
        }
      });
    return () => {
      active = false;
    };
  }, [
    api,
    collaborationConfigured,
    input.activeProjectId,
    input.canvasId,
    input.selectedProjectId
  ]);

  useEffect(() => {
    if (!api) {
      controllerRef.current = null;
      setSnapshot({
        session: null,
        connectionPhase: "idle",
        lastError: null,
        lastStaleConflict: null,
        busy: false
      });
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
    const localProjectId = currentScope?.localProjectId ?? null;
    const localCanvasId = currentScope?.localCanvasId ?? null;
    if (!api || !controller || !sessionEnabled || !localProjectId || !localCanvasId) {
      void controller?.unbind();
      if (input.localOwnerDirectWriteAvailable) {
        setProjection(null);
        return undefined;
      }
      const confirmed = lastConfirmedProjectionRef.current;
      setProjection(() =>
        confirmed &&
        confirmed.profileId === input.profileId &&
        confirmed.projection.localProjectId === input.selectedProjectId &&
        confirmed.projection.localCanvasId === input.canvasId &&
        confirmed.projection.projectId === input.activeProjectId
          ? {
              ...confirmed.projection,
              canEdit: false,
              optimisticOperationIds: []
            }
          : null
      );
      return undefined;
    }
    const activeApi = api;
    let active = true;
    let pollInFlight = false;
    let observerPollQueued = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let unsubscribeObserver: (() => void) | null = null;
    let unsubscribeReplica: (() => void) | null = null;

    const reportRefreshFailure = (error: unknown) => {
      if (active) controller.reportRefreshFailure(error);
    };
    const acceptsProjection = (candidate: CollaborationCanvasReplicaProjection) =>
      candidate.localProjectId === localProjectId &&
      candidate.localCanvasId === localCanvasId &&
      candidate.projectId === currentScope.remoteProjectId &&
      candidate.canvasId === currentScope.remoteCanvasId;
    const publishProjection = (candidate: CollaborationCanvasReplicaProjection) => {
      if (candidate.optimisticOperationIds.length === 0) {
        lastConfirmedProjectionRef.current = {
          profileId: input.profileId,
          projection: candidate
        };
      }
      setProjection(candidate);
    };
    const refreshReplicaProjection = async () => {
      if (!activeApi.getCollaborationCanvasReplicaProjection) return;
      const next = await activeApi.getCollaborationCanvasReplicaProjection({
        localProjectId,
        canvasId: localCanvasId
      });
      if (active && next && acceptsProjection(next)) publishProjection(next);
    };
    const poll = async (queueWhenBusy = false) => {
      if (!active) return;
      if (pollInFlight) {
        if (queueWhenBusy) observerPollQueued = true;
        return;
      }
      pollInFlight = true;
      try {
        const result = await controller.reconnectInBackground();
        if (
          !active ||
          !result ||
          (result.entriesToApply.length === 0 &&
            result.response.type !== "canvas.reconnect.snapshot")
        )
          return;
        await refreshReplicaProjection();
        refreshAfterMaterialization();
      } finally {
        pollInFlight = false;
        if (active && observerPollQueued) {
          observerPollQueued = false;
          void poll(true);
        }
      }
    };
    const bindAndStartPolling = async () => {
      try {
        unsubscribeReplica =
          activeApi.onCollaborationCanvasReplicaSignal?.((signal) => {
            if (active && acceptsProjection(signal.projection))
              publishProjection(signal.projection);
          }) ?? null;
        await controller.bind({ localProjectId, canvasId: localCanvasId });
        if (!active) return;
        const snap = controller.getSnapshot();
        if (!snap.session || snap.lastError) return;
        await refreshReplicaProjection();
        refreshAfterMaterialization();
        if (!active || controller.getSnapshot().lastError) return;
        unsubscribeObserver = activeApi.onCollaborationObserverSignal((signal) => {
          if (
            signal.type !== "human.observer.event" ||
            signal.profileId !== input.profileId ||
            signal.projectId !== currentScope.remoteProjectId ||
            signal.event.kind !== "canvas" ||
            signal.event.canvasId !== currentScope.remoteCanvasId
          ) {
            return;
          }
          const canvasRevision = signal.event.canvasRevision;
          const canvasContentDigest = signal.event.canvasContentDigest;
          if (canvasRevision === undefined || canvasContentDigest === undefined) return;
          const session = controller.getSnapshot().session;
          if (
            session &&
            canvasRevision <= session.revision &&
            canvasContentDigest === session.contentDigest
          ) {
            return;
          }
          void poll(true);
        });
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
      unsubscribeObserver?.();
      unsubscribeReplica?.();
    };
  }, [
    currentScope?.localCanvasId,
    currentScope?.localProjectId,
    currentScope?.remoteCanvasId,
    currentScope?.remoteProjectId,
    api,
    input.activeProjectId,
    input.canvasId,
    input.localOwnerDirectWriteAvailable,
    input.profileId,
    input.selectedProjectId,
    refreshAfterMaterialization,
    sessionEnabled
  ]);

  const submit = useCallback(
    async (submitInput: { intent: CanvasCommandIntent }): Promise<SharedCanvasSubmitResult> => {
      const controller = controllerRef.current;
      if (!controller || !sessionEnabled) {
        return { ok: false, error: labels.notConnected, staleConflict: null };
      }
      if (controller.getSnapshot().connectionPhase === "disconnected") {
        return { ok: false, error: null, staleConflict: null };
      }
      try {
        const result = await controller.submit(submitInput);
        const snap = controller.getSnapshot();
        if (result.outcome.type === "canvas.command.accepted") {
          refreshAfterMaterialization();
          return { ok: true, error: null, staleConflict: null };
        }
        return {
          ok: false,
          error: snap.lastError,
          staleConflict: snap.lastStaleConflict
        };
      } catch (error) {
        const snap = controller.getSnapshot();
        return {
          ok: false,
          error:
            snap.connectionPhase === "disconnected"
              ? null
              : (snap.lastError ?? (error instanceof Error ? error.message : String(error))),
          staleConflict: snap.lastStaleConflict
        };
      }
    },
    [labels.notConnected, refreshAfterMaterialization, sessionEnabled]
  );

  const reconnect = useCallback(async () => {
    const controller = controllerRef.current;
    if (!controller || !sessionEnabled) return false;
    try {
      const result = await controller.reconnect();
      if (result.response.type !== "canvas.reconnect.error") {
        refreshAfterMaterialization();
        return true;
      }
      return false;
    } catch (error) {
      if (controller.getSnapshot().connectionPhase === "disconnected") return false;
      throw error;
    }
  }, [refreshAfterMaterialization, sessionEnabled]);

  const visibleProjection = useMemo(() => {
    if (!(authorityEnabled && snapshot.connectionPhase === "disconnected")) return projection;
    const confirmed = lastConfirmedProjectionRef.current;
    const confirmedProjection =
      confirmed &&
      confirmed.profileId === input.profileId &&
      confirmed.projection.localProjectId === input.selectedProjectId &&
      confirmed.projection.localCanvasId === input.canvasId &&
      confirmed.projection.projectId === input.activeProjectId
        ? confirmed.projection
        : null;
    const retained = confirmedProjection ?? projection;
    return retained
      ? {
          ...retained,
          canEdit: false,
          optimisticOperationIds: []
        }
      : null;
  }, [
    authorityEnabled,
    input.activeProjectId,
    input.canvasId,
    input.profileId,
    input.selectedProjectId,
    projection,
    snapshot.connectionPhase
  ]);

  return useMemo(
    () => ({
      enabled: Boolean(authorityEnabled),
      snapshot,
      projection: visibleProjection,
      offline: Boolean(
        resolvedSharedAuthority && (!sessionEnabled || snapshot.connectionPhase === "disconnected")
      ),
      submit,
      reconnect
    }),
    [
      authorityEnabled,
      reconnect,
      resolvedSharedAuthority,
      sessionEnabled,
      snapshot,
      submit,
      visibleProjection
    ]
  );
}

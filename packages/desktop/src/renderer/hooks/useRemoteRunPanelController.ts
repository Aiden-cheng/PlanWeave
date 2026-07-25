import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssignmentDisplayProjection,
  RemoteEventReplay,
  RemoteExecutionActionWireRequest,
  RemoteInteractionResponse,
  RemoteInteractionView,
  RemoteOperationObservation,
  WorkItemRef
} from "@planweave-ai/collaboration-contracts";
import type { RemoteBlockExecutionReadModel } from "@planweave-ai/runtime";
import { collaborationBridge } from "../bridge";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";
import {
  adaptRemoteAcpEvents,
  buildRemoteActionIdentity,
  projectRemoteRunPanelViewModel,
  type RemoteRunAuthorizedActionKind,
  type RemoteRunPanelViewModel
} from "../collaboration/remoteRunViewModels";
import type { createTranslator } from "../i18n";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import {
  workItemKey,
  type CollaborationBoundaryErrorView,
  type CollaborationRemoteRunProjection
} from "../../shared/collaborationReadModels.js";
import { useCollaborationReadModels } from "./useCollaborationReadModels";
import { useCollaborationStatus } from "./useCollaborationStatus";

export type UseRemoteRunPanelControllerArgs = {
  workItem: WorkItemRef | null;
  /** Runtime remoteExecution projection for the selected Block (local authority). */
  runtimeRemoteExecution?: RemoteBlockExecutionReadModel | null;
  /** True when a local Auto Run record is active for the same Block. */
  localAutoRunActive?: boolean;
  open: boolean;
  api?: PlanWeaveCollaborationApi | null;
  t: ReturnType<typeof createTranslator>;
  /** Optional clock/random for deterministic tests. */
  createId?: () => string;
  now?: () => Date;
};

export type UseRemoteRunPanelControllerResult = {
  viewModel: RemoteRunPanelViewModel;
  loading: boolean;
  loadingEvents: boolean;
  loadingInteractions: boolean;
  actionInFlight: RemoteRunAuthorizedActionKind | null;
  actionError: string | null;
  confirmKind: "cancel" | "retry_new_attempt" | "fail_interruption" | null;
  setConfirmKind: (kind: "cancel" | "retry_new_attempt" | "fail_interruption" | null) => void;
  refresh: () => Promise<void>;
  loadMoreEvents: () => Promise<void>;
  dispatch: () => Promise<void>;
  cancel: (reason: string) => Promise<void>;
  failInterruption: (reason: string) => Promise<void>;
  resume: (input: {
    leaseId: string;
    leaseExpiresAt: string;
    recovery: { acpSessionId: string; recoveryId: string };
    reason: string;
  }) => Promise<void>;
  retryNewAttempt: (input: {
    newDispatchId: string;
    newExecutionAttemptId: string;
    reason: string;
  }) => Promise<void>;
  answerInteraction: (settlement: RemoteInteractionResponse) => Promise<void>;
};

function mapBoundaryError(error: unknown): CollaborationBoundaryErrorView {
  if (
    error &&
    typeof error === "object" &&
    "kind" in error &&
    "code" in error &&
    "message" in error &&
    "retryable" in error
  ) {
    return error as CollaborationBoundaryErrorView;
  }
  return {
    kind: "unknown",
    code: "collaboration_remote_run_error",
    message: error instanceof Error ? error.message : "remote_run_error",
    retryable: true
  };
}

function resolveOperationId(input: {
  runtime: RemoteBlockExecutionReadModel | null | undefined;
  assignment: AssignmentDisplayProjection | null;
  observerRun: CollaborationRemoteRunProjection | null;
  observation: RemoteOperationObservation | null;
}): string | null {
  if (input.observation?.operationId) return input.observation.operationId;
  if (input.runtime?.identity.operationId) return input.runtime.identity.operationId;
  return null;
}

/**
 * Observes and controls a remote ACP run for one Block WorkItemRef.
 * Loads deep diagnostics only when open; never merges local Auto Run authority.
 */
export function useRemoteRunPanelController(
  args: UseRemoteRunPanelControllerArgs
): UseRemoteRunPanelControllerResult {
  const api = args.api === undefined ? collaborationBridge : args.api;
  const createId =
    args.createId ??
    (() => {
      if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
        return crypto.randomUUID();
      }
      return `remote-action-${Date.now()}`;
    });
  const now = args.now ?? (() => new Date());

  const { status } = useCollaborationStatus({ api });
  const { snapshot } = useCollaborationReadModels({
    api,
    profileId: null,
    projectId: null,
    manageActiveProject: false
  });

  const sessionConnected =
    status?.session.phase === "connected" || status?.session.phase === "ready";
  const offline =
    !api ||
    !sessionConnected ||
    status?.session.phase === "error" ||
    snapshot.syncPhase === "auth_expired" ||
    snapshot.syncPhase === "disconnected";

  const workKey = args.workItem ? workItemKey(args.workItem) : null;
  const assignment =
    workKey && snapshot.assignmentsByWorkItem[workKey]
      ? snapshot.assignmentsByWorkItem[workKey]!
      : null;

  const observerRun = useMemo(() => {
    if (!args.workItem) return null;
    const key = workItemKey(args.workItem);
    return (
      Object.values(snapshot.remoteRunsByDispatchId).find((run) => {
        if (!run.workItem) return false;
        return workItemKey(run.workItem) === key;
      }) ?? null
    );
  }, [args.workItem, snapshot.remoteRunsByDispatchId]);

  const [observation, setObservation] = useState<RemoteOperationObservation | null>(null);
  const [pendingInteractions, setPendingInteractions] = useState<RemoteInteractionView[]>([]);
  const [events, setEvents] = useState<RemoteEventReplay["events"]>([]);
  const [eventCursor, setEventCursor] = useState(0);
  const [eventsHasMore, setEventsHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [loadingInteractions, setLoadingInteractions] = useState(false);
  const [actionInFlight, setActionInFlight] = useState<RemoteRunAuthorizedActionKind | null>(
    null
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmKind, setConfirmKind] = useState<
    "cancel" | "retry_new_attempt" | "fail_interruption" | null
  >(null);
  const generationRef = useRef(0);
  const projectIdRef = useRef(snapshot.projectId);

  useEffect(() => {
    if (projectIdRef.current !== snapshot.projectId) {
      projectIdRef.current = snapshot.projectId;
      generationRef.current += 1;
      setObservation(null);
      setPendingInteractions([]);
      setEvents([]);
      setEventCursor(0);
      setEventsHasMore(false);
      setActionError(null);
      setConfirmKind(null);
    }
  }, [snapshot.projectId]);

  const observationRef = useRef<RemoteOperationObservation | null>(null);
  observationRef.current = observation;

  const refresh = useCallback(async () => {
    if (!api || !args.open || !args.workItem || args.workItem.kind !== "block") return;
    if (!sessionConnected) return;
    const generation = ++generationRef.current;
    setLoading(true);
    setActionError(null);
    try {
      const operationId = resolveOperationId({
        runtime: args.runtimeRemoteExecution,
        assignment,
        observerRun,
        observation: observationRef.current
      });
      if (!operationId) {
        if (generation === generationRef.current) {
          setObservation(null);
          setPendingInteractions([]);
          setEvents([]);
          setEventCursor(0);
          setEventsHasMore(false);
        }
        return;
      }
      const next = await api.observeCollaborationRemoteOperation({ operationId });
      if (generation !== generationRef.current) return;
      setObservation(next);

      setLoadingInteractions(true);
      try {
        const page = await api.listCollaborationRemoteOperationInteractions({
          operationId,
          query: { cursor: 0, limit: 50 }
        });
        if (generation !== generationRef.current) return;
        setPendingInteractions(page.items.filter((item) => item.status === "pending"));
      } finally {
        if (generation === generationRef.current) setLoadingInteractions(false);
      }

      setLoadingEvents(true);
      try {
        const replay = await api.replayCollaborationRemoteOperationEvents({
          operationId,
          query: { afterCursor: 0 }
        });
        if (generation !== generationRef.current) return;
        const adapted = adaptRemoteAcpEvents(replay.events);
        setEvents(adapted);
        setEventCursor(replay.cursor);
        setEventsHasMore(replay.hasMore);
      } finally {
        if (generation === generationRef.current) setLoadingEvents(false);
      }
    } catch (error) {
      if (generation !== generationRef.current) return;
      const mapped = mapBoundaryError(error);
      setActionError(collaborationErrorMessage(mapped));
      if (mapped.kind === "auth" || mapped.code.includes("auth")) {
        setObservation(null);
      }
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [
    api,
    args.open,
    args.workItem,
    args.runtimeRemoteExecution,
    sessionConnected,
    assignment,
    observerRun
  ]);

  useEffect(() => {
    if (!args.open) return;
    void refresh();
    // Refresh when observer remote-run milestones advance for this work item.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate on observer status only
  }, [
    args.open,
    workKey,
    observerRun?.status,
    observerRun?.updatedAt,
    args.runtimeRemoteExecution?.identity.operationId,
    sessionConnected
  ]);

  const loadMoreEvents = useCallback(async () => {
    if (!api || !observation || !eventsHasMore) return;
    const generation = generationRef.current;
    setLoadingEvents(true);
    setActionError(null);
    try {
      const replay = await api.replayCollaborationRemoteOperationEvents({
        operationId: observation.operationId,
        query: { afterCursor: eventCursor }
      });
      if (generation !== generationRef.current) return;
      setEvents((prev) => adaptRemoteAcpEvents([...prev, ...replay.events]));
      setEventCursor(replay.cursor);
      setEventsHasMore(replay.hasMore);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setActionError(collaborationErrorMessage(mapBoundaryError(error)));
    } finally {
      if (generation === generationRef.current) setLoadingEvents(false);
    }
  }, [api, observation, eventsHasMore, eventCursor]);

  const runAction = useCallback(
    async (
      kind: RemoteRunAuthorizedActionKind,
      execute: () => Promise<void>
    ): Promise<void> => {
      if (actionInFlight) return;
      setActionInFlight(kind);
      setActionError(null);
      try {
        await execute();
        setConfirmKind(null);
        await refresh();
      } catch (error) {
        const mapped = mapBoundaryError(error);
        setActionError(collaborationErrorMessage(mapped));
        if (mapped.kind === "conflict" || mapped.code.includes("stale")) {
          await refresh();
        }
      } finally {
        setActionInFlight(null);
      }
    },
    [actionInFlight, refresh]
  );

  const dispatch = useCallback(async () => {
    const workItem = args.workItem;
    if (!api || !workItem || workItem.kind !== "block") return;
    await runAction("dispatch", async () => {
      const result = await api.dispatchCollaborationRemoteOperation({
        canvasId: workItem.canvasId,
        blockRef: workItem.blockRef,
        idempotencyKey: `desktop-dispatch-${createId()}`,
        expectedAssignmentRevision: assignment?.revision
      });
      setObservation(result);
    });
  }, [api, args.workItem, runAction, createId, assignment?.revision]);

  const cancel = useCallback(
    async (reason: string) => {
      if (!api || !observation) return;
      await runAction("cancel", async () => {
        const action = buildRemoteActionIdentity({
          observation,
          kind: "cancel",
          actionId: createId(),
          reason
        });
        await api.executeCollaborationRemoteOperationAction({
          operationId: observation.operationId,
          action
        });
      });
    },
    [api, observation, runAction, createId]
  );

  const failInterruption = useCallback(
    async (reason: string) => {
      if (!api || !observation) return;
      await runAction("fail_interruption", async () => {
        const action = buildRemoteActionIdentity({
          observation,
          kind: "fail",
          actionId: createId(),
          reason,
          failure: {
            code: "remote_execution_failed",
            message: reason,
            retryable: false
          }
        });
        await api.executeCollaborationRemoteOperationAction({
          operationId: observation.operationId,
          action
        });
      });
    },
    [api, observation, runAction, createId]
  );

  const resume = useCallback(
    async (input: {
      leaseId: string;
      leaseExpiresAt: string;
      recovery: { acpSessionId: string; recoveryId: string };
      reason: string;
    }) => {
      if (!api || !observation) return;
      await runAction("resume_same_session", async () => {
        const action = buildRemoteActionIdentity({
          observation,
          kind: "resume_same_session",
          actionId: createId(),
          reason: input.reason,
          leaseId: input.leaseId,
          leaseExpiresAt: input.leaseExpiresAt,
          recovery: input.recovery
        });
        await api.executeCollaborationRemoteOperationAction({
          operationId: observation.operationId,
          action
        });
      });
    },
    [api, observation, runAction, createId]
  );

  const retryNewAttempt = useCallback(
    async (input: {
      newDispatchId: string;
      newExecutionAttemptId: string;
      reason: string;
    }) => {
      if (!api || !observation) return;
      await runAction("retry_new_attempt", async () => {
        const action = buildRemoteActionIdentity({
          observation,
          kind: "retry_new_attempt",
          actionId: createId(),
          reason: input.reason,
          newDispatchId: input.newDispatchId,
          newExecutionAttemptId: input.newExecutionAttemptId
        });
        await api.executeCollaborationRemoteOperationAction({
          operationId: observation.operationId,
          action
        });
      });
    },
    [api, observation, runAction, createId]
  );

  const answerInteraction = useCallback(
    async (settlement: RemoteInteractionResponse) => {
      if (!api || !observation) return;
      await runAction("answer_interaction", async () => {
        await api.settleCollaborationRemoteOperationInteraction({
          operationId: observation.operationId,
          settlement
        });
      });
    },
    [api, observation, runAction]
  );

  const viewModel = useMemo(
    () =>
      projectRemoteRunPanelViewModel({
        observation,
        runtime: args.runtimeRemoteExecution ?? null,
        assignment,
        observerRun,
        pendingInteractions,
        events,
        eventCursor,
        eventsHasMore,
        authorized: !offline && Boolean(sessionConnected),
        offline: Boolean(offline),
        localAutoRunActive: Boolean(args.localAutoRunActive),
        hostOnline: assignment?.host?.online ?? null
      }),
    [
      observation,
      args.runtimeRemoteExecution,
      args.localAutoRunActive,
      assignment,
      observerRun,
      pendingInteractions,
      events,
      eventCursor,
      eventsHasMore,
      offline,
      sessionConnected
    ]
  );

  // Silence unused now for future lease expiry UI.
  void now;

  return {
    viewModel,
    loading,
    loadingEvents,
    loadingInteractions,
    actionInFlight,
    actionError,
    confirmKind,
    setConfirmKind,
    refresh,
    loadMoreEvents,
    dispatch,
    cancel,
    failInterruption,
    resume,
    retryNewAttempt,
    answerInteraction
  };
}

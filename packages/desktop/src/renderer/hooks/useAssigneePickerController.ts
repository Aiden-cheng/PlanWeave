import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssignmentDisplayProjection,
  AssignmentTarget,
  EligibleAssigneesResponse,
  WorkItemRef
} from "@planweave-ai/collaboration-contracts";
import { collaborationBridge } from "../bridge";
import {
  assigneeDisplayLabelsFromTranslator,
  buildAssigneePickerViewModel,
  DEFAULT_ASSIGNEE_DISPLAY_LABELS,
  targetsEqual,
  type AssigneeDisplayLabels,
  type AssigneePickerViewModel
} from "../collaboration/assignmentViewModels";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";
import { workItemKey } from "../../shared/collaborationReadModels.js";
import type { createTranslator } from "../i18n";
import { useCollaborationReadModels } from "./useCollaborationReadModels";
import { useCollaborationStatus } from "./useCollaborationStatus";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";

export type UseAssigneePickerControllerArgs = {
  workItem: WorkItemRef | null;
  api?: PlanWeaveCollaborationApi | null;
  /** When true, load eligible assignees (picker open). Default false for on-demand. */
  detailsOpen?: boolean;
  /** Translator for primary assignee labels (en / zh-CN catalog). */
  t?: ReturnType<typeof createTranslator>;
  /** Optional prebuilt labels; takes precedence over t when both are provided. */
  labels?: AssigneeDisplayLabels;
  /** Optional outcome callbacks for shell toasts / activity UX. */
  onAssignmentOutcome?: (outcome: {
    ok: boolean;
    workItem: WorkItemRef;
    target: AssignmentTarget;
    errorMessage?: string | null;
  }) => void;
};

export type UseAssigneePickerControllerResult = {
  viewModel: AssigneePickerViewModel | null;
  query: string;
  setQuery: (value: string) => void;
  selectTarget: (target: AssignmentTarget) => Promise<boolean>;
  refresh: () => Promise<void>;
  retryLastTarget: () => Promise<boolean>;
};

/**
 * Task/Block assignee picker controller.
 * Reuses the shared collaboration read-model hub. Sends expectedRevision on every
 * update, disables duplicate submits, and reconciles only authoritative server
 * projections (no optimistic overwrite). Eligible assignees load only when detailsOpen.
 */
export function useAssigneePickerController(
  args: UseAssigneePickerControllerArgs
): UseAssigneePickerControllerResult {
  const api = args.api === undefined ? collaborationBridge : args.api;
  const detailsOpen = args.detailsOpen ?? false;
  const { status } = useCollaborationStatus({ api });

  const activeProfile = useMemo(() => {
    if (!status?.activeProfileId) return null;
    return status.profiles.find((profile) => profile.profileId === status.activeProfileId) ?? null;
  }, [status]);

  const sessionConnected =
    status?.session.phase === "connected" || status?.session.phase === "ready";

  // Subscribe only — project/canvas binding is owned by useCollaborationSurface.
  const {
    snapshot,
    viewModel: projectView,
    controller
  } = useCollaborationReadModels({
    api,
    profileId: sessionConnected ? (activeProfile?.profileId ?? null) : null,
    projectId: sessionConnected ? (activeProfile?.projectId ?? null) : null,
    canvasId: args.workItem?.canvasId ?? null,
    manageActiveProject: false
  });

  const labels = useMemo((): AssigneeDisplayLabels => {
    if (args.labels) return args.labels;
    if (args.t) return assigneeDisplayLabelsFromTranslator(args.t);
    return DEFAULT_ASSIGNEE_DISPLAY_LABELS;
  }, [args.labels, args.t]);

  const [eligible, setEligible] = useState<EligibleAssigneesResponse | null>(null);
  const [eligibleLoading, setEligibleLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [localStaleConflict, setLocalStaleConflict] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastAttemptedTarget, setLastAttemptedTarget] = useState<AssignmentTarget | null>(null);

  const generationRef = useRef(0);
  const pendingRef = useRef(false);
  const workItemKeyValue = args.workItem ? workItemKey(args.workItem) : null;
  const onOutcomeRef = useRef(args.onAssignmentOutcome);
  onOutcomeRef.current = args.onAssignmentOutcome;

  // Reset ephemeral UI when the selected work item changes rapidly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: workItemKeyValue is the intentional remount key
  useEffect(() => {
    generationRef.current += 1;
    setEligible(null);
    setQuery("");
    setPending(false);
    pendingRef.current = false;
    setLocalStaleConflict(false);
    setActionError(null);
    setLastAttemptedTarget(null);
  }, [workItemKeyValue]);

  // Drop eligible options when picker closes so reconnect/auth expiry reloads on next open.
  useEffect(() => {
    if (!detailsOpen) {
      setEligible(null);
      setEligibleLoading(false);
    }
  }, [detailsOpen]);

  const loadEligible = useCallback(async () => {
    if (!api || !args.workItem || !sessionConnected) {
      setEligible(null);
      return;
    }
    const generation = generationRef.current;
    setEligibleLoading(true);
    try {
      const page = await api.listCollaborationEligibleAssignees({ workItem: args.workItem });
      if (generation !== generationRef.current) return;
      setEligible(page);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setActionError(collaborationErrorMessage(error));
      setEligible(null);
    } finally {
      if (generation === generationRef.current) {
        setEligibleLoading(false);
      }
    }
  }, [api, args.workItem, sessionConnected]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: workItemKeyValue remounts eligible load
  useEffect(() => {
    if (!detailsOpen || !sessionConnected || !args.workItem) return;
    void loadEligible();
  }, [args.workItem, detailsOpen, loadEligible, sessionConnected, workItemKeyValue]);

  const assignment: AssignmentDisplayProjection | null = useMemo(() => {
    if (!args.workItem) return null;
    return snapshot.assignmentsByWorkItem[workItemKey(args.workItem)] ?? null;
  }, [args.workItem, snapshot.assignmentsByWorkItem]);

  const refresh = useCallback(async () => {
    if (controller) {
      await controller.refreshAuthoritative({ reason: "assignee_picker_refresh" });
    }
    if (detailsOpen) {
      await loadEligible();
    }
    setLocalStaleConflict(false);
    if (snapshot.syncPhase !== "stale_conflict") {
      setActionError(null);
    }
  }, [controller, detailsOpen, loadEligible, snapshot.syncPhase]);

  const selectTarget = useCallback(
    async (target: AssignmentTarget): Promise<boolean> => {
      if (!api || !args.workItem || !controller) return false;
      if (pendingRef.current) return false;

      // Defense in depth: Tasks never assign to machine targets even if a caller
      // bypasses the view-model option list.
      if (
        args.workItem.kind === "task" &&
        (target.kind === "exact_host" || target.kind === "automatic_host")
      ) {
        const errorMessage = labels.taskDisallowsMachine;
        setActionError(errorMessage);
        setLastAttemptedTarget(target);
        onOutcomeRef.current?.({
          ok: false,
          workItem: args.workItem,
          target,
          errorMessage
        });
        return false;
      }

      const current = snapshot.assignmentsByWorkItem[workItemKey(args.workItem)] ?? null;
      const expectedRevision = current?.revision ?? 0;
      if (current && targetsEqual(current.target, target)) {
        return true;
      }

      pendingRef.current = true;
      setPending(true);
      setLastAttemptedTarget(target);
      setActionError(null);
      const generation = generationRef.current;
      const workItem = args.workItem;

      try {
        const result = await controller.updateAssignment({
          workItem,
          target,
          expectedRevision
        });
        if (generation !== generationRef.current) return false;
        if (!result) {
          const conflict =
            controller.getSnapshot().syncPhase === "stale_conflict" ||
            controller.getSnapshot().lastError?.kind === "conflict";
          if (conflict) {
            setLocalStaleConflict(true);
          }
          const errorMessage =
            collaborationErrorMessage(controller.getSnapshot().lastError) ??
            "assignment_update_failed";
          setActionError(errorMessage);
          // Reconcile authoritative assignment without optimistic overwrite.
          await controller.refreshAuthoritative({ reason: "assignee_picker_reject" });
          onOutcomeRef.current?.({
            ok: false,
            workItem,
            target,
            errorMessage
          });
          return false;
        }
        setLocalStaleConflict(false);
        if (detailsOpen) {
          await loadEligible();
        }
        onOutcomeRef.current?.({ ok: true, workItem, target, errorMessage: null });
        return true;
      } catch (error) {
        if (generation !== generationRef.current) return false;
        const errorMessage = collaborationErrorMessage(error);
        setActionError(errorMessage);
        onOutcomeRef.current?.({
          ok: false,
          workItem,
          target,
          errorMessage
        });
        return false;
      } finally {
        if (generation === generationRef.current) {
          pendingRef.current = false;
          setPending(false);
        }
      }
    },
    [
      api,
      args.workItem,
      controller,
      detailsOpen,
      labels.taskDisallowsMachine,
      loadEligible,
      snapshot.assignmentsByWorkItem
    ]
  );

  const retryLastTarget = useCallback(async () => {
    if (!lastAttemptedTarget) return false;
    await refresh();
    return selectTarget(lastAttemptedTarget);
  }, [lastAttemptedTarget, refresh, selectTarget]);

  const pickerViewModel = useMemo((): AssigneePickerViewModel | null => {
    if (!args.workItem) return null;
    const loading =
      (detailsOpen && eligibleLoading) ||
      snapshot.loadingKinds.includes("assignments") ||
      snapshot.loadingKinds.includes("snapshot") ||
      snapshot.syncPhase === "loading";

    return buildAssigneePickerViewModel({
      workItem: args.workItem,
      assignment,
      members: projectView.members,
      hosts: projectView.hosts,
      eligible,
      status,
      syncPhase: snapshot.syncPhase,
      loading,
      pending,
      staleConflict: localStaleConflict || snapshot.syncPhase === "stale_conflict",
      lastError: actionError ?? snapshot.lastError,
      query,
      labels
    });
  }, [
    actionError,
    args.workItem,
    assignment,
    detailsOpen,
    eligible,
    eligibleLoading,
    labels,
    localStaleConflict,
    pending,
    projectView.hosts,
    projectView.members,
    query,
    snapshot.lastError,
    snapshot.loadingKinds,
    snapshot.syncPhase,
    status
  ]);

  return {
    viewModel: pickerViewModel,
    query,
    setQuery,
    selectTarget,
    refresh,
    retryLastTarget
  };
}

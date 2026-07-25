import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssignmentDisplayProjection,
  AssignmentTarget,
  EligibleAssigneesResponse,
  WorkItemRef
} from "@planweave-ai/collaboration-contracts";
import { collaborationBridge } from "../bridge";
import {
  buildAssigneePickerViewModel,
  targetsEqual,
  type AssigneePickerViewModel
} from "../collaboration/assignmentViewModels";
import { collaborationErrorMessage } from "../collaboration/formatCollaborationError";
import {
  type CollaborationReadBridgePort
} from "../collaboration/CollaborationReadModelController";
import { workItemKey } from "../../shared/collaborationReadModels.js";
import { useCollaborationReadModels } from "./useCollaborationReadModels";
import { useCollaborationStatus } from "./useCollaborationStatus";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";

export type UseAssigneePickerControllerArgs = {
  workItem: WorkItemRef | null;
  api?: PlanWeaveCollaborationApi | null;
  /** When true, load eligible assignees (picker open). */
  detailsOpen?: boolean;
};

export type UseAssigneePickerControllerResult = {
  viewModel: AssigneePickerViewModel | null;
  query: string;
  setQuery: (value: string) => void;
  selectTarget: (target: AssignmentTarget) => Promise<boolean>;
  refresh: () => Promise<void>;
  retryLastTarget: () => Promise<boolean>;
};

function toReadBridge(api: PlanWeaveCollaborationApi): CollaborationReadBridgePort {
  return {
    getCollaborationStatus: () => api.getCollaborationStatus(),
    listCollaborationMembers: (input) => api.listCollaborationMembers(input),
    listCollaborationAssignments: (input) => api.listCollaborationAssignments(input),
    listCollaborationEligibleAssignees: (input) => api.listCollaborationEligibleAssignees(input),
    listCollaborationComments: (input) => api.listCollaborationComments(input),
    listCollaborationActivity: (input) => api.listCollaborationActivity(input),
    updateCollaborationAssignment: (input) => api.updateCollaborationAssignment(input),
    createCollaborationComment: (input) => api.createCollaborationComment(input),
    editCollaborationComment: (input) => api.editCollaborationComment(input),
    tombstoneCollaborationComment: (input) => api.tombstoneCollaborationComment(input),
    onCollaborationStatusChanged: (callback) => api.onCollaborationStatusChanged(callback),
    onCollaborationObserverSignal: (callback) => api.onCollaborationObserverSignal(callback)
  };
}

/**
 * Task/Block assignee picker controller.
 * Sends expectedRevision on every update, disables duplicate submits, and reconciles
 * only authoritative server projections (no optimistic overwrite).
 */
export function useAssigneePickerController(
  args: UseAssigneePickerControllerArgs
): UseAssigneePickerControllerResult {
  const api = args.api === undefined ? collaborationBridge : args.api;
  const detailsOpen = args.detailsOpen ?? true;
  const { status } = useCollaborationStatus({ api });

  const activeProfile = useMemo(() => {
    if (!status?.activeProfileId) return null;
    return status.profiles.find((profile) => profile.profileId === status.activeProfileId) ?? null;
  }, [status]);

  const sessionConnected =
    status?.session.phase === "connected" || status?.session.phase === "ready";

  const readApi = useMemo(() => (api ? toReadBridge(api) : null), [api]);

  const { snapshot, viewModel: projectView, controller } = useCollaborationReadModels({
    api: readApi,
    profileId: sessionConnected ? (activeProfile?.profileId ?? null) : null,
    projectId: sessionConnected ? (activeProfile?.projectId ?? null) : null,
    canvasId: args.workItem?.canvasId ?? null
  });

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

  // Reset ephemeral UI when the selected work item changes rapidly.
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
    await loadEligible();
    setLocalStaleConflict(false);
    if (snapshot.syncPhase !== "stale_conflict") {
      setActionError(null);
    }
  }, [controller, loadEligible, snapshot.syncPhase]);

  const selectTarget = useCallback(
    async (target: AssignmentTarget): Promise<boolean> => {
      if (!api || !args.workItem || !controller) return false;
      if (pendingRef.current) return false;

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
          setActionError(
            collaborationErrorMessage(controller.getSnapshot().lastError) ??
              "assignment_update_failed"
          );
          // Reconcile authoritative assignment without optimistic overwrite.
          await controller.refreshAuthoritative({ reason: "assignee_picker_reject" });
          return false;
        }
        setLocalStaleConflict(false);
        await loadEligible();
        return true;
      } catch (error) {
        if (generation !== generationRef.current) return false;
        setActionError(collaborationErrorMessage(error));
        return false;
      } finally {
        if (generation === generationRef.current) {
          pendingRef.current = false;
          setPending(false);
        }
      }
    },
    [api, args.workItem, controller, loadEligible, snapshot.assignmentsByWorkItem]
  );

  const retryLastTarget = useCallback(async () => {
    if (!lastAttemptedTarget) return false;
    await refresh();
    return selectTarget(lastAttemptedTarget);
  }, [lastAttemptedTarget, refresh, selectTarget]);

  const pickerViewModel = useMemo((): AssigneePickerViewModel | null => {
    if (!args.workItem) return null;
    const loading =
      eligibleLoading ||
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
      query
    });
  }, [
    actionError,
    args.workItem,
    assignment,
    eligible,
    eligibleLoading,
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

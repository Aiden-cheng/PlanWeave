import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AssignmentDisplayProjection,
  AssignmentTarget,
  EligibleAssigneesResponse,
  ExecutionTarget,
  WorkAuthorityProjection,
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

/** Independent OSS-003 authority axes. Responsibility/reviewer are human-only; execution is Host-only. */
export type AssigneeAuthorityRole = "responsibility" | "reviewer" | "execution_target";

export type UseAssigneePickerControllerArgs = {
  workItem: WorkItemRef | null;
  /**
   * Which independent authority this picker mutates.
   * Defaults to responsibility (human owner). Reviewer never changes execution target.
   */
  authorityRole?: AssigneeAuthorityRole;
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
  authority: WorkAuthorityProjection | null;
  authorityRole: AssigneeAuthorityRole;
  query: string;
  setQuery: (value: string) => void;
  selectTarget: (target: AssignmentTarget) => Promise<boolean>;
  refresh: () => Promise<void>;
  retryLastTarget: () => Promise<boolean>;
};

/**
 * Project independent authority into the legacy assignment display shape so section builders reuse.
 * Responsibility/reviewer map to human targets; execution_target maps to Host targets only.
 */
export function assignmentProjectionFromAuthority(input: {
  workItem: WorkItemRef;
  projectId: string;
  authority: WorkAuthorityProjection | null | undefined;
  role: AssigneeAuthorityRole;
}): AssignmentDisplayProjection | null {
  const authority = input.authority;
  if (!authority) return null;

  if (input.role === "responsibility" || input.role === "reviewer") {
    const human = input.role === "responsibility" ? authority.responsibility : authority.reviewer;
    const principal = human.principal;
    const availability =
      human.availability === "active"
        ? ({ status: "ready", reason: "ready" } as const)
        : human.availability === "unassigned"
          ? ({ status: "unassigned", reason: "unassigned" } as const)
          : ({ status: "invalid", reason: "human_membership_inactive" } as const);
    return {
      projectId: input.projectId,
      workItem: input.workItem,
      target: principal
        ? { kind: "human", humanPrincipalId: principal.humanPrincipalId }
        : { kind: "unassigned" },
      revision: human.revision,
      availability,
      ...(principal
        ? {
            human: {
              humanPrincipalId: principal.humanPrincipalId,
              displayName: principal.humanPrincipalId,
              membershipActive: human.availability === "active"
            }
          }
        : {})
    };
  }

  const execution = authority.executionTarget;
  if (!execution || input.workItem.kind !== "block") {
    return {
      projectId: input.projectId,
      workItem: input.workItem,
      target: { kind: "unassigned" },
      revision: authority.revisions.executionTargetRevision,
      availability: { status: "unassigned", reason: "unassigned" }
    };
  }

  const target: AssignmentTarget =
    execution.target.kind === "exact_host"
      ? { kind: "exact_host", hostId: execution.target.hostId }
      : execution.target.kind === "automatic_host"
        ? { kind: "automatic_host" }
        : { kind: "unassigned" };

  const availability: AssignmentDisplayProjection["availability"] =
    execution.availability.status === "ready"
      ? { status: "ready", reason: "ready" }
      : execution.availability.status === "unassigned"
        ? { status: "unassigned", reason: "unassigned" }
        : execution.availability.status === "pending"
          ? { status: "pending", reason: "automatic_pending_selection" }
          : execution.availability.reason === "host_offline" ||
              execution.availability.reason === "host_at_capacity"
            ? { status: "unavailable", reason: execution.availability.reason }
            : {
                status: "invalid",
                reason:
                  execution.availability.reason === "host_missing" ||
                  execution.availability.reason === "host_revoked" ||
                  execution.availability.reason === "host_not_authorized" ||
                  execution.availability.reason === "host_capability_mismatch"
                    ? execution.availability.reason
                    : "host_missing"
              };

  return {
    projectId: input.projectId,
    workItem: input.workItem,
    target,
    revision: execution.revision,
    availability,
    ...(authority.selectedHost
      ? {
          host: {
            hostId: authority.selectedHost.hostId,
            displayName: authority.selectedHost.hostId,
            online: authority.selectedHost.availabilityReason !== "host_offline",
            authorizedForProject:
              authority.selectedHost.availabilityReason !== "host_not_authorized",
            revoked: authority.selectedHost.availabilityReason === "host_revoked",
            capabilitiesSatisfied:
              authority.selectedHost.availabilityReason !== "host_capability_mismatch"
          }
        }
      : {})
  };
}

function filterEligibleForRole(
  eligible: EligibleAssigneesResponse | null,
  role: AssigneeAuthorityRole,
  workItem: WorkItemRef
): EligibleAssigneesResponse | null {
  if (!eligible) return null;
  if (role === "responsibility" || role === "reviewer") {
    return {
      ...eligible,
      hosts: [],
      nextHostCursor: null
    };
  }
  if (workItem.kind !== "block") {
    return {
      ...eligible,
      humans: [],
      hosts: [],
      nextHumanCursor: null,
      nextHostCursor: null
    };
  }
  return {
    ...eligible,
    humans: [],
    nextHumanCursor: null
  };
}

/**
 * Task/Block authority picker controller.
 * Routes mutations to independent responsibility / reviewer / execution-target CAS paths.
 * Task machine targets and non-Block execution targets are rejected before bridge calls.
 */
export function useAssigneePickerController(
  args: UseAssigneePickerControllerArgs
): UseAssigneePickerControllerResult {
  const api = args.api === undefined ? collaborationBridge : args.api;
  const authorityRole: AssigneeAuthorityRole = args.authorityRole ?? "responsibility";
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
  }, [workItemKeyValue, authorityRole]);

  useEffect(() => {
    if (!detailsOpen) {
      setEligible(null);
      setEligibleLoading(false);
    }
  }, [detailsOpen]);

  // Load independent authority projection for the selected work item.
  useEffect(() => {
    if (!controller || !args.workItem || !sessionConnected) return;
    void controller.ensureWorkAuthority(args.workItem).catch(() => undefined);
  }, [args.workItem, controller, sessionConnected, workItemKeyValue]);

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
      setEligible(filterEligibleForRole(page, authorityRole, args.workItem));
    } catch (error) {
      if (generation !== generationRef.current) return;
      setActionError(collaborationErrorMessage(error));
      setEligible(null);
    } finally {
      if (generation === generationRef.current) {
        setEligibleLoading(false);
      }
    }
  }, [api, args.workItem, authorityRole, sessionConnected]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: workItemKeyValue remounts eligible load
  useEffect(() => {
    if (!detailsOpen || !sessionConnected || !args.workItem) return;
    void loadEligible();
  }, [args.workItem, authorityRole, detailsOpen, loadEligible, sessionConnected, workItemKeyValue]);

  const authority: WorkAuthorityProjection | null = useMemo(() => {
    if (!args.workItem) return null;
    return snapshot.workAuthorityByWorkItem[workItemKey(args.workItem)] ?? null;
  }, [args.workItem, snapshot.workAuthorityByWorkItem]);

  const projectId = activeProfile?.projectId ?? snapshot.projectId ?? "unknown";

  const assignment: AssignmentDisplayProjection | null = useMemo(() => {
    if (!args.workItem) return null;
    return assignmentProjectionFromAuthority({
      workItem: args.workItem,
      projectId,
      authority,
      role: authorityRole
    });
  }, [args.workItem, authority, authorityRole, projectId]);

  const refresh = useCallback(async () => {
    if (controller && args.workItem) {
      await controller.ensureWorkAuthority(args.workItem);
      await controller.refreshAuthoritative({ reason: "assignee_picker_refresh" });
    }
    if (detailsOpen) {
      await loadEligible();
    }
    setLocalStaleConflict(false);
    if (snapshot.syncPhase !== "stale_conflict") {
      setActionError(null);
    }
  }, [args.workItem, controller, detailsOpen, loadEligible, snapshot.syncPhase]);

  const selectTarget = useCallback(
    async (target: AssignmentTarget): Promise<boolean> => {
      if (!api || !args.workItem || !controller) return false;
      if (pendingRef.current) return false;

      if (authorityRole === "responsibility" || authorityRole === "reviewer") {
        if (target.kind === "exact_host" || target.kind === "automatic_host") {
          const errorMessage =
            authorityRole === "reviewer"
              ? labels.taskDisallowsMachine
              : labels.taskDisallowsMachine;
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
      } else {
        if (args.workItem.kind !== "block") {
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
        if (target.kind === "human") {
          const errorMessage = "Execution targets accept only Host selections.";
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
      }

      const current = assignment;
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
        let result: { revision?: number } | null = null;
        if (authorityRole === "responsibility") {
          result = await controller.updateResponsibility({
            workItem,
            principal:
              target.kind === "human"
                ? { kind: "human", humanPrincipalId: target.humanPrincipalId }
                : null,
            expectedRevision
          });
        } else if (authorityRole === "reviewer") {
          result = await controller.updateReviewer({
            workItem,
            principal:
              target.kind === "human"
                ? { kind: "human", humanPrincipalId: target.humanPrincipalId }
                : null,
            expectedRevision
          });
        } else {
          const executionTarget: ExecutionTarget =
            target.kind === "exact_host"
              ? { kind: "exact_host", hostId: target.hostId }
              : target.kind === "automatic_host"
                ? { kind: "automatic_host" }
                : { kind: "unassigned" };
          result = await controller.updateExecutionTarget({
            workItem,
            target: executionTarget,
            expectedRevision
          });
        }
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
          await controller.ensureWorkAuthority(workItem);
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
      assignment,
      authorityRole,
      controller,
      detailsOpen,
      labels.taskDisallowsMachine,
      loadEligible
    ]
  );

  const retryLastTarget = useCallback(async () => {
    if (!lastAttemptedTarget) return false;
    await refresh();
    return selectTarget(lastAttemptedTarget);
  }, [lastAttemptedTarget, refresh, selectTarget]);

  const pickerViewModel = useMemo((): AssigneePickerViewModel | null => {
    if (!args.workItem) return null;
    const authorityLoadingKey = `authority:${workItemKey(args.workItem)}`;
    const loading =
      (detailsOpen && eligibleLoading) ||
      snapshot.loadingKinds.includes("assignments") ||
      snapshot.loadingKinds.includes(authorityLoadingKey) ||
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
      labels,
      authorityRole
    });
  }, [
    actionError,
    args.workItem,
    assignment,
    authorityRole,
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
    authority,
    authorityRole,
    query,
    setQuery,
    selectTarget,
    refresh,
    retryLastTarget
  };
}

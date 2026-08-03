import { useCallback, useMemo, useState } from "react";
import type { AssignmentTarget, WorkItemRef } from "@planweave-ai/collaboration-protocol";
import { parseWorkItemKey, workItemKey } from "../../shared/collaborationReadModels.js";
import {
  useAssigneePickerController,
  type AssigneeAuthorityRole,
  type TaskHostDispatchResult
} from "../hooks/useAssigneePickerController";
import type { createTranslator } from "../i18n";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import { AssigneePicker } from "./AssigneePicker";

export type AssigneeInspectorFieldProps = {
  workItem: WorkItemRef | null;
  t: ReturnType<typeof createTranslator>;
  api?: PlanWeaveCollaborationApi | null;
  className?: string;
  taskExecutionBlocks?: readonly {
    workItem: Extract<WorkItemRef, { kind: "block" }>;
    dispatchable: boolean;
  }[];
  /**
   * Which independent authority axes to render.
   * Defaults to responsibility + reviewer, plus Host execution for Block work items.
   */
  roles?: readonly AssigneeAuthorityRole[];
  onAssignmentOutcome?: (outcome: {
    ok: boolean;
    workItem: WorkItemRef;
    target: AssignmentTarget;
    errorMessage?: string | null;
  }) => void;
};

function roleLabel(role: AssigneeAuthorityRole, t: ReturnType<typeof createTranslator>): string {
  switch (role) {
    case "responsibility":
      return t("authorityResponsibility");
    case "reviewer":
      return t("authorityReviewer");
    case "execution_target":
      return t("authorityExecutionHost");
    default:
      return role;
  }
}

function roleHint(
  role: AssigneeAuthorityRole,
  authority: ReturnType<typeof useAssigneePickerController>["authority"],
  t: ReturnType<typeof createTranslator>
): string | null {
  if (role !== "execution_target" || !authority?.selectedHost) return null;
  const host = authority.selectedHost;
  const reason = host.authorization?.reason ?? host.availabilityReason;
  const lease =
    host.lease.status === "none"
      ? t("authorityLeaseNone")
      : host.lease.status === "active"
        ? t("authorityLeaseActive")
        : host.lease.status === "expired"
          ? t("authorityLeaseExpired")
          : t("authorityLeaseRevoked");
  return `${t("authorityHostReason")}: ${reason} · ${lease}`;
}

function SingleAuthorityField({
  workItem,
  role,
  t,
  api,
  className,
  taskExecutionBlocks,
  onAssignmentOutcome
}: {
  workItem: WorkItemRef;
  role: AssigneeAuthorityRole;
  t: ReturnType<typeof createTranslator>;
  api?: PlanWeaveCollaborationApi | null;
  className?: string;
  taskExecutionBlocks?: AssigneeInspectorFieldProps["taskExecutionBlocks"];
  onAssignmentOutcome?: AssigneeInspectorFieldProps["onAssignmentOutcome"];
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const controller = useAssigneePickerController({
    workItem,
    taskExecutionBlocks: role === "execution_target" ? taskExecutionBlocks : undefined,
    authorityRole: role,
    api,
    detailsOpen,
    t,
    onAssignmentOutcome
  });

  const handleOpenChange = useCallback((open: boolean) => {
    setDetailsOpen(open);
  }, []);

  if (!controller.viewModel) {
    return null;
  }

  const hint = roleHint(role, controller.authority, t);

  const resultLabel = (result: TaskHostDispatchResult): string => {
    if (result.ok) return t("taskHostDispatchSucceeded");
    switch (result.message) {
      case "task_block_not_dispatchable":
        return t("taskHostDispatchNotDispatchable");
      case "task_host_unavailable":
        return t("taskHostDispatchHostUnavailable");
      case "task_authority_unavailable":
        return t("taskHostDispatchAuthorityUnavailable");
      case "task_execution_target_update_failed":
        return t("taskHostDispatchAssignmentFailed");
      default:
        return t("taskHostDispatchFailed");
    }
  };

  return (
    <div className={className} data-testid={`authority-field-${role}`} data-authority-role={role}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">{roleLabel(role, t)}</span>
      </div>
      <AssigneePicker
        viewModel={controller.viewModel}
        query={controller.query}
        onQueryChange={controller.setQuery}
        onSelect={controller.selectTarget}
        onRefresh={controller.refresh}
        onRetry={controller.retryLastTarget}
        onOpenChange={handleOpenChange}
        t={t}
      />
      {hint ? (
        <p
          className="mt-1 text-[10px] text-muted-foreground"
          data-testid={`authority-host-status-${role}`}
        >
          {hint}
        </p>
      ) : null}
      {role === "execution_target" && controller.taskDispatchResults.length > 0 ? (
        <div
          className="mt-2 space-y-1 text-[10px]"
          data-testid="task-host-dispatch-results"
          aria-live="polite"
        >
          <p className="font-medium text-muted-foreground">{t("taskHostDispatchResults")}</p>
          {controller.taskDispatchResults.map((result) => (
            <p
              key={result.blockRef}
              className={result.ok ? "text-emerald-700" : "text-destructive"}
            >
              <span className="font-mono">{result.blockRef}</span>: {resultLabel(result)}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Inspector metadata fields for independent responsibility, reviewer, and Host execution.
 * Collaboration session/read models come from the shared hub; eligible options load only
 * while each picker popover is open. Axes never overwrite each other.
 */
export function AssigneeInspectorField({
  workItem,
  t,
  api,
  className,
  roles,
  taskExecutionBlocks,
  onAssignmentOutcome
}: AssigneeInspectorFieldProps) {
  const workKey = workItem ? workItemKey(workItem) : null;
  const stableWorkItem = useMemo(() => (workKey ? parseWorkItemKey(workKey) : null), [workKey]);

  const resolvedRoles = useMemo((): AssigneeAuthorityRole[] => {
    if (roles) return [...roles];
    if (!stableWorkItem) return [];
    if (stableWorkItem.kind === "block") {
      return ["responsibility", "reviewer", "execution_target"];
    }
    return taskExecutionBlocks && taskExecutionBlocks.length > 0
      ? ["responsibility", "reviewer", "execution_target"]
      : ["responsibility", "reviewer"];
  }, [roles, stableWorkItem, taskExecutionBlocks]);

  if (!stableWorkItem) {
    return null;
  }

  return (
    <div
      className={className}
      data-testid="assignee-inspector-fields"
      data-work-item-kind={stableWorkItem.kind}
    >
      {resolvedRoles.map((role) => (
        <SingleAuthorityField
          key={role}
          workItem={stableWorkItem}
          role={role}
          t={t}
          api={api}
          className="mb-2 last:mb-0"
          taskExecutionBlocks={taskExecutionBlocks}
          onAssignmentOutcome={onAssignmentOutcome}
        />
      ))}
    </div>
  );
}

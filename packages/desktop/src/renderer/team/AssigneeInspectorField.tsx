import { useMemo } from "react";
import type { WorkItemRef } from "@planweave-ai/collaboration-contracts";
import { parseWorkItemKey, workItemKey } from "../../shared/collaborationReadModels.js";
import { useAssigneePickerController } from "../hooks/useAssigneePickerController";
import type { createTranslator } from "../i18n";
import type { PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import { AssigneePicker } from "./AssigneePicker";

export type AssigneeInspectorFieldProps = {
  workItem: WorkItemRef | null;
  t: ReturnType<typeof createTranslator>;
  api?: PlanWeaveCollaborationApi | null;
  className?: string;
};

/**
 * Inspector metadata field that mounts the assignee picker for one WorkItemRef.
 * Collaboration session/read models are owned by the controller; no DOM business state.
 */
export function AssigneeInspectorField({
  workItem,
  t,
  api,
  className
}: AssigneeInspectorFieldProps) {
  const workKey = workItem ? workItemKey(workItem) : null;
  const stableWorkItem = useMemo(
    () => (workKey ? parseWorkItemKey(workKey) : null),
    [workKey]
  );
  const controller = useAssigneePickerController({
    workItem: stableWorkItem,
    api,
    detailsOpen: true
  });

  if (!controller.viewModel) {
    return null;
  }

  return (
    <AssigneePicker
      className={className}
      viewModel={controller.viewModel}
      query={controller.query}
      onQueryChange={controller.setQuery}
      onSelect={controller.selectTarget}
      onRefresh={controller.refresh}
      onRetry={controller.retryLastTarget}
      t={t}
    />
  );
}

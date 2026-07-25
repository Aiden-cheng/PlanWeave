import { useCallback, useMemo, useState } from "react";
import type { AssignmentTarget, WorkItemRef } from "@planweave-ai/collaboration-contracts";
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
  onAssignmentOutcome?: (outcome: {
    ok: boolean;
    workItem: WorkItemRef;
    target: AssignmentTarget;
    errorMessage?: string | null;
  }) => void;
};

/**
 * Inspector metadata field that mounts the assignee picker for one WorkItemRef.
 * Collaboration session/read models come from the shared hub; eligible options
 * load only while the picker popover is open.
 */
export function AssigneeInspectorField({
  workItem,
  t,
  api,
  className,
  onAssignmentOutcome
}: AssigneeInspectorFieldProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const workKey = workItem ? workItemKey(workItem) : null;
  const stableWorkItem = useMemo(() => (workKey ? parseWorkItemKey(workKey) : null), [workKey]);
  const controller = useAssigneePickerController({
    workItem: stableWorkItem,
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

  return (
    <AssigneePicker
      className={className}
      viewModel={controller.viewModel}
      query={controller.query}
      onQueryChange={controller.setQuery}
      onSelect={controller.selectTarget}
      onRefresh={controller.refresh}
      onRetry={controller.retryLastTarget}
      onOpenChange={handleOpenChange}
      t={t}
    />
  );
}

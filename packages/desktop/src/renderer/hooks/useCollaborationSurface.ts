import { useMemo } from "react";
import { collaborationBridge } from "../bridge";
import {
  buildAssigneeSurfaceIndex,
  buildCollaborationNotificationDrafts,
  type AssigneeSurfaceIndex
} from "../collaboration/assigneeSurfaceViewModels";
import type { CollaborationProjectViewModel } from "../collaboration/collaborationViewModels";
import type { CollaborationReadModelController } from "../collaboration/CollaborationReadModelController";
import type { createTranslator } from "../i18n";
import type { CollaborationReadModelSnapshot } from "../../shared/collaborationReadModels.js";
import type { CollaborationStatus, PlanWeaveCollaborationApi } from "../../shared/collaboration.js";
import { useCollaborationReadModels } from "./useCollaborationReadModels";
import { useCollaborationStatus } from "./useCollaborationStatus";

export type UseCollaborationSurfaceArgs = {
  /** Active local canvas id (filters assignment pages when set). */
  canvasId?: string | null;
  api?: PlanWeaveCollaborationApi | null;
  t: ReturnType<typeof createTranslator>;
};

export type UseCollaborationSurfaceResult = {
  status: CollaborationStatus | null;
  snapshot: CollaborationReadModelSnapshot;
  viewModel: CollaborationProjectViewModel;
  controller: CollaborationReadModelController | null;
  assigneeIndex: AssigneeSurfaceIndex;
  activeProfileId: string | null;
  activeProjectId: string | null;
  sessionConnected: boolean;
  collaborationNotificationDrafts: ReturnType<typeof buildCollaborationNotificationDrafts>;
};

/**
 * Single project-shell authority for compact assignee surfaces + activity notifications.
 * Detailed people/assignee panels remain on-demand; this hook only keeps the shared
 * membership/assignment/activity projections warm for the active collaboration project.
 */
export function useCollaborationSurface(
  args: UseCollaborationSurfaceArgs
): UseCollaborationSurfaceResult {
  const api = args.api === undefined ? collaborationBridge : args.api;
  const { status } = useCollaborationStatus({ api });

  const activeProfile = useMemo(() => {
    if (!status?.activeProfileId) return null;
    return status.profiles.find((profile) => profile.profileId === status.activeProfileId) ?? null;
  }, [status]);

  const sessionConnected =
    status?.session.phase === "connected" || status?.session.phase === "ready";

  const profileId = sessionConnected ? (activeProfile?.profileId ?? null) : null;
  const projectId = sessionConnected ? (activeProfile?.projectId ?? null) : null;

  const { snapshot, viewModel, controller } = useCollaborationReadModels({
    api,
    profileId,
    projectId,
    canvasId: args.canvasId ?? null
  });

  const assigneeIndex = useMemo(() => buildAssigneeSurfaceIndex(snapshot), [snapshot]);

  const collaborationNotificationDrafts = useMemo(
    () =>
      buildCollaborationNotificationDrafts({
        activity: snapshot.activity,
        mutations: Object.values(snapshot.mutationsById),
        labels: {
          assignmentUpdated: args.t("notifyAssignmentUpdated"),
          assignmentFailed: args.t("notifyAssignmentFailed"),
          membershipChanged: args.t("notifyMembershipChanged"),
          mutationConfirmed: args.t("notifyAssignmentConfirmed"),
          mutationRejected: args.t("notifyAssignmentRejected")
        }
      }),
    [args.t, snapshot.activity, snapshot.mutationsById]
  );

  return {
    status,
    snapshot,
    viewModel,
    controller,
    assigneeIndex,
    activeProfileId: profileId,
    activeProjectId: projectId,
    sessionConnected,
    collaborationNotificationDrafts
  };
}

import { z } from "zod";
import {
  activityListWireQuerySchema,
  assignmentListQuerySchema,
  assignmentUpdateWireCommandSchema,
  commentCreateWireCommandSchema,
  commentEditWireCommandSchema,
  commentListWireQuerySchema,
  commentTombstoneWireCommandSchema,
  humanDeviceListQuerySchema,
  humanInvitationListQuerySchema,
  humanObserverCatchupRequiredSchema,
  humanObserverEventSchema,
  humanPageQuerySchema,
  opaqueIdentifierSchema,
  remoteEventQuerySchema,
  remoteHumanExecutionActionCommandSchema,
  remoteInteractionPageQuerySchema,
  remoteInteractionResponseSchema,
  workItemRefSchema,
  type ActivityListPage,
  type ActivityRecord,
  type AssignmentDisplayProjection,
  type AssignmentListPage,
  type CommentDisplayProjection,
  type CommentListPage,
  type EligibleAssigneesResponse,
  type HumanDevicePage,
  type HumanInvitationPage,
  type HumanMemberPage,
  type HumanMembershipView,
  type HumanObserverEvent,
  type RemoteActionView,
  type RemoteDispatchWireCommand,
  type RemoteEventReplay,
  type RemoteHumanExecutionActionCommand,
  type RemoteInteractionPage,
  type RemoteInteractionResponse,
  type RemoteInteractionView,
  type RemoteOperationObservation,
  type WorkItemRef
} from "@planweave-ai/collaboration-contracts";

/**
 * Renderer-facing collaboration sync lifecycle.
 * Distinct from CollaborationSessionPhase (main session/observer socket lifecycle).
 */
export type CollaborationSyncPhase =
  | "idle"
  | "loading"
  | "ready"
  | "disconnected"
  | "reconnecting"
  | "degraded"
  | "auth_expired"
  | "forbidden"
  | "stale_conflict"
  | "error";

export type CollaborationRemoteRunStatus =
  | "started"
  | "progress"
  | "succeeded"
  | "failed"
  | "interrupted";

/** Server-authoritative remote-run progress projection (not local Runtime Auto Run). */
export type CollaborationRemoteRunProjection = {
  dispatchId: string;
  projectId: string;
  workItem?: WorkItemRef;
  hostId?: string;
  status: CollaborationRemoteRunStatus;
  lastActivityId?: string;
  updatedAt: string;
};

export type CollaborationHostProjection = {
  hostId: string;
  projectId: string;
  displayName?: string;
  online: boolean;
  revoked: boolean;
  authorizedForProject: boolean;
  exists: boolean;
  capabilities: string[];
  capacityRemaining?: number;
};

export type CollaborationMutationKind =
  | "assignment"
  | "comment_create"
  | "comment_edit"
  | "comment_tombstone";

/**
 * Mutation confirmation model — never treat unconfirmed/rejected results as success.
 */
export type CollaborationMutationStatus = "pending" | "confirmed" | "rejected" | "offline";

export type CollaborationMutationRecord = {
  mutationId: string;
  kind: CollaborationMutationKind;
  workItemKey?: string;
  status: CollaborationMutationStatus;
  expectedRevision?: number;
  confirmedRevision?: number;
  errorKind?: string;
  errorCode?: string;
  errorMessage?: string;
  submittedAt: string;
  resolvedAt?: string;
};

export type CollaborationBoundaryErrorView = {
  kind: string;
  code: string;
  message: string;
  httpStatus?: number;
  retryable: boolean;
};

/** Push payload from main when the human observer advances or requires catch-up. */
export type CollaborationObserverSignal =
  | {
      type: "human.observer.event";
      profileId: string;
      projectId: string;
      event: HumanObserverEvent;
    }
  | {
      type: "human.observer.catchup_required";
      profileId: string;
      projectId: string;
      reason: "retention_gap" | "cursor_ahead" | "reset";
      resumeCursor: number;
      droppedThroughCursor?: number;
    }
  | {
      type: "human.observer.cursor";
      profileId: string;
      projectId: string;
      cursor: number;
    };

export const collaborationPageQueryInputSchema = humanPageQuerySchema;
export type CollaborationPageQueryInput = z.input<typeof collaborationPageQueryInputSchema>;

export const collaborationDeviceListQueryInputSchema = humanDeviceListQuerySchema;
export type CollaborationDeviceListQueryInput = z.input<
  typeof collaborationDeviceListQueryInputSchema
>;

export const collaborationInvitationListQueryInputSchema = humanInvitationListQuerySchema;
export type CollaborationInvitationListQueryInput = z.input<
  typeof collaborationInvitationListQueryInputSchema
>;

export const collaborationAssignmentListQueryInputSchema = assignmentListQuerySchema;
export type CollaborationAssignmentListQueryInput = z.input<
  typeof collaborationAssignmentListQueryInputSchema
>;

export const collaborationWorkItemInputSchema = z
  .object({
    workItem: workItemRefSchema
  })
  .strict();
export type CollaborationWorkItemInput = z.infer<typeof collaborationWorkItemInputSchema>;

export const collaborationCommentListQueryInputSchema = commentListWireQuerySchema;
export type CollaborationCommentListQueryInput = z.input<
  typeof collaborationCommentListQueryInputSchema
>;

export const collaborationActivityListQueryInputSchema = activityListWireQuerySchema;
export type CollaborationActivityListQueryInput = z.input<
  typeof collaborationActivityListQueryInputSchema
>;

export const collaborationAssignmentUpdateInputSchema = assignmentUpdateWireCommandSchema;
export type CollaborationAssignmentUpdateInput = z.input<
  typeof collaborationAssignmentUpdateInputSchema
>;

export const collaborationCommentCreateInputSchema = commentCreateWireCommandSchema;
export type CollaborationCommentCreateInput = z.input<typeof collaborationCommentCreateInputSchema>;

export const collaborationCommentEditInputSchema = commentEditWireCommandSchema;
export type CollaborationCommentEditInput = z.input<typeof collaborationCommentEditInputSchema>;

export const collaborationCommentTombstoneInputSchema = commentTombstoneWireCommandSchema;
export type CollaborationCommentTombstoneInput = z.input<
  typeof collaborationCommentTombstoneInputSchema
>;

export const collaborationRemoteOperationIdInputSchema = z
  .object({
    operationId: opaqueIdentifierSchema
  })
  .strict();
export type CollaborationRemoteOperationIdInput = z.infer<
  typeof collaborationRemoteOperationIdInputSchema
>;

export const collaborationRemoteEventQueryInputSchema = remoteEventQuerySchema;
export type CollaborationRemoteEventQueryInput = z.input<
  typeof collaborationRemoteEventQueryInputSchema
>;

export const collaborationRemoteInteractionPageQueryInputSchema = remoteInteractionPageQuerySchema;
export type CollaborationRemoteInteractionPageQueryInput = z.input<
  typeof collaborationRemoteInteractionPageQueryInputSchema
>;

export const collaborationRemoteActionInputSchema = z
  .object({
    operationId: opaqueIdentifierSchema,
    action: remoteHumanExecutionActionCommandSchema
  })
  .strict();
export type CollaborationRemoteActionInput = z.infer<typeof collaborationRemoteActionInputSchema>;

export const collaborationRemoteInteractionRespondInputSchema = z
  .object({
    operationId: opaqueIdentifierSchema,
    settlement: remoteInteractionResponseSchema
  })
  .strict();
export type CollaborationRemoteInteractionRespondInput = z.infer<
  typeof collaborationRemoteInteractionRespondInputSchema
>;

export type {
  RemoteActionView,
  RemoteDispatchWireCommand,
  RemoteEventReplay,
  RemoteHumanExecutionActionCommand,
  RemoteInteractionPage,
  RemoteInteractionResponse,
  RemoteInteractionView,
  RemoteOperationObservation
};

/** Stable identity key for Task/Block work items across server + local runtime. */
export function workItemKey(workItem: WorkItemRef): string {
  if (workItem.kind === "task") {
    return `task:${workItem.canvasId}:${workItem.taskId}`;
  }
  return `block:${workItem.canvasId}:${workItem.blockRef}`;
}

export function parseWorkItemKey(key: string): WorkItemRef | null {
  const taskMatch = /^task:([^:]+):(.+)$/.exec(key);
  if (taskMatch) {
    return { kind: "task", canvasId: taskMatch[1]!, taskId: taskMatch[2]! };
  }
  const blockMatch = /^block:([^:]+):(.+)$/.exec(key);
  if (blockMatch) {
    return { kind: "block", canvasId: blockMatch[1]!, blockRef: blockMatch[2]! };
  }
  return null;
}

export type CollaborationReadModelSnapshot = {
  profileId: string | null;
  projectId: string | null;
  canvasId: string | null;
  syncPhase: CollaborationSyncPhase;
  observerCursor: number;
  members: HumanMembershipView[];
  hosts: CollaborationHostProjection[];
  assignmentsByWorkItem: Record<string, AssignmentDisplayProjection>;
  commentsByWorkItem: Record<string, CommentDisplayProjection[]>;
  activity: ActivityRecord[];
  remoteRunsByDispatchId: Record<string, CollaborationRemoteRunProjection>;
  mutationsById: Record<string, CollaborationMutationRecord>;
  lastError: CollaborationBoundaryErrorView | null;
  loadingKinds: string[];
  updatedAt: string;
};

export type {
  ActivityListPage,
  ActivityRecord,
  AssignmentDisplayProjection,
  AssignmentListPage,
  CommentDisplayProjection,
  CommentListPage,
  EligibleAssigneesResponse,
  HumanDevicePage,
  HumanInvitationPage,
  HumanMemberPage,
  HumanMembershipView,
  HumanObserverEvent,
  WorkItemRef
};

// Re-export observer event schema for main-side validation of fan-out payloads.
export { humanObserverEventSchema, humanObserverCatchupRequiredSchema };

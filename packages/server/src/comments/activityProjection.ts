import { createHash } from "node:crypto";
import { humanPrincipalIdSchema, type ProjectMemberRole } from "../identity/schemas.js";
import type { WorkItemRef } from "../work/schemas.js";
import { ACTIVITY_HEADLINE_MAX_LENGTH } from "./limits.js";
import {
  activityRecordSchema,
  commentIdSchema,
  type ActivityRecord,
  type ActivitySource,
  type ActivitySubject,
  type ActivitySummary,
  type ActivityType
} from "./schemas.js";

/** Replace block-ref `#` so composite source ids stay opaque-identifier-safe. */
export function opaqueWorkItemKey(workItem: WorkItemRef): string {
  if (workItem.kind === "task") return workItem.taskId;
  return workItem.blockRef.replaceAll("#", "--");
}

type ActivitySourceIdentity = string | number | readonly ActivitySourceIdentity[];

function versionedActivitySourceId(
  kind: "assignment" | "membership",
  identity: readonly ActivitySourceIdentity[]
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["activity-source/v1", kind, identity]))
    .digest("hex");
  return `${kind}:v1:${digest}`;
}

export function membershipActivitySourceId(
  membershipId: string,
  type: "member_joined" | "member_left" | "member_removed" | "owner_promoted" | "owner_demoted",
  transitionRevision: number
): string {
  switch (type) {
    case "member_joined":
      return `${membershipId}:joined:r${transitionRevision}`;
    case "member_left":
      return `${membershipId}:left:r${transitionRevision}`;
    case "member_removed":
      return `${membershipId}:removed:r${transitionRevision}`;
    case "owner_promoted":
      return `${membershipId}:promoted:r${transitionRevision}`;
    case "owner_demoted":
      return `${membershipId}:demoted:r${transitionRevision}`;
  }
}

export function commentActivitySourceId(
  commentId: string,
  type: "comment_created" | "comment_edited" | "comment_tombstoned",
  revision?: number
): string {
  switch (type) {
    case "comment_created":
      return commentId;
    case "comment_edited":
      return `${commentId}:edit:${revision ?? 0}`;
    case "comment_tombstoned":
      return `${commentId}:tombstone`;
  }
}

export function assignmentActivitySourceId(
  projectId: string,
  workItem: WorkItemRef,
  revision: number
): string {
  const structuredWorkItem: readonly ActivitySourceIdentity[] =
    workItem.kind === "task"
      ? [workItem.kind, workItem.canvasId, workItem.taskId]
      : [workItem.kind, workItem.canvasId, workItem.blockRef];
  return versionedActivitySourceId("assignment", [projectId, structuredWorkItem, revision]);
}

export function remoteRunActivitySourceId(
  dispatchId: string,
  type:
    | "remote_run_started"
    | "remote_run_succeeded"
    | "remote_run_failed"
    | "remote_run_interrupted"
): string {
  const suffix = type.replace("remote_run_", "");
  return `${dispatchId}:${suffix}`;
}

function clipHeadline(value: string): string {
  if (value.length <= ACTIVITY_HEADLINE_MAX_LENGTH) return value;
  return `${value.slice(0, ACTIVITY_HEADLINE_MAX_LENGTH - 1)}…`;
}

export type MembershipActivityInput = {
  activityId: string;
  projectId: string;
  type: "member_joined" | "member_left" | "member_removed" | "owner_promoted" | "owner_demoted";
  membershipId: string;
  transitionRevision: number;
  humanPrincipalId: string;
  displayName?: string;
  membershipRole?: ProjectMemberRole;
  actorDisplayName?: string;
  occurredAt: string;
};

export function buildMembershipActivity(input: MembershipActivityInput): ActivityRecord {
  const source: ActivitySource = {
    kind: "membership",
    sourceId: membershipActivitySourceId(input.membershipId, input.type, input.transitionRevision)
  };
  const verb: Record<MembershipActivityInput["type"], string> = {
    member_joined: "joined the project",
    member_left: "left the project",
    member_removed: "was removed from the project",
    owner_promoted: "was promoted to owner",
    owner_demoted: "was demoted from owner"
  };
  const humanPrincipalId = humanPrincipalIdSchema.parse(input.humanPrincipalId);
  const name = input.displayName ?? humanPrincipalId;
  const summary: ActivitySummary = {
    headline: clipHeadline(`${name} ${verb[input.type]}`),
    humanPrincipalId,
    ...(input.membershipRole ? { membershipRole: input.membershipRole } : {})
  };
  const subjects: ActivitySubject[] = [
    {
      kind: "human",
      humanPrincipalId,
      ...(input.displayName ? { displayName: input.displayName } : {})
    }
  ];
  return activityRecordSchema.parse({
    activityId: input.activityId,
    projectId: input.projectId,
    type: input.type,
    source,
    summary,
    subjects,
    occurredAt: input.occurredAt
  });
}

export type AssignmentActivityInput = {
  activityId: string;
  projectId: string;
  workItem: WorkItemRef;
  assignmentRevision: number;
  actor?: ActivitySubject;
  targetHeadline: string;
  occurredAt: string;
};

export function buildAssignmentActivity(input: AssignmentActivityInput): ActivityRecord {
  const summary: ActivitySummary = {
    headline: clipHeadline(input.targetHeadline),
    workItem: input.workItem,
    assignmentRevision: input.assignmentRevision
  };
  const subjects: ActivitySubject[] = input.actor ? [input.actor] : [];
  return activityRecordSchema.parse({
    activityId: input.activityId,
    projectId: input.projectId,
    type: "assignment_updated",
    source: {
      kind: "assignment",
      sourceId: assignmentActivitySourceId(
        input.projectId,
        input.workItem,
        input.assignmentRevision
      )
    },
    summary,
    subjects,
    workItem: input.workItem,
    occurredAt: input.occurredAt
  });
}

export type CommentActivityInput = {
  activityId: string;
  projectId: string;
  type: "comment_created" | "comment_edited" | "comment_tombstoned";
  commentId: string;
  workItem: WorkItemRef;
  authorHumanPrincipalId: string;
  authorDisplayName?: string;
  revision: number;
  occurredAt: string;
};

export function buildCommentActivity(input: CommentActivityInput): ActivityRecord {
  const verbs: Record<CommentActivityInput["type"], string> = {
    comment_created: "commented",
    comment_edited: "edited a comment",
    comment_tombstoned: "removed a comment"
  };
  const authorHumanPrincipalId = humanPrincipalIdSchema.parse(input.authorHumanPrincipalId);
  const name = input.authorDisplayName ?? authorHumanPrincipalId;
  const commentId = commentIdSchema.parse(input.commentId);
  const summary: ActivitySummary = {
    headline: clipHeadline(`${name} ${verbs[input.type]}`),
    workItem: input.workItem,
    commentId
  };
  const subjects: ActivitySubject[] = [
    {
      kind: "human",
      humanPrincipalId: authorHumanPrincipalId,
      ...(input.authorDisplayName ? { displayName: input.authorDisplayName } : {})
    }
  ];
  return activityRecordSchema.parse({
    activityId: input.activityId,
    projectId: input.projectId,
    type: input.type,
    source: {
      kind: "comment",
      sourceId: commentActivitySourceId(String(commentId), input.type, input.revision)
    },
    summary,
    subjects,
    workItem: input.workItem,
    occurredAt: input.occurredAt
  });
}

export type RemoteRunActivityInput = {
  activityId: string;
  projectId: string;
  type:
    | "remote_run_started"
    | "remote_run_succeeded"
    | "remote_run_failed"
    | "remote_run_interrupted";
  dispatchId: string;
  hostId?: string;
  workItem?: WorkItemRef;
  hostDisplayName?: string;
  occurredAt: string;
};

export function buildRemoteRunActivity(input: RemoteRunActivityInput): ActivityRecord {
  const labels: Record<RemoteRunActivityInput["type"], string> = {
    remote_run_started: "Remote run started",
    remote_run_succeeded: "Remote run succeeded",
    remote_run_failed: "Remote run failed",
    remote_run_interrupted: "Remote run interrupted"
  };
  const summary: ActivitySummary = {
    headline: clipHeadline(labels[input.type]),
    dispatchId: input.dispatchId,
    ...(input.hostId ? { hostId: input.hostId } : {}),
    ...(input.workItem ? { workItem: input.workItem } : {})
  };
  const subjects: ActivitySubject[] = [];
  if (input.hostId) {
    subjects.push({
      kind: "host",
      hostId: input.hostId,
      ...(input.hostDisplayName ? { displayName: input.hostDisplayName } : {})
    });
  } else {
    subjects.push({ kind: "system" });
  }
  return activityRecordSchema.parse({
    activityId: input.activityId,
    projectId: input.projectId,
    type: input.type as ActivityType,
    source: {
      kind: "remote_run",
      sourceId: remoteRunActivitySourceId(input.dispatchId, input.type)
    },
    summary,
    subjects,
    ...(input.workItem ? { workItem: input.workItem } : {}),
    occurredAt: input.occurredAt
  });
}

import type { AssignmentDisplayProjection } from "@planweave-ai/collaboration-protocol/work/assignment";
import type { CommentDisplayProjection } from "@planweave-ai/collaboration-protocol/activity/comments";
import type { WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  workItemKey,
  type CollaborationHostProjection
} from "../../shared/collaborationReadModels.js";

export function ingestAssignmentHost(
  hosts: Map<string, CollaborationHostProjection>,
  assignment: AssignmentDisplayProjection
): void {
  if (!assignment.host) return;
  const existing = hosts.get(assignment.host.hostId);
  hosts.set(assignment.host.hostId, {
    hostId: assignment.host.hostId,
    projectId: assignment.projectId,
    displayName: assignment.host.displayName,
    online: assignment.host.online,
    revoked: assignment.host.revoked,
    authorizedForProject: assignment.host.authorizedForProject,
    exists: true,
    capabilities: existing?.capabilities ?? [],
    capacityRemaining: existing?.capacityRemaining
  });
}

export function upsertCommentProjection(
  comments: Map<string, CommentDisplayProjection[]>,
  trackedWorkItems: Map<string, WorkItemRef>,
  projection: CommentDisplayProjection
): void {
  const key = workItemKey(projection.workItem);
  const next = (comments.get(key) ?? []).filter((item) => item.commentId !== projection.commentId);
  next.push(projection);
  next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  comments.set(key, next);
  trackedWorkItems.set(key, projection.workItem);
}

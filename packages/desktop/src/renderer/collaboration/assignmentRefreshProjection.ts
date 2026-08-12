import type {
  AssignmentDisplayProjection,
  EligibleHostBatchResponse
} from "@planweave-ai/collaboration-protocol/work/assignment";
import { WORK_ELIGIBLE_HOST_BATCH_MAX } from "@planweave-ai/collaboration-protocol/core/limits";
import type { BlockWorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  workItemKey,
  type CollaborationHostProjection
} from "../../shared/collaborationReadModels.js";

export type AssignmentRefreshProjection = {
  assignments: Map<string, AssignmentDisplayProjection>;
  eligibleHosts: Map<string, CollaborationHostProjection>;
};

export function mergeAssignmentHosts(
  assignments: ReadonlyMap<string, AssignmentDisplayProjection>,
  eligibleHosts: ReadonlyMap<string, CollaborationHostProjection>
): Map<string, CollaborationHostProjection> {
  const hosts = new Map<string, CollaborationHostProjection>();
  for (const assignment of assignments.values()) {
    if (!assignment.host) continue;
    hosts.set(assignment.host.hostId, {
      hostId: assignment.host.hostId,
      projectId: assignment.projectId,
      displayName: assignment.host.displayName,
      online: assignment.host.online,
      revoked: assignment.host.revoked,
      authorizedForProject: assignment.host.authorizedForProject,
      exists: true,
      capabilities: []
    });
  }
  for (const [hostId, eligible] of eligibleHosts) {
    const assigned = hosts.get(hostId);
    hosts.set(
      hostId,
      assigned
        ? {
            ...eligible,
            ...assigned,
            capabilities: eligible.capabilities,
            capacityRemaining: eligible.capacityRemaining
          }
        : eligible
    );
  }
  return hosts;
}

export async function buildAssignmentRefreshProjection(input: {
  items: readonly AssignmentDisplayProjection[];
  readEligibleHosts(workItems: BlockWorkItemRef[]): Promise<EligibleHostBatchResponse>;
  isCurrent(): boolean;
}): Promise<AssignmentRefreshProjection | null> {
  const assignments = new Map<string, AssignmentDisplayProjection>();
  const eligibleHosts = new Map<string, CollaborationHostProjection>();
  const blockItems: BlockWorkItemRef[] = [];
  const seenBlockItems = new Set<string>();

  for (const item of input.items) {
    assignments.set(workItemKey(item.workItem), item);
    if (item.workItem.kind !== "block") continue;
    const key = workItemKey(item.workItem);
    if (seenBlockItems.has(key)) continue;
    seenBlockItems.add(key);
    blockItems.push(item.workItem);
  }

  for (
    let batchStart = 0;
    batchStart < blockItems.length;
    batchStart += WORK_ELIGIBLE_HOST_BATCH_MAX
  ) {
    const eligible = await input.readEligibleHosts(
      blockItems.slice(batchStart, batchStart + WORK_ELIGIBLE_HOST_BATCH_MAX)
    );
    if (!input.isCurrent()) return null;
    for (const host of eligible.hosts) {
      eligibleHosts.set(host.hostId, {
        hostId: host.hostId,
        projectId: host.projectId,
        displayName: host.displayName,
        online: host.online,
        revoked: host.revoked,
        authorizedForProject: host.authorizedForProject,
        exists: host.exists,
        capabilities: host.capabilities,
        capacityRemaining: host.capacityRemaining
      });
    }
  }
  return { assignments, eligibleHosts };
}

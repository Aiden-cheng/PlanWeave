import type { AgentHost, AgentHostRepository } from "../hosts.js";
import type { HumanIdentityRepository } from "../identity/repository.js";
import { isActiveMembership } from "../identity/schemas.js";
import {
  assignmentHostFactsSchema,
  assignmentMembershipFactsSchema,
  workItemPackageFactsSchema,
  type AssignmentHostFacts,
  type AssignmentMembershipFacts,
  type WorkItemPackageFacts,
  type WorkItemRef
} from "./schemas.js";
import type { WorkItemPackagePort } from "./workItemFacts.js";

/**
 * Live membership facts for assignment targets. Identity membership rows are the truth source.
 */
export type AssignmentMembershipPort = {
  getMembershipFacts(
    projectId: string,
    humanPrincipalId: string
  ): AssignmentMembershipFacts | undefined;
  listActiveMemberFacts(
    projectId: string,
    limit: number,
    offset: number
  ): AssignmentMembershipFacts[];
};

/**
 * Live Host facts for exact Host assignment and eligibility display.
 * Host presence/capabilities are never stored on the assignment row.
 */
export type AssignmentHostPort = {
  getHostFacts(projectId: string, hostId: string): AssignmentHostFacts | undefined;
  listHostFacts(
    projectId: string,
    options?: {
      requiredCapabilities?: readonly string[];
      limit?: number;
      offset?: number;
    }
  ): AssignmentHostFacts[];
};

export type AssignmentMembershipPortFromIdentityOptions = {
  identity: HumanIdentityRepository;
};

export function createIdentityMembershipPort(
  options: AssignmentMembershipPortFromIdentityOptions
): AssignmentMembershipPort {
  const { identity } = options;
  return {
    getMembershipFacts(projectId, humanPrincipalId) {
      const membership = identity.getActiveMembership(projectId, humanPrincipalId);
      const principal = identity.getPrincipal(humanPrincipalId);
      if (membership) {
        return assignmentMembershipFactsSchema.parse({
          projectId: membership.projectId,
          humanPrincipalId: membership.humanPrincipalId,
          membershipActive: isActiveMembership(membership),
          displayName: principal?.displayName
        });
      }
      // Principal without active membership → inactive facts for availability projection.
      if (principal) {
        return assignmentMembershipFactsSchema.parse({
          projectId,
          humanPrincipalId,
          membershipActive: false,
          displayName: principal.displayName
        });
      }
      return undefined;
    },
    listActiveMemberFacts(projectId, limit, offset) {
      return identity.listActiveMembers(projectId, limit, offset).map((membership) => {
        const principal = identity.getPrincipal(membership.humanPrincipalId);
        return assignmentMembershipFactsSchema.parse({
          projectId: membership.projectId,
          humanPrincipalId: membership.humanPrincipalId,
          membershipActive: true,
          displayName: principal?.displayName ?? membership.humanPrincipalId
        });
      });
    }
  };
}

export type AssignmentHostPortFromRepositoryOptions = {
  hosts: AgentHostRepository;
  /**
   * Hosts without a project binding table default to authorized when not revoked.
   * Callers may override when a project↔host authorization model is introduced.
   */
  isHostAuthorizedForProject?: (projectId: string, host: AgentHost) => boolean;
  /** Hosts with lastSeenAt after this threshold (ms ago) count as online. Default 60s. */
  hostOfflineAfterMs?: number;
  clock?: () => Date;
  /** Optional active-dispatch counter for capacityRemaining; omit capacity when unknown. */
  countActiveDispatches?: (hostId: string) => number;
};

export function createHostAssignmentPort(
  options: AssignmentHostPortFromRepositoryOptions
): AssignmentHostPort {
  const clock = options.clock ?? (() => new Date());
  const hostOfflineAfterMs = options.hostOfflineAfterMs ?? 60_000;
  const isAuthorized =
    options.isHostAuthorizedForProject ??
    ((_projectId: string, host: AgentHost) => host.revokedAt === undefined);

  function toFacts(projectId: string, host: AgentHost): AssignmentHostFacts {
    const now = clock().getTime();
    const online =
      host.revokedAt === undefined &&
      host.lastSeenAt !== undefined &&
      Date.parse(host.lastSeenAt) >= now - hostOfflineAfterMs;
    const active = options.countActiveDispatches?.(host.id);
    return assignmentHostFactsSchema.parse({
      projectId,
      hostId: host.id,
      exists: true,
      revoked: host.revokedAt !== undefined,
      authorizedForProject: isAuthorized(projectId, host),
      online,
      capabilities: [...host.capabilities],
      displayName: host.displayName,
      ...(active !== undefined ? { capacityRemaining: Math.max(0, host.capacity - active) } : {})
    });
  }

  return {
    getHostFacts(projectId, hostId) {
      const host = options.hosts.get(hostId);
      if (!host) {
        return assignmentHostFactsSchema.parse({
          projectId,
          hostId,
          exists: false,
          revoked: false,
          authorizedForProject: false,
          online: false,
          capabilities: []
        });
      }
      return toFacts(projectId, host);
    },
    listHostFacts(projectId, listOptions = {}) {
      const limit = listOptions.limit ?? 100;
      const offset = listOptions.offset ?? 0;
      // Pull a page of hosts; filter capabilities in application (Host list is already ordered).
      const hosts = options.hosts
        .list(Math.min(limit + offset, 100), 0)
        .slice(offset, offset + limit);
      const required = listOptions.requiredCapabilities ?? [];
      return hosts
        .map((host) => toFacts(projectId, host))
        .filter((facts) => {
          if (!facts.exists || facts.revoked || !facts.authorizedForProject) return false;
          if (required.length === 0) return true;
          const available = new Set(facts.capabilities);
          return required.every((capability) => available.has(capability));
        });
    }
  };
}

/**
 * Route WorkItemRef resolution across multiple canvas package ports.
 * Missing canvas returns exists:false facts without inventing package content.
 */
export function createRoutedWorkItemPackagePort(
  resolveCanvas: (canvasId: string) => WorkItemPackagePort | undefined
): WorkItemPackagePort {
  return {
    resolveWorkItem(workItem: WorkItemRef): WorkItemPackageFacts {
      const port = resolveCanvas(workItem.canvasId);
      if (!port) {
        return workItemPackageFactsSchema.parse({
          canvasId: workItem.canvasId,
          kind: workItem.kind,
          exists: false,
          taskId: workItem.kind === "task" ? workItem.taskId : undefined,
          blockRef: workItem.kind === "block" ? workItem.blockRef : undefined,
          requiredCapabilities: []
        });
      }
      return port.resolveWorkItem(workItem);
    }
  };
}

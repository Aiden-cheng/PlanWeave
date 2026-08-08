import {
  agentEndpointCapabilitiesSchema,
  assertRemoteAgentEndpointRedacted,
  remoteAgentEndpointListSchema,
  remoteAgentEndpointSchema,
  type AgentEndpointErrorCode,
  type AgentEndpointUnavailableReason,
  type RemoteAgentEndpoint,
  type RemoteAgentEndpointList
} from "@planweave-ai/collaboration-protocol/agent-endpoint";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { createHash } from "node:crypto";
import { workspaceIdSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import type { AgentHost } from "./hosts.js";

/**
 * Server-scoped Host fleet inventory for Agent Endpoint catalog projection.
 * `listActiveHosts` is the primary source; `listExclusivelyBoundToWorkspace`
 * remains for legacy `listVisible(workspaceId)` filtering during compat.
 */
export interface AgentEndpointHostPort {
  listActiveHosts(): AgentHost[];
  listExclusivelyBoundToWorkspace(workspaceId: string): AgentHost[];
}

export interface AgentEndpointCapacityPort {
  activeCountsForHosts(hostIds: readonly string[]): ReadonlyMap<string, number>;
}

export type ResolvedAgentEndpoint = {
  endpointId: string;
  hostId: string;
  profileId: string;
  agentId: string;
  displayName: string;
  hostDisplayName: string;
  capabilities: string[];
  resolvedAt: string;
};

type CatalogErrorCode = Extract<
  AgentEndpointErrorCode,
  "agent_endpoint_unknown" | "agent_endpoint_unavailable" | "agent_endpoint_incompatible"
>;

export class AgentEndpointCatalogError extends Error {
  constructor(readonly code: CatalogErrorCode) {
    super(code);
    this.name = "AgentEndpointCatalogError";
  }
}

export function agentEndpointCatalogErrorCode(error: unknown): CatalogErrorCode | undefined {
  return error instanceof AgentEndpointCatalogError ? error.code : undefined;
}

export type AgentEndpointCatalogOptions = {
  hosts: AgentEndpointHostPort;
  capacities: AgentEndpointCapacityPort;
  hostOfflineAfterMs: number;
  clock?: () => Date;
};

type InternalCandidate = {
  endpoint: RemoteAgentEndpoint;
  host: AgentHost;
  profile: NonNullable<AgentHost["readinessObservation"]>["acpProfiles"][number];
};

type CandidateScope = "fleet" | "workspace";

function hashEndpointId(parts: readonly string[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(parts), "utf8")
    .digest("base64url");
  return opaqueIdentifierSchema.parse(`aep_${digest}`);
}

/** Server-scoped stable endpoint identity (Phase B). */
export function endpointIdFor(input: {
  hostId: string;
  profileId: string;
  agentId: string;
}): string {
  return hashEndpointId([input.hostId, input.profileId, input.agentId]);
}

/** Legacy workspace-scoped endpoint identity for compat dual-read. */
export function legacyEndpointIdFor(input: {
  workspaceId: string;
  hostId: string;
  profileId: string;
  agentId: string;
}): string {
  return hashEndpointId([input.workspaceId, input.hostId, input.profileId, input.agentId]);
}

function unavailableReason(
  host: AgentHost,
  workspaceId: string | undefined,
  profile: InternalCandidate["profile"],
  activeReservations: number,
  now: Date,
  hostOfflineAfterMs: number,
  duplicateProfile: boolean,
  scope: CandidateScope
): AgentEndpointUnavailableReason | undefined {
  if (host.revokedAt !== undefined) return "host_revoked";
  const credentialExpiry =
    host.credentialExpiresAt === undefined ? undefined : Date.parse(host.credentialExpiresAt);
  if (
    credentialExpiry !== undefined &&
    (!Number.isFinite(credentialExpiry) || credentialExpiry <= now.getTime())
  ) {
    return "host_credential_expired";
  }
  const lastSeenAt = host.lastSeenAt === undefined ? undefined : Date.parse(host.lastSeenAt);
  if (
    lastSeenAt === undefined ||
    !Number.isFinite(lastSeenAt) ||
    lastSeenAt < now.getTime() - hostOfflineAfterMs
  ) {
    return "host_offline";
  }
  if (scope === "workspace" && workspaceId !== undefined) {
    const mappings =
      host.readinessObservation?.workspaceMappings.filter(
        (mapping) => mapping.workspaceId === workspaceId
      ) ?? [];
    if (mappings.length === 0 || mappings[0]?.status === "missing") {
      return "workspace_mapping_missing";
    }
    if (mappings.length !== 1 || mappings[0]?.status === "invalid") {
      return "workspace_mapping_invalid";
    }
  }
  if (duplicateProfile || profile.status === "invalid") return "profile_invalid";
  if (profile.status === "missing") return "profile_missing";
  if (!profile.capabilities.every((capability) => host.capabilities.includes(capability))) {
    return "profile_invalid";
  }
  if (activeReservations >= host.capacity) return "at_capacity";
  return undefined;
}

export class AgentEndpointCatalog {
  private readonly clock: () => Date;

  constructor(private readonly options: AgentEndpointCatalogOptions) {
    if (!Number.isInteger(options.hostOfflineAfterMs) || options.hostOfflineAfterMs < 1_000) {
      throw new Error("host_offline_after_invalid");
    }
    this.clock = options.clock ?? (() => new Date());
  }

  /**
   * Server-scoped fleet catalog. Primary listing API for Owner Fleet.
   * Hosts remain visible when collaboration workspace mappings are absent;
   * offline/profile/capacity reasons still apply.
   */
  listVisibleFleet(): RemoteAgentEndpointList {
    const items = this.currentFleetCandidates().map((candidate) => candidate.endpoint);
    return remoteAgentEndpointListSchema.parse({
      schemaVersion: "agent-endpoint-list/v1",
      items
    });
  }

  /**
   * Legacy workspace-scoped listing for project HTTP compat.
   * Filters the fleet to Hosts exclusively bound to `workspaceId` after read
   * cutover, and applies workspace mapping availability rules.
   */
  listVisible(workspaceIdInput: string): RemoteAgentEndpointList {
    const workspaceId = workspaceIdSchema.parse(workspaceIdInput);
    const boundHostIds = new Set(
      this.options.hosts
        .listExclusivelyBoundToWorkspace(workspaceId)
        .map((host) => host.id)
    );
    const items = this.currentFleetCandidates()
      .filter((candidate) => boundHostIds.has(candidate.host.id))
      .map((candidate) => {
        const reason = unavailableReason(
          candidate.host,
          workspaceId,
          candidate.profile,
          this.options.capacities.activeCountsForHosts([candidate.host.id]).get(candidate.host.id) ??
            0,
          this.clock(),
          this.options.hostOfflineAfterMs,
          this.profileIdentityCount(candidate.host, candidate.profile) !== 1,
          "workspace"
        );
        const endpoint = remoteAgentEndpointSchema.parse({
          ...candidate.endpoint,
          status: reason === undefined ? "available" : "unavailable",
          ...(reason === undefined ? {} : { unavailableReason: reason })
        });
        assertRemoteAgentEndpointRedacted(endpoint);
        return endpoint;
      });
    return remoteAgentEndpointListSchema.parse({
      schemaVersion: "agent-endpoint-list/v1",
      items
    });
  }

  resolveForRun(
    endpointIdInput: string,
    workspaceIdInput: string,
    requiredCapabilitiesInput: readonly string[]
  ): ResolvedAgentEndpoint {
    const endpointId = opaqueIdentifierSchema.parse(endpointIdInput);
    const workspaceId = workspaceIdSchema.parse(workspaceIdInput);
    const requiredCapabilities = agentEndpointCapabilitiesSchema.parse(requiredCapabilitiesInput);
    const candidate = this.findCandidateForResolve(endpointId, workspaceId);
    if (!candidate) throw new AgentEndpointCatalogError("agent_endpoint_unknown");
    if (candidate.endpoint.status !== "available") {
      throw new AgentEndpointCatalogError("agent_endpoint_unavailable");
    }
    if (
      !requiredCapabilities.every(
        (capability) =>
          candidate.host.capabilities.includes(capability) &&
          candidate.profile.capabilities.includes(capability)
      )
    ) {
      throw new AgentEndpointCatalogError("agent_endpoint_incompatible");
    }
    return this.toResolved(candidate);
  }

  resolveForReservedRun(
    endpointIdInput: string,
    workspaceIdInput: string,
    requiredCapabilitiesInput: readonly string[],
    expectedHostIdInput: string
  ): ResolvedAgentEndpoint {
    const endpointId = opaqueIdentifierSchema.parse(endpointIdInput);
    const workspaceId = workspaceIdSchema.parse(workspaceIdInput);
    const expectedHostId = opaqueIdentifierSchema.parse(expectedHostIdInput);
    const requiredCapabilities = agentEndpointCapabilitiesSchema.parse(requiredCapabilitiesInput);
    const candidate = this.findCandidateForResolve(endpointId, workspaceId);
    if (!candidate || candidate.host.id !== expectedHostId) {
      throw new AgentEndpointCatalogError("agent_endpoint_unknown");
    }
    if (
      candidate.endpoint.status !== "available" &&
      candidate.endpoint.unavailableReason !== "at_capacity"
    ) {
      throw new AgentEndpointCatalogError("agent_endpoint_unavailable");
    }
    if (
      !requiredCapabilities.every(
        (capability) =>
          candidate.host.capabilities.includes(capability) &&
          candidate.profile.capabilities.includes(capability)
      )
    ) {
      throw new AgentEndpointCatalogError("agent_endpoint_incompatible");
    }
    return this.toResolved(candidate);
  }

  private findCandidateForResolve(
    endpointId: string,
    workspaceId: string
  ): InternalCandidate | undefined {
    const fleetCandidates = this.currentFleetCandidates();
    const byNewId = fleetCandidates.find((current) => current.endpoint.endpointId === endpointId);
    if (byNewId) return byNewId;
    return fleetCandidates.find(
      (current) =>
        legacyEndpointIdFor({
          workspaceId,
          hostId: current.host.id,
          profileId: current.profile.profileId,
          agentId: current.profile.agentId
        }) === endpointId
    );
  }

  private toResolved(candidate: InternalCandidate): ResolvedAgentEndpoint {
    return {
      endpointId: candidate.endpoint.endpointId,
      hostId: candidate.host.id,
      profileId: candidate.profile.profileId,
      agentId: candidate.profile.agentId,
      displayName: candidate.profile.displayName,
      hostDisplayName: candidate.host.displayName,
      capabilities: [...candidate.profile.capabilities],
      resolvedAt: this.clock().toISOString()
    };
  }

  private profileIdentityCount(
    host: AgentHost,
    profile: InternalCandidate["profile"]
  ): number {
    const identity = `${profile.profileId}\u0000${profile.agentId}`;
    let count = 0;
    for (const observed of host.readinessObservation?.acpProfiles ?? []) {
      if (`${observed.profileId}\u0000${observed.agentId}` === identity) count += 1;
    }
    return count;
  }

  private currentFleetCandidates(): InternalCandidate[] {
    const now = this.clock();
    const hosts = this.options.hosts.listActiveHosts();
    const activeCounts = this.options.capacities.activeCountsForHosts(hosts.map((host) => host.id));
    const candidates: InternalCandidate[] = [];
    for (const host of hosts) {
      const profiles = host.readinessObservation?.acpProfiles ?? [];
      const identityCounts = new Map<string, number>();
      for (const profile of profiles) {
        const identity = `${profile.profileId}\u0000${profile.agentId}`;
        identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
      }
      const emitted = new Set<string>();
      for (const profile of profiles) {
        const identity = `${profile.profileId}\u0000${profile.agentId}`;
        if (emitted.has(identity)) continue;
        emitted.add(identity);
        const reason = unavailableReason(
          host,
          undefined,
          profile,
          activeCounts.get(host.id) ?? 0,
          now,
          this.options.hostOfflineAfterMs,
          identityCounts.get(identity) !== 1,
          "fleet"
        );
        const endpoint = remoteAgentEndpointSchema.parse({
          schemaVersion: "agent-endpoint/v1",
          endpointId: endpointIdFor({
            hostId: host.id,
            profileId: profile.profileId,
            agentId: profile.agentId
          }),
          agentId: profile.agentId,
          profileId: profile.profileId,
          displayName: profile.displayName,
          hostDisplayName: host.displayName,
          status: reason === undefined ? "available" : "unavailable",
          ...(reason === undefined ? {} : { unavailableReason: reason }),
          capabilities: profile.capabilities
        });
        assertRemoteAgentEndpointRedacted(endpoint);
        candidates.push({ endpoint, host, profile });
      }
    }
    return candidates.sort((left, right) =>
      left.endpoint.endpointId.localeCompare(right.endpoint.endpointId)
    );
  }
}

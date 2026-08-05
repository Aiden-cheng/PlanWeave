import type { RemoteAgentEndpoint } from "@planweave-ai/collaboration-protocol/agent-endpoint";

export type AvailableAgentEndpoint = {
  id: string;
  source: "local" | "remote";
  executorName: string;
  displayName: string;
  locationName: string;
  available: boolean;
  unavailableReason: string | null;
  capabilities: string[];
  localExecutorName?: string;
  remoteEndpointId?: string;
};

export type LogicalAgentEndpointInput = {
  executorName: string;
  profileId: string;
  agentId: string | null;
  displayName: string;
  capabilities: string[];
  available: boolean;
  unavailableReason: string | null;
  custom: boolean;
};

export function agentEndpointDisplayLabel(endpoint: AvailableAgentEndpoint): string {
  return endpoint.source === "local"
    ? endpoint.displayName
    : `${endpoint.displayName} · ${endpoint.locationName}`;
}

export type LocalAgentEndpointInput = {
  executorName: string;
  displayName: string;
  locationName: string;
  capabilities: string[];
  available: boolean;
  unavailableReason: string | null;
};

export type LocalAgentEndpointAvailabilityInput = {
  executorName: string;
  displayName: string;
  locationName: string;
  capabilities: string[];
  profileExists: boolean;
  detected: boolean;
  preflightLoading: boolean;
  preflightError: string | null;
  preflightOk: boolean | null;
};

export function buildLocalAgentEndpoint(
  input: LocalAgentEndpointAvailabilityInput
): LocalAgentEndpointInput {
  const available =
    input.profileExists &&
    input.detected &&
    !input.preflightLoading &&
    input.preflightError === null &&
    input.preflightOk !== false;
  let unavailableReason: string | null = "agent_endpoint_local_preflight_failed";
  if (available) unavailableReason = null;
  else if (!input.profileExists) unavailableReason = "agent_endpoint_local_profile_missing";
  else if (!input.detected) unavailableReason = "agent_endpoint_local_not_detected";
  return {
    executorName: input.executorName,
    displayName: input.displayName,
    locationName: input.locationName,
    capabilities: [...input.capabilities],
    available,
    unavailableReason
  };
}

export function buildAvailableAgentEndpoints(input: {
  local: readonly LocalAgentEndpointInput[];
  remote: readonly RemoteAgentEndpoint[];
  requiredProfileId: string | null;
  requiredAgentId?: RemoteAgentEndpoint["agentId"] | null;
  requiredCapabilities: readonly string[];
}): AvailableAgentEndpoint[] {
  const local = input.local.map((endpoint): AvailableAgentEndpoint => {
    const profileCompatible =
      input.requiredProfileId !== null && endpoint.executorName === input.requiredProfileId;
    const capabilitiesCompatible = input.requiredCapabilities.every((capability) =>
      endpoint.capabilities.includes(capability)
    );
    return {
      id: `local:${endpoint.executorName}`,
      source: "local",
      executorName: endpoint.executorName,
      displayName: endpoint.displayName,
      locationName: endpoint.locationName,
      capabilities: [...endpoint.capabilities],
      available: endpoint.available && profileCompatible && capabilitiesCompatible,
      unavailableReason:
        profileCompatible && capabilitiesCompatible
          ? endpoint.unavailableReason
          : "agent_endpoint_incompatible",
      localExecutorName: endpoint.executorName
    };
  });
  const remote = input.remote.map((endpoint): AvailableAgentEndpoint => {
    const profileCompatible =
      input.requiredProfileId !== null &&
      (endpoint.profileId === input.requiredProfileId ||
        (input.requiredAgentId !== null &&
          input.requiredAgentId !== undefined &&
          endpoint.agentId === input.requiredAgentId));
    const capabilitiesCompatible = input.requiredCapabilities.every((capability) =>
      endpoint.capabilities.includes(capability)
    );
    return {
      id: `remote:${endpoint.endpointId}`,
      source: "remote",
      executorName: input.requiredProfileId ?? endpoint.profileId,
      displayName: endpoint.displayName,
      locationName: endpoint.hostDisplayName,
      capabilities: [...endpoint.capabilities],
      available: endpoint.status === "available" && profileCompatible && capabilitiesCompatible,
      unavailableReason:
        endpoint.status === "unavailable"
          ? (endpoint.unavailableReason ?? "agent_endpoint_unavailable")
          : profileCompatible && capabilitiesCompatible
            ? null
            : "agent_endpoint_incompatible",
      remoteEndpointId: endpoint.endpointId
    };
  });
  return [...local, ...remote];
}

function remoteLogicalExecutor(
  endpoint: RemoteAgentEndpoint,
  logicalExecutors: readonly LogicalAgentEndpointInput[]
): LogicalAgentEndpointInput | null {
  const exactProfile = logicalExecutors.find(
    (executor) => executor.profileId === endpoint.profileId && executor.agentId === endpoint.agentId
  );
  if (exactProfile) return exactProfile;
  return (
    logicalExecutors.find(
      (executor) => !executor.custom && executor.agentId === endpoint.agentId
    ) ?? null
  );
}

/** Build the one user-facing local + remote Endpoint directory for a workspace. */
export function buildAgentEndpointCatalog(input: {
  logicalExecutors: readonly LogicalAgentEndpointInput[];
  remote: readonly RemoteAgentEndpoint[];
}): AvailableAgentEndpoint[] {
  const local = input.logicalExecutors.map(
    (executor): AvailableAgentEndpoint => ({
      id: `local:${executor.executorName}`,
      source: "local",
      executorName: executor.executorName,
      displayName: executor.displayName,
      locationName: "",
      available: executor.available,
      unavailableReason: executor.unavailableReason,
      capabilities: [...executor.capabilities],
      localExecutorName: executor.executorName
    })
  );
  const remote = input.remote.map((endpoint): AvailableAgentEndpoint => {
    const logicalExecutor = remoteLogicalExecutor(endpoint, input.logicalExecutors);
    return {
      id: `remote:${endpoint.endpointId}`,
      source: "remote",
      executorName: logicalExecutor?.executorName ?? endpoint.agentId,
      displayName: endpoint.displayName,
      locationName: endpoint.hostDisplayName,
      available: endpoint.status === "available" && logicalExecutor !== null,
      unavailableReason:
        endpoint.status === "available"
          ? logicalExecutor
            ? null
            : "agent_endpoint_incompatible"
          : (endpoint.unavailableReason ?? "agent_endpoint_unavailable"),
      capabilities: [...endpoint.capabilities],
      remoteEndpointId: endpoint.endpointId
    };
  });
  return [...local, ...remote];
}

export function applyAgentEndpointRequirements(
  endpoints: readonly AvailableAgentEndpoint[],
  requiredCapabilities: readonly string[]
): AvailableAgentEndpoint[] {
  return endpoints.map((endpoint) => {
    const compatible = requiredCapabilities.every((capability) =>
      endpoint.capabilities.includes(capability)
    );
    return compatible
      ? { ...endpoint, capabilities: [...endpoint.capabilities] }
      : {
          ...endpoint,
          capabilities: [...endpoint.capabilities],
          available: false,
          unavailableReason: "agent_endpoint_incompatible"
        };
  });
}

import type { RemoteAgentEndpoint } from "@planweave-ai/collaboration-protocol/agent-endpoint";

export type AvailableAgentEndpoint = {
  id: string;
  source: "local" | "remote";
  displayName: string;
  locationName: string;
  available: boolean;
  unavailableReason: string | null;
  capabilities: string[];
  localExecutorName?: string;
  remoteEndpointId?: string;
};

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
      input.requiredProfileId !== null && endpoint.profileId === input.requiredProfileId;
    const capabilitiesCompatible = input.requiredCapabilities.every((capability) =>
      endpoint.capabilities.includes(capability)
    );
    return {
      id: `remote:${endpoint.endpointId}`,
      source: "remote",
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

import { inheritAgentEndpointValue } from "./AgentEndpointSelect";
import type { AvailableAgentEndpoint } from "./agentEndpointViewModel";

/**
 * Atomic executor selection: write manifest logical executor (package semantics)
 * and desktop endpoint preference (machine location) in one user action.
 */
export async function changeAgentEndpointSelection(input: {
  endpointId: string;
  endpoints: readonly AvailableAgentEndpoint[];
  preferenceKey: string | null;
  allowInherit?: boolean;
  changeLogicalExecutor: (executorName: string | null) => Promise<boolean>;
  savePreference: (key: string, endpoint: AvailableAgentEndpoint | null) => Promise<void>;
  setError: (message: string | null) => void;
}): Promise<void> {
  const {
    endpointId,
    endpoints,
    preferenceKey,
    allowInherit = false,
    changeLogicalExecutor,
    savePreference,
    setError
  } = input;

  if (allowInherit && endpointId === inheritAgentEndpointValue) {
    if (!preferenceKey || !(await changeLogicalExecutor(null))) return;
    await savePreference(preferenceKey, null);
    return;
  }

  const endpoint = endpoints.find((candidate) => candidate.id === endpointId);
  if (!endpoint?.available || !preferenceKey) {
    setError(endpoint?.unavailableReason ?? "agent_endpoint_selection_unavailable");
    return;
  }
  if (!(await changeLogicalExecutor(endpoint.executorName))) return;
  await savePreference(preferenceKey, endpoint);
}

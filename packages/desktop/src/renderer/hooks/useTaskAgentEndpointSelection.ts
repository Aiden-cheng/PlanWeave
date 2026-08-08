import { useCallback } from "react";
import type { DesktopUiSettings } from "../types";
import type { AvailableAgentEndpoint } from "../collaboration/agentEndpointViewModel";
import {
  agentEndpointPreferenceKey,
  agentEndpointSelectionId,
  selectedAgentEndpointId
} from "../collaboration/agentEndpointPreferences";

export function useTaskAgentEndpointSelection(input: {
  agentEndpoints: readonly AvailableAgentEndpoint[];
  canvasId: string | null;
  changeLogicalExecutor: (taskId: string, executorName: string) => Promise<boolean>;
  preferences: DesktopUiSettings["execution"]["agentEndpointPreferences"];
  projectRoot: string | null;
  savePreference: (key: string, endpoint: AvailableAgentEndpoint | null) => Promise<void>;
  setError: (message: string | null) => void;
}) {
  const preferenceKey = useCallback(
    (taskId: string) =>
      input.projectRoot && input.canvasId
        ? agentEndpointPreferenceKey({
            projectRoot: input.projectRoot,
            canvasId: input.canvasId,
            scope: { kind: "task", taskId }
          })
        : null,
    [input.canvasId, input.projectRoot]
  );
  const selectedEndpointId = useCallback(
    (taskId: string, executorName: string) => {
      const key = preferenceKey(taskId);
      return agentEndpointSelectionId(
        selectedAgentEndpointId({
          executorName,
          preference: key ? input.preferences[key] : undefined,
          endpoints: input.agentEndpoints
        })
      );
    },
    [input.agentEndpoints, input.preferences, preferenceKey]
  );
  const changeEndpoint = useCallback(
    async (taskId: string, endpointId: string) => {
      const endpoint = input.agentEndpoints.find((candidate) => candidate.id === endpointId);
      const key = preferenceKey(taskId);
      if (!endpoint?.available || !key) {
        input.setError(endpoint?.unavailableReason ?? "agent_endpoint_selection_unavailable");
        return;
      }
      if (!(await input.changeLogicalExecutor(taskId, endpoint.executorName))) return;
      await input.savePreference(key, endpoint);
    },
    [
      input.agentEndpoints,
      input.changeLogicalExecutor,
      input.savePreference,
      input.setError,
      preferenceKey
    ]
  );

  return { changeEndpoint, selectedEndpointId };
}

import type { DesktopAgentEndpointPreference } from "../../shared/desktopSettings";
import type { AvailableAgentEndpoint } from "./agentEndpointViewModel";

export type AgentEndpointPreferenceScope =
  | { kind: "task"; taskId: string }
  | { kind: "block"; blockRef: string };

export function agentEndpointPreferenceKey(input: {
  projectRoot: string;
  canvasId: string;
  scope: AgentEndpointPreferenceScope;
}): string {
  const scopeId = input.scope.kind === "task" ? input.scope.taskId : input.scope.blockRef;
  return JSON.stringify([input.projectRoot, input.canvasId, input.scope.kind, scopeId]);
}

export function selectedAgentEndpointId(input: {
  executorName: string;
  preference: DesktopAgentEndpointPreference | undefined;
}): string {
  return input.preference?.executorName === input.executorName
    ? `remote:${input.preference.remoteEndpointId}`
    : `local:${input.executorName}`;
}

export function updateAgentEndpointPreferences(input: {
  current: Record<string, DesktopAgentEndpointPreference>;
  key: string;
  endpoint: AvailableAgentEndpoint;
}): Record<string, DesktopAgentEndpointPreference> {
  const next = { ...input.current };
  if (input.endpoint.source === "remote" && input.endpoint.remoteEndpointId) {
    next[input.key] = {
      executorName: input.endpoint.executorName,
      remoteEndpointId: input.endpoint.remoteEndpointId
    };
  } else {
    delete next[input.key];
  }
  return next;
}

export function clearAgentEndpointPreference(
  current: Record<string, DesktopAgentEndpointPreference>,
  key: string
): Record<string, DesktopAgentEndpointPreference> {
  const next = { ...current };
  delete next[key];
  return next;
}

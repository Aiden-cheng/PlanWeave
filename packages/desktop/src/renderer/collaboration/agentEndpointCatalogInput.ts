import type { DesktopExecutorProfileBinding } from "@planweave-ai/runtime";
import {
  builtinExecutorAgentKind,
  executorDisplayName,
  type ExecutorOptionView
} from "../executors/executorOptionViewModel";
import type { LogicalAgentEndpointInput } from "./agentEndpointViewModel";

export function logicalAgentEndpointInputs(input: {
  executorOptions: readonly ExecutorOptionView[];
  profileBindings: readonly DesktopExecutorProfileBinding[];
}): LogicalAgentEndpointInput[] {
  return input.executorOptions.map((option) => {
    const binding = input.profileBindings.find((candidate) => candidate.name === option.name);
    return {
      executorName: option.name,
      profileId: binding?.name ?? option.name,
      agentId: binding?.agentId ?? builtinExecutorAgentKind(option.name),
      displayName: executorDisplayName(option.name),
      capabilities: [...option.capabilities],
      available: !option.disabled,
      unavailableReason: option.disabled ? "agent_endpoint_local_not_detected" : null,
      custom: option.custom
    };
  });
}

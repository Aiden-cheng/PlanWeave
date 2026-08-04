import {
  parseAgentHostSetupHandoff,
  type AgentHostSetupHandoff
} from "@planweave-ai/agent-host-protocol";

const AGENT_HOST_ENROLL_COMMAND_PREFIX = "planweave agent-host enroll ";

export function parseAgentHostHandoffInput(value: string): {
  encodedHandoff: string;
  handoff: AgentHostSetupHandoff;
} {
  const trimmed = value.trim();
  const encodedHandoff = trimmed.startsWith(AGENT_HOST_ENROLL_COMMAND_PREFIX)
    ? trimmed.slice(AGENT_HOST_ENROLL_COMMAND_PREFIX.length).trim()
    : trimmed;
  if (!encodedHandoff || /\s/u.test(encodedHandoff)) {
    throw new Error("local_agent_host_handoff_invalid");
  }
  try {
    return { encodedHandoff, handoff: parseAgentHostSetupHandoff(encodedHandoff) };
  } catch (error) {
    if (error instanceof Error && error.message === "agent_host_setup_handoff_expired") {
      throw new Error("local_agent_host_handoff_expired", { cause: error });
    }
    throw new Error("local_agent_host_handoff_invalid", { cause: error });
  }
}

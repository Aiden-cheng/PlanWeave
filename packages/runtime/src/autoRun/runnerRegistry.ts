import type { AgentCliExecutorProfile, AgentExecutorProfile } from "../types.js";
import { acpRunner } from "./acpRunner.js";
import type { AcpAgentRunner, AgentRunner, CliAgentRunner } from "./agentRunner.js";
import { cliRunner } from "./cliRunner.js";

type AgentAcpExecutorProfile = Extract<AgentExecutorProfile, { runner: { transport: "acp" } }>;

export function resolveAgentRunner(profile: AgentCliExecutorProfile): CliAgentRunner;
export function resolveAgentRunner(profile: AgentAcpExecutorProfile): AcpAgentRunner;
export function resolveAgentRunner(profile: AgentExecutorProfile): AgentRunner;
export function resolveAgentRunner(profile: AgentExecutorProfile): AgentRunner {
  switch (profile.runner.transport) {
    case "cli":
      return cliRunner;
    case "acp":
      return acpRunner;
    default:
      throw new Error(
        `Agent runner transport '${String((profile.runner as { transport?: unknown }).transport)}' is not registered.`
      );
  }
}

export function registeredAgentRunners(): readonly AgentRunner[] {
  return [cliRunner, acpRunner];
}

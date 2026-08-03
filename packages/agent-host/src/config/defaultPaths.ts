import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentHostSetupHandoff } from "@planweave-ai/agent-host-protocol";
import { parseAgentHostConfig, type AgentHostConfig } from "./schema.js";

export type AgentHostDefaultPaths = {
  baseDirectory: string;
  configPath: string;
  dataDirectory: string;
  workspaceRoot: string;
};

export function resolveAgentHostDefaultPaths(
  workspaceId: string,
  homeDirectory: string = homedir()
): AgentHostDefaultPaths {
  const baseDirectory = join(homeDirectory, ".planweave", "agent-host");
  const instanceDirectory = join(baseDirectory, "instances", workspaceId);
  return {
    baseDirectory,
    configPath: join(instanceDirectory, "config.json"),
    dataDirectory: join(instanceDirectory, "data"),
    workspaceRoot: join(baseDirectory, "workspaces")
  };
}

export function configFromAgentHostSetupHandoff(
  handoff: AgentHostSetupHandoff,
  input: {
    paths: AgentHostDefaultPaths;
    workspaceRoot?: string;
    hostDisplayName: string;
    caCertificatePath?: string;
  }
): AgentHostConfig {
  const insecure =
    handoff.endpoint.topology === "loopback_http" || handoff.endpoint.topology === "lan_http";
  return parseAgentHostConfig({
    version: "agent-host-config/v1",
    coordinator: {
      url: handoff.endpoint.serverOrigin,
      allowInsecureDevelopment: insecure,
      endpoint: handoff.endpoint,
      ...(input.caCertificatePath ? { caCertificatePath: input.caCertificatePath } : {})
    },
    dataDirectory: input.paths.dataDirectory,
    workspaceRoot: input.workspaceRoot ?? input.paths.workspaceRoot,
    host: { displayName: input.hostDisplayName, capacity: 1, capabilities: [] },
    workspaces: [{ id: handoff.workspaceId, path: handoff.workspaceId }],
    agentProfiles: []
  });
}

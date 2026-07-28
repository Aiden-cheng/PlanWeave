import type { HostReadinessObservation } from "@planweave-ai/distributed-protocol";
import { ConfiguredAcpProfileResolver, ConfiguredWorkspaceResolver } from "./resolvers.js";
import type { AgentHostConfig } from "./schema.js";

function observationStatus(error: unknown): "missing" | "invalid" {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    return "missing";
  }
  if (
    error instanceof Error &&
    (error.message === "agent_host_workspace_not_configured" ||
      error.message === "agent_host_profile_not_configured")
  ) {
    return "missing";
  }
  return "invalid";
}

/**
 * Resolves target-machine configuration without exposing paths, commands, or
 * environment names through the Host protocol.
 */
export async function observeHostReadiness(
  config: AgentHostConfig,
  environment: Readonly<Record<string, string | undefined>> = process.env
): Promise<HostReadinessObservation> {
  const workspaces = new ConfiguredWorkspaceResolver(config);
  const profiles = new ConfiguredAcpProfileResolver(config, environment);
  const workspaceMappings = await Promise.all(
    config.workspaces.map(async (workspace) => {
      try {
        await workspaces.resolve(workspace.id);
        return { workspaceId: workspace.id, status: "ready" as const };
      } catch (error) {
        return { workspaceId: workspace.id, status: observationStatus(error) };
      }
    })
  );
  const acpProfiles = await Promise.all(
    config.agentProfiles.map(async (profile) => {
      try {
        await profiles.resolve(profile.id, profile.agentId);
        return {
          profileId: profile.id,
          agentId: profile.agentId,
          status: "ready" as const,
          capabilities: [`acp.${profile.agentId}`]
        };
      } catch (error) {
        return {
          profileId: profile.id,
          agentId: profile.agentId,
          status: observationStatus(error),
          capabilities: [`acp.${profile.agentId}`]
        };
      }
    })
  );
  return { workspaceMappings, acpProfiles };
}

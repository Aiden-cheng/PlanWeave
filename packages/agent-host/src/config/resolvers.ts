import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  AgentHostAcpProfileResolver,
  AgentHostWorkspaceResolver,
  ResolvedAgentHostAcpProfile,
  ResolvedAgentHostWorkspace
} from "../execution/remoteAcpPorts.js";
import type { AgentHostConfig } from "./schema.js";

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export class ConfiguredWorkspaceResolver implements AgentHostWorkspaceResolver {
  constructor(private readonly config: AgentHostConfig) {}

  async resolve(workspaceId: string): Promise<ResolvedAgentHostWorkspace> {
    const mapping = this.config.workspaces.find((workspace) => workspace.id === workspaceId);
    if (!mapping) throw new Error("agent_host_workspace_not_configured");
    const root = await realpath(this.config.workspaceRoot);
    const cwd = await realpath(resolve(root, mapping.path));
    if (!contained(root, cwd)) throw new Error("agent_host_workspace_escape");
    return { cwd };
  }
}

export class ConfiguredAcpProfileResolver implements AgentHostAcpProfileResolver {
  constructor(
    private readonly config: AgentHostConfig,
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
    private readonly isProfileExposed?: (agentProfileId: string) => Promise<boolean>
  ) {}

  async resolve(agentProfileId: string, agentId: string): Promise<ResolvedAgentHostAcpProfile> {
    const profile = this.config.agentProfiles.find((candidate) => candidate.id === agentProfileId);
    if (!profile || profile.agentId !== agentId)
      throw new Error("agent_host_profile_not_configured");
    if (this.isProfileExposed && !(await this.isProfileExposed(agentProfileId))) {
      throw new Error("agent_host_profile_not_exposed");
    }
    const command = await realpath(profile.command);
    await access(command, constants.X_OK);
    const env: Record<string, string> = {};
    for (const entry of profile.environment) {
      const value = this.environment[entry.name];
      if (value === undefined) {
        if (entry.required) throw new Error(`agent_host_profile_environment_missing:${entry.name}`);
      } else env[entry.name] = value;
    }
    return {
      agentId: profile.agentId,
      launch: { command, args: profile.args },
      env,
      session: profile.session
        ? {
            modes: Object.fromEntries(profile.session.modes.map((mode) => [mode.id, mode.modeId])),
            configOptions: Object.fromEntries(
              profile.session.configOptions.map((option) => [
                option.id,
                {
                  configId: option.configId,
                  values: Object.fromEntries(option.values.map((value) => [value.id, value.value]))
                }
              ])
            )
          }
        : undefined
    };
  }
}

import {
  AgentHostOperator,
  listSupportedHostAcpProfiles,
  resolveAgentHostDefaultPaths,
  supportsPlatformBackgroundService,
  type AgentExposureMutationResult,
  type AgentHostBackgroundLauncher,
  type AgentHostBackgroundResult,
  type PortableEnrollmentResult
} from "@planweave-ai/agent-host";
import {
  operatorLocalAgentHostStatusSchema,
  type OperatorLocalAgentHostStatus
} from "../../shared/operatorControl.js";
import { LocalAgentHostRegistrationStore } from "./localAgentHostRegistrationStore.js";

export interface LocalAgentHostOperatorPort {
  enrollHandoff(
    handoff: string,
    options: {
      installBackground: boolean;
      executablePath: string;
      fixedArgs: readonly string[];
    }
  ): Promise<PortableEnrollmentResult>;
  reconcileAgentExposure(
    configPath: string,
    profileIds: readonly string[]
  ): Promise<AgentExposureMutationResult>;
  listAgents(configPath: string): Promise<PortableEnrollmentResult["agents"]>;
  backgroundStatus(configPath: string): Promise<AgentHostBackgroundResult>;
}

export interface LocalAgentHostProvisioner {
  status(profileId?: string): Promise<OperatorLocalAgentHostStatus>;
  register(
    profileId: string | undefined,
    handoff: string,
    exposedProfileIds: readonly string[]
  ): Promise<OperatorLocalAgentHostStatus>;
}

export type LocalAgentHostProvisionerOptions = {
  platform?: NodeJS.Platform;
  launcher: AgentHostBackgroundLauncher;
  operator?: LocalAgentHostOperatorPort;
  registrations?: LocalAgentHostRegistrationStore;
};

function supportedProfiles() {
  return listSupportedHostAcpProfiles().map((profile) => ({
    profileId: profile.profileId,
    agentId: profile.agentId,
    displayName: profile.displayName,
    detected: false,
    exposed: false,
    ready: false
  }));
}

export class DesktopLocalAgentHostProvisioner implements LocalAgentHostProvisioner {
  private readonly platform: NodeJS.Platform;
  private readonly launcher: AgentHostBackgroundLauncher;
  private readonly operator: LocalAgentHostOperatorPort;
  private readonly registrations: LocalAgentHostRegistrationStore;

  constructor(options: LocalAgentHostProvisionerOptions) {
    this.platform = options.platform ?? process.platform;
    this.launcher = options.launcher;
    this.operator = options.operator ?? new AgentHostOperator();
    this.registrations = options.registrations ?? new LocalAgentHostRegistrationStore();
  }

  async status(profileId?: string): Promise<OperatorLocalAgentHostStatus> {
    if (!supportsPlatformBackgroundService(this.platform)) {
      return operatorLocalAgentHostStatusSchema.parse({
        supported: false,
        state: "not_registered",
        agents: supportedProfiles()
      });
    }
    const registration =
      (profileId ? await this.registrations.get(profileId) : null) ??
      (await this.registrations.latest());
    if (!registration) {
      return operatorLocalAgentHostStatusSchema.parse({
        supported: true,
        state: "not_registered",
        agents: supportedProfiles()
      });
    }
    const configPath = resolveAgentHostDefaultPaths(registration.workspaceId).configPath;
    const [agents, background] = await Promise.all([
      this.operator.listAgents(configPath),
      this.operator.backgroundStatus(configPath)
    ]);
    return operatorLocalAgentHostStatusSchema.parse({
      supported: true,
      state: background.state === "running" ? "ready" : "background_setup_required",
      workspaceId: registration.workspaceId,
      background: background.state,
      agents
    });
  }

  async register(
    profileId: string | undefined,
    handoff: string,
    exposedProfileIds: readonly string[]
  ): Promise<OperatorLocalAgentHostStatus> {
    if (!supportsPlatformBackgroundService(this.platform)) {
      throw new Error("local_agent_host_unavailable");
    }
    const enrollment = await this.operator.enrollHandoff(handoff, {
      installBackground: true,
      executablePath: this.launcher.executablePath,
      fixedArgs: [...(this.launcher.fixedArgs ?? [])]
    });
    await this.registrations.upsert(profileId ?? enrollment.workspaceId, enrollment.workspaceId);
    const agents = (
      await this.operator.reconcileAgentExposure(enrollment.configPath, exposedProfileIds)
    ).agents;
    return operatorLocalAgentHostStatusSchema.parse({
      supported: true,
      state: enrollment.background === "running" ? "ready" : "background_setup_required",
      workspaceId: enrollment.workspaceId,
      background: enrollment.background,
      agents
    });
  }
}

export function unavailableLocalAgentHostProvisioner(): LocalAgentHostProvisioner {
  return {
    status: async () =>
      operatorLocalAgentHostStatusSchema.parse({
        supported: false,
        state: "not_registered",
        agents: supportedProfiles()
      }),
    register: async () => {
      throw new Error("local_agent_host_unavailable");
    }
  };
}

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
  installBackground(
    configPath: string,
    launcher: AgentHostBackgroundLauncher
  ): Promise<AgentHostBackgroundResult>;
  backgroundStatus(configPath: string): Promise<AgentHostBackgroundResult>;
}

export interface LocalAgentHostProvisioner {
  status(profileId?: string): Promise<OperatorLocalAgentHostStatus>;
  repair(profileId?: string): Promise<OperatorLocalAgentHostStatus>;
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

const agentHostErrorCodePattern = /^(?:agent_host|local_agent_host)_[a-z0-9_]+$/;

function systemErrorSuffix(error: unknown): string | null {
  let candidate = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!candidate || typeof candidate !== "object") return null;
    if ("code" in candidate) {
      if (typeof candidate.code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(candidate.code)) {
        return candidate.code.toLowerCase();
      }
      if (
        typeof candidate.code === "number" &&
        Number.isSafeInteger(candidate.code) &&
        candidate.code >= 0 &&
        candidate.code <= 65_535
      ) {
        return `exit_${candidate.code}`;
      }
    }
    candidate = "cause" in candidate ? candidate.cause : null;
  }
  return null;
}

function localAgentHostStageError(stageCode: string, error: unknown): Error {
  if (error instanceof Error && agentHostErrorCodePattern.test(error.message)) return error;
  const suffix = systemErrorSuffix(error);
  return new Error(suffix ? `${stageCode}_${suffix}` : stageCode, { cause: error });
}

async function withinLocalAgentHostStage<T>(
  stageCode: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw localAgentHostStageError(stageCode, error);
  }
}

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
    let agents: PortableEnrollmentResult["agents"];
    try {
      agents = await this.operator.listAgents(configPath);
    } catch (error) {
      if (systemErrorSuffix(error) === "enoent") {
        return operatorLocalAgentHostStatusSchema.parse({
          supported: true,
          state: "not_registered",
          agents: supportedProfiles()
        });
      }
      throw localAgentHostStageError("local_agent_host_agent_status_read_failed", error);
    }
    const background = await withinLocalAgentHostStage(
      "local_agent_host_background_status_read_failed",
      () => this.operator.backgroundStatus(configPath)
    );
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
    const enrollment = await withinLocalAgentHostStage("local_agent_host_enrollment_failed", () =>
      this.operator.enrollHandoff(handoff, {
        installBackground: false,
        executablePath: this.launcher.executablePath,
        fixedArgs: [...(this.launcher.fixedArgs ?? [])]
      })
    );
    await withinLocalAgentHostStage("local_agent_host_registration_store_failed", () =>
      this.registrations.upsert(profileId ?? enrollment.workspaceId, enrollment.workspaceId)
    );
    const agents = (
      await withinLocalAgentHostStage("local_agent_host_agent_exposure_failed", () =>
        this.operator.reconcileAgentExposure(enrollment.configPath, exposedProfileIds)
      )
    ).agents;
    const background = await withinLocalAgentHostStage(
      "local_agent_host_background_install_failed",
      () => this.operator.installBackground(enrollment.configPath, this.launcher)
    );
    return operatorLocalAgentHostStatusSchema.parse({
      supported: true,
      state: background.state === "running" ? "ready" : "background_setup_required",
      workspaceId: enrollment.workspaceId,
      background: background.state,
      agents
    });
  }

  async repair(profileId?: string): Promise<OperatorLocalAgentHostStatus> {
    const registration =
      (profileId ? await this.registrations.get(profileId) : null) ??
      (await this.registrations.latest());
    if (!registration) throw new Error("local_agent_host_registration_missing");
    const configPath = resolveAgentHostDefaultPaths(registration.workspaceId).configPath;
    const background = await withinLocalAgentHostStage(
      "local_agent_host_background_install_failed",
      () => this.operator.installBackground(configPath, this.launcher)
    );
    const agents = await withinLocalAgentHostStage(
      "local_agent_host_agent_status_read_failed",
      () => this.operator.listAgents(configPath)
    );
    return operatorLocalAgentHostStatusSchema.parse({
      supported: true,
      state: background.state === "running" ? "ready" : "background_setup_required",
      workspaceId: registration.workspaceId,
      background: background.state,
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
    },
    repair: async () => {
      throw new Error("local_agent_host_unavailable");
    }
  };
}

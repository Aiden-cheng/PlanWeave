import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseAgentHostConfig, type AgentHostConfig } from "../config/schema.js";
import { ConfiguredAcpProfileResolver, ConfiguredWorkspaceResolver } from "../config/resolvers.js";
import {
  composeAgentHost,
  type AgentHostComposition
} from "../composition/agentHostComposition.js";
import { FileHostCredentialStore } from "../credentials/fileCredentialStore.js";
import { AgentHostEnrollmentService } from "../enrollment/enrollmentService.js";
import { HttpAgentHostEnrollmentExchange } from "../enrollment/httpEnrollmentExchange.js";
import { RemoteAcpExecutor } from "../execution/remoteAcpExecutor.js";
import { DurableAcpInteractionRelay } from "../execution/durableAcpRelay.js";
import { openAgentHostState } from "../state/agentHostState.js";
import {
  assertDurableStateReplacementSafe,
  ensureDurableHostIdentity
} from "../state/durableHostIdentity.js";
import { AgentHostClient } from "../transport/agentHostClient.js";

const MAX_CONFIG_BYTES = 256 * 1_024;

export type AgentHostDiagnostics = {
  version: "0.3.0";
  hostId?: string;
  credential: "missing" | "pending" | "active" | "revoked" | "expired";
  capabilities: string[];
  capacity: number;
  connection: "offline";
  recoverableExecutions: number;
  actionableError?: string;
};

export async function loadAgentHostConfig(path: string): Promise<AgentHostConfig> {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_CONFIG_BYTES) throw new Error("agent_host_config_too_large");
  try {
    return parseAgentHostConfig(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new Error("agent_host_config_invalid", { cause: error });
  }
}

function credentialStore(config: AgentHostConfig): FileHostCredentialStore {
  return new FileHostCredentialStore(join(config.dataDirectory, "credentials.json"));
}

function transportOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  return url.origin;
}

export class AgentHostOperator {
  async preflight(configPath: string): Promise<AgentHostDiagnostics> {
    const config = await loadAgentHostConfig(configPath);
    await realpath(config.workspaceRoot);
    await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
    await credentialStore(config).read();
    const workspaces = new ConfiguredWorkspaceResolver(config);
    const profiles = new ConfiguredAcpProfileResolver(config);
    await Promise.all([
      ...config.workspaces.map((workspace) => workspaces.resolve(workspace.id)),
      ...config.agentProfiles.map((profile) => profiles.resolve(profile.id, profile.agentId))
    ]);
    return this.diagnostics(config);
  }

  async enroll(
    configPath: string,
    code: string,
    replaceExisting = false
  ): Promise<AgentHostDiagnostics> {
    const config = await loadAgentHostConfig(configPath);
    await this.preflight(configPath);
    const store = credentialStore(config);
    const credentialDocument = await store.read();
    if (replaceExisting || !credentialDocument?.active) {
      await assertDurableStateReplacementSafe(config.dataDirectory);
    }
    const service = new AgentHostEnrollmentService(
      config,
      store,
      new HttpAgentHostEnrollmentExchange(config.coordinator.url, {
        allowInsecureDevelopment: config.coordinator.allowInsecureDevelopment
      })
    );
    await service.enroll(code, { replaceExisting });
    return this.diagnostics(config);
  }

  async revoke(configPath: string): Promise<AgentHostDiagnostics> {
    const config = await loadAgentHostConfig(configPath);
    await credentialStore(config).markRevoked();
    return this.diagnostics(config);
  }

  async status(configPath: string): Promise<AgentHostDiagnostics> {
    return this.diagnostics(await loadAgentHostConfig(configPath));
  }

  async createDaemon(configPath: string): Promise<AgentHostComposition> {
    const config = await loadAgentHostConfig(configPath);
    await this.preflight(configPath);
    const credential = await credentialStore(config).requireUsable();
    await ensureDurableHostIdentity(config.dataDirectory, credential.hostId);
    const state = await openAgentHostState(join(config.dataDirectory, "state.sqlite"));
    state.recoverableExecutionCount();
    await state.importLegacyRemoteExecutionStore(
      join(config.dataDirectory, "remote-execution.sqlite")
    );
    const interactionRelay = new DurableAcpInteractionRelay(state);
    const executor = new RemoteAcpExecutor({
      workspaceResolver: new ConfiguredWorkspaceResolver(config),
      profileResolver: new ConfiguredAcpProfileResolver(config),
      outbox: state,
      interactionResponder: interactionRelay,
      hostCapabilities: config.host.capabilities
    });
    const transport = new AgentHostClient({
      serverUrl: transportOrigin(config.coordinator.url),
      hostId: credential.hostId,
      token: credential.credentialToken,
      capabilities: config.host.capabilities,
      capacity: config.host.capacity,
      state,
      executor,
      interactionRelay,
      allowInsecureTransport: config.coordinator.allowInsecureDevelopment
    });
    const composition = composeAgentHost({ state, transport });
    return {
      subscribeStatus: (listener) => composition.subscribeStatus(listener),
      start: () => composition.start(),
      shutdown: () => composition.shutdown()
    };
  }

  private async diagnostics(config: AgentHostConfig): Promise<AgentHostDiagnostics> {
    let credential: AgentHostDiagnostics["credential"] = "missing";
    let hostId: string | undefined;
    let actionableError: string | undefined;
    try {
      const document = await credentialStore(config).read();
      if (document?.pending) credential = "pending";
      if (document?.active) {
        hostId = document.active.hostId;
        credential = document.active.revokedAt
          ? "revoked"
          : Date.parse(document.active.expiresAt) <= Date.now()
            ? "expired"
            : "active";
      }
    } catch {
      actionableError = "credential_store_invalid";
    }
    let recoverableExecutions = 0;
    const statePath = join(config.dataDirectory, "state.sqlite");
    try {
      if ((await stat(statePath)).isFile()) {
        const state = await openAgentHostState(statePath);
        try {
          recoverableExecutions = state.recoverableExecutionCount();
        } finally {
          state.close();
        }
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        actionableError ??= "execution_state_invalid";
      }
    }
    return {
      version: "0.3.0",
      hostId,
      credential,
      capabilities: [...config.host.capabilities],
      capacity: config.host.capacity,
      connection: "offline",
      recoverableExecutions,
      actionableError
    };
  }
}

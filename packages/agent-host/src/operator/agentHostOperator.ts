import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { parseAgentHostConfig, type AgentHostConfig } from "../config/schema.js";
import { observeHostReadiness } from "../config/readiness.js";
import { ConfiguredAcpProfileResolver, ConfiguredWorkspaceResolver } from "../config/resolvers.js";
import {
  composeAgentHost,
  type AgentHostComposition
} from "../composition/agentHostComposition.js";
import { FileHostCredentialStore } from "../credentials/fileCredentialStore.js";
import { AgentHostEnrollmentService } from "../enrollment/enrollmentService.js";
import { HttpAgentHostEnrollmentExchange } from "../enrollment/httpEnrollmentExchange.js";
import { HttpAgentHostSetupCodeRedeem } from "../enrollment/httpSetupCodeRedeem.js";
import { RemoteAcpExecutor } from "../execution/remoteAcpExecutor.js";
import { DurableAcpInteractionRelay } from "../execution/durableAcpRelay.js";
import { openAgentHostState } from "../state/agentHostState.js";
import {
  assertDurableStateReplacementSafe,
  ensureDurableHostIdentity
} from "../state/durableHostIdentity.js";
import { AgentHostClient } from "../transport/agentHostClient.js";
import { agentHostPackageVersion } from "../packageInfo.js";
import { createAgentHostTlsTrust } from "../tls/trust.js";
import { findSupportedHostAcpProfile } from "../realAcp/supportedProfiles.js";

const MAX_CONFIG_BYTES = 256 * 1_024;

export type AgentHostDiagnostics = {
  version: typeof agentHostPackageVersion;
  hostId?: string;
  workspaceId?: string;
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

async function resolvePresetCommand(command: string, pathEnv: string | undefined): Promise<string> {
  const candidates = isAbsolute(command)
    ? [command]
    : (pathEnv ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      await access(resolved, constants.X_OK);
      return resolved;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === "EACCES")
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("agent_host_preset_binary_missing");
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
  async initializePreset(configPath: string, presetId: string): Promise<AgentHostConfig> {
    if (presetId !== "codex-acp") throw new Error("agent_host_preset_unsupported");
    const config = await loadAgentHostConfig(configPath);
    const preset = findSupportedHostAcpProfile(presetId);
    if (!preset) throw new Error("agent_host_preset_unsupported");
    const command = await resolvePresetCommand(preset.command, process.env.PATH);
    const profile = {
      id: preset.profileId,
      agentId: preset.agentId,
      command,
      args: [...preset.args],
      environment: [...preset.environment]
    };
    const existing = config.agentProfiles.find((candidate) => candidate.id === profile.id);
    if (
      existing &&
      (existing.agentId !== profile.agentId || existing.command !== profile.command)
    ) {
      throw new Error("agent_host_preset_profile_conflict");
    }
    const next = parseAgentHostConfig({
      ...config,
      host: {
        ...config.host,
        capabilities: [...new Set([...config.host.capabilities, `acp.${preset.agentId}`])]
      },
      agentProfiles: existing ? config.agentProfiles : [...config.agentProfiles, profile]
    });
    const temporaryPath = `${configPath}.preset-${process.pid}-${Date.now()}`;
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, configPath);
    return next;
  }

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
    const trust = await createAgentHostTlsTrust(config.coordinator.caCertificatePath);
    await trust.close();
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
    const trust = await createAgentHostTlsTrust(config.coordinator.caCertificatePath);
    try {
      const exchangeOptions = {
        allowInsecureDevelopment: config.coordinator.allowInsecureDevelopment,
        request: trust.request
      };
      const service = new AgentHostEnrollmentService(
        config,
        store,
        new HttpAgentHostEnrollmentExchange(config.coordinator.url, exchangeOptions),
        () => new Date(),
        new HttpAgentHostSetupCodeRedeem(config.coordinator.url, exchangeOptions)
      );
      await service.enroll(code, { replaceExisting });
    } finally {
      await trust.close();
    }
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
    await realpath(config.workspaceRoot);
    await mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
    await credentialStore(config).read();
    const credential = await credentialStore(config).requireUsable();
    const readiness = await observeHostReadiness(config);
    await ensureDurableHostIdentity(
      config.dataDirectory,
      credential.hostId,
      credential.workspaceId
    );
    const trust = await createAgentHostTlsTrust(config.coordinator.caCertificatePath);
    let state: Awaited<ReturnType<typeof openAgentHostState>> | undefined;
    try {
      state = await openAgentHostState(join(config.dataDirectory, "state.sqlite"));
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
        workspaceId: credential.workspaceId,
        token: credential.credentialToken,
        capabilities: config.host.capabilities,
        capacity: config.host.capacity,
        readiness,
        state,
        executor,
        interactionRelay,
        allowInsecureTransport: config.coordinator.allowInsecureDevelopment,
        ca: trust.ca,
        request: trust.request
      });
      return composeAgentHost({ state, transport, closeResources: trust.close });
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        state?.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        await trust.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "agent_host_daemon_startup_cleanup_failed",
          {
            cause: error
          }
        );
      }
      throw error;
    }
  }

  private async diagnostics(config: AgentHostConfig): Promise<AgentHostDiagnostics> {
    let credential: AgentHostDiagnostics["credential"] = "missing";
    let hostId: string | undefined;
    let workspaceId: string | undefined;
    let actionableError: string | undefined;
    try {
      const document = await credentialStore(config).read();
      if (document?.pending) credential = "pending";
      if (document?.active) {
        hostId = document.active.hostId;
        workspaceId = document.active.workspaceId;
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
      version: agentHostPackageVersion,
      hostId,
      workspaceId,
      credential,
      capabilities: [...config.host.capabilities],
      capacity: config.host.capacity,
      connection: "offline",
      recoverableExecutions,
      actionableError
    };
  }
}

import {
  isLoopbackHostname,
  loopbackProjectRegistrationRequestSchema,
  loopbackProjectRegistrationViewSchema,
  loopbackServerLifecycleRequestSchema,
  loopbackServerStatusSchema,
  loopbackTrustedProjectListRequestSchema,
  loopbackTrustedProjectScopeSchema,
  type LoopbackProjectRegistrationRequest,
  type LoopbackProjectRegistrationView,
  type LoopbackServerLifecycleRequest,
  type LoopbackServerProfile,
  type LoopbackServerStatus,
  type LoopbackTrustedProjectScope
} from "@planweave-ai/collaboration-contracts";
import type { ActorRef } from "@planweave-ai/collaboration-contracts";
import { serverConfigSchema, type ServerConfig } from "./config.js";
import type { DistributedServerProcess } from "./serverServe.js";
import { serveDistributedServer } from "./serverServe.js";

export type LoopbackServerControllerOptions = {
  /** Desktop main supplies a fixed, local configuration factory; renderer never supplies config or paths. */
  createConfig(profile: LoopbackServerProfile): ServerConfig;
  serve?(config: ServerConfig): Promise<DistributedServerProcess>;
  clock?: () => Date;
};

/**
 * Main-process-only lifecycle wrapper. It has no HTTP route and accepts no command,
 * filesystem, secret, or arbitrary network authority from callers.
 */
export class LoopbackServerController {
  private process: DistributedServerProcess | undefined;
  private profile: LoopbackServerProfile | undefined;
  private startedAt: string | null = null;
  private state: LoopbackServerStatus["state"] = "stopped";
  private reason: LoopbackServerStatus["reason"] = null;

  constructor(private readonly options: LoopbackServerControllerOptions) {}

  listTrustedProjectScopes(rawRequest: unknown): readonly LoopbackTrustedProjectScope[] {
    const request = loopbackTrustedProjectListRequestSchema.parse(rawRequest);
    return this.processForProfile(request.profileId).trustedProjectControl.listTrustedProjectScopes();
  }

  resolveTrustedProjectScope(rawRequest: unknown): LoopbackTrustedProjectScope {
    const request = loopbackProjectRegistrationRequestSchema.parse(rawRequest);
    const scope = this.processForProfile(request.profileId).trustedProjectControl.resolveTrustedProjectScope(
      scopeFromRegistration(request)
    );
    if (!scope) throw new Error("loopback_registration_not_trusted");
    return scope;
  }

  registerTrustedProject(
    actor: ActorRef,
    rawRequest: unknown
  ): LoopbackProjectRegistrationView {
    const request = loopbackProjectRegistrationRequestSchema.parse(rawRequest);
    const scope = this.processForProfile(request.profileId).trustedProjectControl.assertTrustedProjectAdministration(
      actor,
      scopeFromRegistration(request)
    );
    return loopbackProjectRegistrationViewSchema.parse({
      ...scope,
      profileId: request.profileId,
      registeredAt: (this.options.clock ?? (() => new Date()))().toISOString()
    });
  }

  status(): LoopbackServerStatus {
    return loopbackServerStatusSchema.parse({
      profile: this.profile ?? null,
      state: this.state,
      startedAt: this.startedAt,
      reason: this.reason
    });
  }

  async apply(rawRequest: unknown): Promise<LoopbackServerStatus> {
    const request = loopbackServerLifecycleRequestSchema.parse(rawRequest);
    return request.action === "start" ? this.start(request) : this.stop(request);
  }

  private assertFixedLoopbackConfig(profile: LoopbackServerProfile): ServerConfig {
    const config = serverConfigSchema.parse(this.options.createConfig(profile));
    const profileUrl = new URL(profile.serverBaseUrl);
    const configUrl = new URL(config.publicUrl);
    if (
      !isLoopbackHostname(config.bind.host) ||
      !isLoopbackHostname(configUrl.hostname) ||
      config.bind.port !== Number(profileUrl.port || (profileUrl.protocol === "https:" ? 443 : 80)) ||
      configUrl.origin !== profileUrl.origin
    ) {
      throw new Error("loopback_profile_configuration_mismatch");
    }
    return config;
  }

  private processForProfile(profileId: string): DistributedServerProcess {
    if (!this.process) throw new Error("loopback_server_not_running");
    if (this.profile?.profileId !== profileId) throw new Error("loopback_profile_mismatch");
    return this.process;
  }

  private async start(request: Extract<LoopbackServerLifecycleRequest, { action: "start" }>): Promise<LoopbackServerStatus> {
    if (this.process) {
      if (this.profile?.profileId !== request.profile.profileId) throw new Error("loopback_profile_already_running");
      return this.status();
    }
    this.profile = request.profile;
    this.state = "starting";
    this.reason = null;
    try {
      const serve = this.options.serve ?? serveDistributedServer;
      this.process = await serve(this.assertFixedLoopbackConfig(request.profile));
      this.startedAt = (this.options.clock ?? (() => new Date()))().toISOString();
      this.state = "running";
      return this.status();
    } catch {
      this.process = undefined;
      this.startedAt = null;
      this.state = "error";
      this.reason = "start_failed";
      return this.status();
    }
  }

  private async stop(request: Extract<LoopbackServerLifecycleRequest, { action: "stop" }>): Promise<LoopbackServerStatus> {
    if (!this.process) return this.status();
    if (this.profile?.profileId !== request.profileId) throw new Error("loopback_profile_mismatch");
    this.state = "stopping";
    try {
      await this.process.close();
      this.process = undefined;
      this.profile = undefined;
      this.startedAt = null;
      this.state = "stopped";
      this.reason = null;
      return this.status();
    } catch {
      this.state = "error";
      this.reason = "stop_failed";
      return this.status();
    }
  }
}

function scopeFromRegistration(
  request: LoopbackProjectRegistrationRequest
): LoopbackTrustedProjectScope {
  return loopbackTrustedProjectScopeSchema.parse({
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    canvasId: request.canvasId
  });
}

export type { LoopbackProjectRegistrationRequest };

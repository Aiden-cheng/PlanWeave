import {
  hashOperatorToken,
  LoopbackServerController,
  parseServerConfig,
  type ServerConfig
} from "@planweave-ai/server";
import {
  loopbackProjectRegistrationViewSchema,
  loopbackServerProfileSchema,
  type LoopbackServerProfile,
  type LoopbackTrustedProjectScope,
  type LoopbackProjectRegistrationView
} from "@planweave-ai/collaboration-protocol/loopback";
import { type DeploymentTargetDraft } from "@planweave-ai/collaboration-protocol/deployment";
import { listProjects, resolveTaskCanvasWorkspace } from "@planweave-ai/runtime";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { OperatorSafeStoragePort } from "../operatorControl/operatorCredentialVault.js";
import { OperatorCredentialVault } from "../operatorControl/operatorCredentialVault.js";
import { getOperatorControlService } from "../operatorControl/operatorControlHandlers.js";
import { desktopHomePaths } from "../planweaveHomePaths.js";
import {
  collaborationCurrentSelectionInputSchema,
  localCollaborationLanSharingInputSchema,
  localCollaborationServerStatusSchema,
  localCollaborationScopeSelectionInputSchema,
  type LocalCollaborationScopeCatalog,
  type LocalCollaborationServerStatus
} from "../../shared/collaboration.js";
import { DeploymentBundleUnavailableError } from "./deploymentActions.js";
import {
  LocalCollaborationScopeStore,
  type LocalCollaborationScopeStorePort
} from "./LocalCollaborationScopeStore.js";
import {
  LocalCollaborationNetworkStore,
  type LocalCollaborationNetworkStorePort
} from "./LocalCollaborationNetworkStore.js";
import { resolveLocalCollaborationLanAddress } from "./localNetworkAddress.js";

type ResolvedSelection = {
  desktopProjectId: string;
  authorityProjectId: string;
  canvasId: string;
  projectRoot: string;
};

type ProjectCatalogPort = {
  listProjects: typeof listProjects;
  resolveAuthorityProjectId(projectRoot: string, canvasId: string): Promise<string>;
};

type LoopbackServerControlPort = Pick<
  LoopbackServerController,
  "status" | "apply" | "listTrustedProjectScopes" | "registerTrustedProject"
>;

const localOperatorCredentialKey = "planweave-local-loopback";
const localServerProfileId = "planweave-local-server";
const localStartAttempts = 3;

function localWorkspaceIdForProject(projectId: string): string {
  return `workspace-local-${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}`;
}

function localProfileIdForProject(projectId: string): string {
  return `planweave-local-${createHash("sha256").update(projectId).digest("hex").slice(0, 24)}`;
}

async function allocateLocalPort(host: string, preferredPort: number | null): Promise<number> {
  const listener = createServer();
  return new Promise<number>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(preferredPort ?? 0, host, () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close(() => reject(new Error("local_collaboration_port_allocation_failed")));
        return;
      }
      listener.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

/** Main-only coordination seam: local process today, replaceable remote adapter later. */
export interface CollaborationCoordinatorControl {
  setCurrentSelection(input: unknown): Promise<void>;
  clearCurrentSelection(): Promise<void>;
  currentSelection(): { projectId: string; canvasId: string } | null;
  restore(): Promise<LocalCollaborationServerStatus>;
  status(): LocalCollaborationServerStatus;
  start(): Promise<LocalCollaborationServerStatus>;
  stop(): Promise<LocalCollaborationServerStatus>;
  setLanSharing(input: unknown): Promise<LocalCollaborationServerStatus>;
  getScopeCatalog(): Promise<LocalCollaborationScopeCatalog>;
  setTrustedScopes(input: unknown): Promise<LocalCollaborationScopeCatalog>;
  currentSelectionIsTrusted(): boolean;
  ownsLocalProfile(profileId: string): boolean;
  listActiveTrustedScopes(): readonly LoopbackTrustedProjectScope[];
  registerCurrentProject(actor: { kind: "human"; id: string }): LoopbackProjectRegistrationView;
  localProfile(): {
    profileId: string;
    displayName: string;
    serverBaseUrl: string;
    projectId: string;
    allowInsecureTransport: boolean;
  } | null;
  createSelfHostedDeploymentSource(target: DeploymentTargetDraft): Promise<{
    config: ServerConfig;
    workspaceRoot: string;
    projectId: string;
  }>;
}

export class LocalCollaborationCoordinatorControl implements CollaborationCoordinatorControl {
  private selection: ResolvedSelection | null = null;
  private controller: LoopbackServerControlPort | null = null;
  private localPort: number | null = null;
  private preferredPort: number | null = null;
  private lanSharingEnabled = false;
  private lanAddress: string | null = null;
  private operatorToken: string | null = null;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private readonly vault: OperatorCredentialVault;
  private readonly scopeStore: LocalCollaborationScopeStorePort;
  private readonly networkStore: LocalCollaborationNetworkStorePort;

  private readonly projects: ProjectCatalogPort;
  private readonly createController: (
    createConfig: (profile: LoopbackServerProfile) => ServerConfig
  ) => LoopbackServerControlPort;
  private readonly allocatePort: (host: string, preferredPort: number | null) => Promise<number>;
  private readonly resolveLanAddress: () => string | null;

  constructor(options: {
    safeStorage: OperatorSafeStoragePort;
    projects?: ProjectCatalogPort;
    createController?: (
      createConfig: (profile: LoopbackServerProfile) => ServerConfig
    ) => LoopbackServerControlPort;
    allocatePort?: (host: string, preferredPort: number | null) => Promise<number>;
    scopeStore?: LocalCollaborationScopeStorePort;
    networkStore?: LocalCollaborationNetworkStorePort;
    resolveLanAddress?: () => string | null;
  }) {
    this.vault = new OperatorCredentialVault({ safeStorage: options.safeStorage });
    this.projects = options.projects ?? {
      listProjects,
      resolveAuthorityProjectId: async (projectRoot, canvasId) => {
        return (await resolveTaskCanvasWorkspace(projectRoot, canvasId)).id;
      }
    };
    this.createController =
      options.createController ??
      ((createConfig) => new LoopbackServerController({ createConfig }));
    this.allocatePort = options.allocatePort ?? allocateLocalPort;
    this.scopeStore = options.scopeStore ?? new LocalCollaborationScopeStore();
    this.networkStore = options.networkStore ?? new LocalCollaborationNetworkStore();
    this.resolveLanAddress = options.resolveLanAddress ?? resolveLocalCollaborationLanAddress;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.catch(() => undefined).then(operation);
    this.operationQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  setCurrentSelection(input: unknown): Promise<void> {
    return this.enqueue(() => this.setCurrentSelectionUnlocked(input));
  }

  private async setCurrentSelectionUnlocked(input: unknown): Promise<void> {
    const selected = collaborationCurrentSelectionInputSchema.parse(input);
    const projects = (await this.projects.listProjects()).filter(
      (project) => project.projectId === selected.projectId
    );
    if (projects.length !== 1) throw new Error("local_collaboration_project_selection_ambiguous");
    const project = projects[0];
    if (!project.taskCanvases.some((canvas) => canvas.canvasId === selected.canvasId)) {
      throw new Error("local_collaboration_canvas_selection_mismatch");
    }
    const authorityProjectId = await this.projects.resolveAuthorityProjectId(
      project.rootPath,
      selected.canvasId
    );
    const next = {
      desktopProjectId: project.projectId,
      authorityProjectId,
      canvasId: selected.canvasId,
      projectRoot: project.rootPath
    };
    this.selection = next;
  }

  clearCurrentSelection(): Promise<void> {
    return this.enqueue(async () => {
      this.selection = null;
    });
  }

  currentSelection(): { projectId: string; canvasId: string } | null {
    return this.selection
      ? { projectId: this.selection.desktopProjectId, canvasId: this.selection.canvasId }
      : null;
  }

  status(): LocalCollaborationServerStatus {
    const lifecycle = this.controller?.status() ?? {
      profile: null,
      state: "stopped",
      startedAt: null,
      reason: null
    };
    return localCollaborationServerStatusSchema.parse({
      ...lifecycle,
      lanSharingEnabled: this.lanSharingEnabled,
      lanServerBaseUrl:
        lifecycle.state === "running" && this.lanSharingEnabled && this.lanAddress && this.localPort
          ? `http://${this.lanAddress}:${this.localPort}/`
          : null
    });
  }

  restore(): Promise<LocalCollaborationServerStatus> {
    return this.enqueue(async () => {
      const network = await this.networkStore.read();
      this.lanSharingEnabled = network.lanSharingEnabled;
      this.preferredPort = network.preferredPort;
      return (await this.scopeStore.read()).length > 0 ? this.startUnlocked() : this.status();
    });
  }

  start(): Promise<LocalCollaborationServerStatus> {
    return this.enqueue(() => this.startUnlocked());
  }

  private async startUnlocked(): Promise<LocalCollaborationServerStatus> {
    await this.ensureOperatorToken();
    const current = this.status();
    if (current.state === "running") return current;
    const trustedProjects = await this.resolveTrustedProjects();
    let lastStatus: LocalCollaborationServerStatus = current;
    for (let attempt = 0; attempt < localStartAttempts; attempt += 1) {
      this.lanAddress = this.lanSharingEnabled ? this.resolveLanAddress() : null;
      if (this.lanSharingEnabled && !this.lanAddress) {
        throw new Error("local_collaboration_lan_address_unavailable");
      }
      try {
        this.localPort = await this.allocatePort(
          this.lanSharingEnabled ? "0.0.0.0" : "127.0.0.1",
          attempt === 0 ? this.preferredPort : null
        );
      } catch (error) {
        this.localPort = null;
        if (attempt === 0 && this.preferredPort !== null) continue;
        throw error;
      }
      const controller = this.createController((profile) =>
        this.createConfig(profile, trustedProjects)
      );
      this.controller = controller;
      const status = await controller.apply({ action: "start", profile: this.serverProfile() });
      if (status.state === "running") {
        if (this.preferredPort !== this.localPort) {
          this.preferredPort = this.localPort;
          await this.persistNetworkState();
        }
        return this.status();
      }
      lastStatus = this.status();
      this.controller = null;
      this.localPort = null;
      this.lanAddress = null;
      if (status.reason !== "start_failed") return lastStatus;
    }
    return lastStatus;
  }

  stop(): Promise<LocalCollaborationServerStatus> {
    return this.enqueue(() => this.stopUnlocked());
  }

  private async stopUnlocked(): Promise<LocalCollaborationServerStatus> {
    const status = this.status();
    if (!this.controller || status.profile === null) return status;
    const stopped = await this.controller.apply({
      action: "stop",
      profileId: status.profile.profileId
    });
    if (stopped.state === "stopped") {
      this.controller = null;
      this.localPort = null;
      this.lanAddress = null;
    }
    return this.status();
  }

  setLanSharing(input: unknown): Promise<LocalCollaborationServerStatus> {
    return this.enqueue(async () => {
      const parsed = localCollaborationLanSharingInputSchema.parse(input);
      if (parsed.enabled === this.lanSharingEnabled) {
        if (
          parsed.enabled &&
          this.status().state !== "running" &&
          (await this.scopeStore.read()).length > 0
        ) {
          return this.startUnlocked();
        }
        return this.status();
      }
      if (parsed.enabled && !this.resolveLanAddress()) {
        throw new Error("local_collaboration_lan_address_unavailable");
      }
      const wasRunning = this.status().state === "running";
      if (wasRunning) {
        const stopped = await this.stopUnlocked();
        if (stopped.state !== "stopped") throw new Error("local_collaboration_network_stop_failed");
      }
      this.lanSharingEnabled = parsed.enabled;
      await this.persistNetworkState();
      if (wasRunning) return this.startUnlocked();
      if (parsed.enabled && (await this.scopeStore.read()).length > 0) {
        return this.startUnlocked();
      }
      return this.status();
    });
  }

  getScopeCatalog(): Promise<LocalCollaborationScopeCatalog> {
    return this.enqueue(() => this.getScopeCatalogUnlocked());
  }

  setTrustedScopes(input: unknown): Promise<LocalCollaborationScopeCatalog> {
    return this.enqueue(async () => {
      const parsed = localCollaborationScopeSelectionInputSchema.parse(input);
      const catalog = await this.buildScopeCatalog(parsed.scopes);
      if (catalog.selectedCount !== parsed.scopes.length) {
        throw new Error("local_collaboration_scope_selection_unknown");
      }
      const wasRunning = this.status().state === "running";
      await this.scopeStore.write(parsed.scopes);
      if (wasRunning) {
        const stopped = await this.stopUnlocked();
        if (stopped.state !== "stopped") {
          throw new Error("local_collaboration_scope_reload_stop_failed");
        }
        if (parsed.scopes.length > 0) {
          const restarted = await this.startUnlocked();
          if (restarted.state !== "running") {
            throw new Error("local_collaboration_scope_reload_failed");
          }
        }
      } else if (parsed.scopes.length > 0) {
        const started = await this.startUnlocked();
        if (started.state !== "running") throw new Error("local_collaboration_scope_start_failed");
      }
      return this.getScopeCatalogUnlocked();
    });
  }

  currentSelectionIsTrusted(): boolean {
    return this.selection !== null && this.isTrustedSelection(this.selection);
  }

  ownsLocalProfile(profileId: string): boolean {
    const status = this.status();
    if (status.state !== "running" || !status.profile || !this.controller) return false;
    return this.controller
      .listTrustedProjectScopes({ profileId: status.profile.profileId })
      .some((scope) => localProfileIdForProject(scope.projectId) === profileId);
  }

  listActiveTrustedScopes(): readonly LoopbackTrustedProjectScope[] {
    const profile = this.requireRunningProfile();
    return this.controller!.listTrustedProjectScopes({ profileId: profile.profileId });
  }

  registerCurrentProject(actor: { kind: "human"; id: string }): LoopbackProjectRegistrationView {
    const selection = this.requireSelection();
    const profile = this.requireRunningProfile();
    const matches = this.controller!.listTrustedProjectScopes({
      profileId: profile.profileId
    }).filter(
      (scope) =>
        scope.projectId === selection.authorityProjectId && scope.canvasId === selection.canvasId
    );
    if (matches.length !== 1) throw new Error("local_collaboration_trusted_scope_ambiguous");
    const scope = matches[0];
    return loopbackProjectRegistrationViewSchema.parse(
      this.controller!.registerTrustedProject(actor, {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        canvasId: scope.canvasId,
        profileId: profile.profileId
      })
    );
  }

  localProfile() {
    const selection = this.selection;
    if (!selection || this.localPort === null) return null;
    if (this.status().state === "running" && !this.isTrustedSelection(selection)) return null;
    const profile = this.connectionProfileFor(selection);
    return { ...profile, projectId: selection.authorityProjectId };
  }

  async createSelfHostedDeploymentSource(target: DeploymentTargetDraft): Promise<{
    config: ServerConfig;
    workspaceRoot: string;
    projectId: string;
  }> {
    if (target.endpoint.topology === "loopback_http") {
      throw new DeploymentBundleUnavailableError(
        "needs_project",
        "deployment_bundle_loopback_not_supported"
      );
    }
    if (!this.selection) {
      throw new DeploymentBundleUnavailableError(
        "needs_project",
        "local_collaboration_selection_required"
      );
    }
    const selection = this.selection;
    const workspace = await resolveTaskCanvasWorkspace(selection.projectRoot, selection.canvasId);
    const profileId = `deployment-${createHash("sha256")
      .update(target.endpoint.serverOrigin)
      .digest("hex")
      .slice(0, 32)}`;
    const operatorService = getOperatorControlService();
    const operatorToken = await operatorService.ensureDeploymentProfile({
      profile: {
        profileId,
        displayName: `${target.displayName} operator`,
        serverBaseUrl: target.endpoint.serverOrigin,
        allowInsecureTransport: false,
        operatorId: "desktop-self-host-admin"
      },
      operatorId: "desktop-self-host-admin"
    });
    const projectRoot = `/var/lib/planweave/projects/${workspace.id}`;
    return {
      config: parseServerConfig({
        version: "server-config/v1",
        bind: { host: "0.0.0.0", port: 443 },
        publicUrl: target.endpoint.serverOrigin,
        deployment: target.endpoint,
        tls: {
          certificatePath: "/run/planweave/input/tls/server.crt",
          privateKeyPath: "/run/planweave/input/tls/server.key"
        },
        dataDirectory: "/var/lib/planweave-server",
        trustedProjects: [
          {
            workspaceId: localWorkspaceIdForProject(workspace.id),
            projectId: workspace.id,
            canvasId: selection.canvasId,
            projectRoot
          }
        ],
        operatorCredentials: [
          {
            operatorId: "desktop-self-host-admin",
            tokenSha256: hashOperatorToken(operatorToken),
            projectIds: [],
            serverAdmin: true
          }
        ]
      }),
      workspaceRoot: dirname(workspace.projectFile),
      projectId: workspace.id
    };
  }

  private requireSelection(): ResolvedSelection {
    if (!this.selection) throw new Error("local_collaboration_selection_required");
    return this.selection;
  }

  private persistNetworkState(): Promise<void> {
    return this.networkStore.write({
      lanSharingEnabled: this.lanSharingEnabled,
      preferredPort: this.preferredPort
    });
  }

  private requireRunningProfile(): LoopbackServerProfile {
    const status = this.status();
    if (status.state !== "running" || !status.profile)
      throw new Error("loopback_server_not_running");
    return status.profile;
  }

  private isTrustedSelection(selection: ResolvedSelection): boolean {
    const status = this.status();
    if (status.state !== "running" || !status.profile || !this.controller) return false;
    return this.controller
      .listTrustedProjectScopes({ profileId: status.profile.profileId })
      .some(
        (scope) =>
          scope.projectId === selection.authorityProjectId && scope.canvasId === selection.canvasId
      );
  }

  private serverProfile(): LoopbackServerProfile {
    const localPort = this.localPort;
    if (localPort === null) throw new Error("local_collaboration_port_allocation_required");
    return loopbackServerProfileSchema.parse({
      profileId: localServerProfileId,
      displayName: "Local collaboration server",
      serverBaseUrl: `http://127.0.0.1:${localPort}/`,
      allowInsecureTransport: true
    });
  }

  private connectionProfileFor(selection: ResolvedSelection): LoopbackServerProfile {
    return loopbackServerProfileSchema.parse({
      ...this.serverProfile(),
      profileId: localProfileIdForProject(selection.authorityProjectId)
    });
  }

  private async resolveTrustedProjects(): Promise<ServerConfig["trustedProjects"]> {
    const selectedScopes = await this.scopeStore.read();
    if (selectedScopes.length === 0) {
      throw new Error("local_collaboration_trusted_scope_required");
    }
    const projects = await this.projects.listProjects();
    const trustedProjects = new Map<string, ServerConfig["trustedProjects"][number]>();
    for (const selected of selectedScopes) {
      const matches = projects.filter((project) => project.projectId === selected.projectId);
      if (matches.length !== 1) throw new Error("local_collaboration_scope_selection_unknown");
      const project = matches[0]!;
      if (!project.taskCanvases.some((canvas) => canvas.canvasId === selected.canvasId)) {
        throw new Error("local_collaboration_scope_selection_unknown");
      }
      const authorityProjectId = await this.projects.resolveAuthorityProjectId(
        project.rootPath,
        selected.canvasId
      );
      const workspaceId = localWorkspaceIdForProject(authorityProjectId);
      const key = `${workspaceId}\0${authorityProjectId}\0${selected.canvasId}`;
      const existing = trustedProjects.get(key);
      if (existing && existing.projectRoot !== project.rootPath) {
        throw new Error("local_collaboration_project_catalog_ambiguous");
      }
      trustedProjects.set(key, {
        workspaceId,
        projectId: authorityProjectId,
        canvasId: selected.canvasId,
        trustAllDeclaredCanvases: false,
        projectRoot: project.rootPath
      });
    }
    if (trustedProjects.size === 0) {
      throw new Error("local_collaboration_trusted_project_required");
    }
    return [...trustedProjects.values()];
  }

  private async getScopeCatalogUnlocked(): Promise<LocalCollaborationScopeCatalog> {
    return this.buildScopeCatalog(await this.scopeStore.read());
  }

  private async buildScopeCatalog(
    selectedScopes: readonly { projectId: string; canvasId: string }[]
  ): Promise<LocalCollaborationScopeCatalog> {
    const selected = new Set(
      selectedScopes.map((scope) => `${scope.projectId}\0${scope.canvasId}`)
    );
    const projects = (await this.projects.listProjects()).map((project) => {
      const canvases = project.taskCanvases.map((canvas) => {
        const isSelected = selected.has(`${project.projectId}\0${canvas.canvasId}`);
        return {
          canvasId: canvas.canvasId,
          name: canvas.name,
          selected: isSelected,
          current:
            this.selection?.desktopProjectId === project.projectId &&
            this.selection.canvasId === canvas.canvasId
        };
      });
      return {
        projectId: project.projectId,
        name: project.name,
        selectedCanvasCount: canvases.filter((canvas) => canvas.selected).length,
        canvases
      };
    });
    return {
      projects,
      selectedCount: projects.reduce((count, project) => count + project.selectedCanvasCount, 0)
    };
  }

  private async ensureOperatorToken(): Promise<void> {
    const storedToken = await this.vault.getOperatorToken(localOperatorCredentialKey);
    this.operatorToken = storedToken ?? null;
    if (this.operatorToken) return;
    const token = `pw_operator_${randomBytes(32).toString("base64url")}`;
    this.operatorToken = token;
    await this.vault.setOperatorToken(localOperatorCredentialKey, token, "desktop-local-admin");
  }

  private createConfig(
    profile: LoopbackServerProfile,
    trustedProjects: ServerConfig["trustedProjects"]
  ): ServerConfig {
    if (!this.operatorToken) throw new Error("local_collaboration_operator_credential_unavailable");
    const localPort = this.localPort;
    if (localPort === null) throw new Error("local_collaboration_port_allocation_required");
    const dataDirectory = join(
      desktopHomePaths().planweaveHome,
      "desktop",
      "local-collaboration-server"
    );
    return parseServerConfig({
      version: "server-config/v1" as const,
      bind: { host: this.lanSharingEnabled ? "0.0.0.0" : "127.0.0.1", port: localPort },
      publicUrl:
        this.lanSharingEnabled && this.lanAddress
          ? `http://${this.lanAddress}:${localPort}/`
          : profile.serverBaseUrl,
      allowInsecureDevelopment: true,
      allowInsecureLan: this.lanSharingEnabled,
      dataDirectory,
      trustedProjects,
      operatorCredentials: [
        {
          operatorId: "desktop-local-admin",
          tokenSha256: hashOperatorToken(this.operatorToken),
          projectIds: [],
          serverAdmin: true
        }
      ]
    });
  }
}

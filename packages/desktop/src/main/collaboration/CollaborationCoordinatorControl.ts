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
  type LoopbackServerStatus,
  type LoopbackTrustedProjectScope,
  type LoopbackProjectRegistrationView
} from "@planweave-ai/collaboration-contracts";
import { listProjects, resolveTaskCanvasWorkspace } from "@planweave-ai/runtime";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import type { OperatorSafeStoragePort } from "../operatorControl/operatorCredentialVault.js";
import { OperatorCredentialVault } from "../operatorControl/operatorCredentialVault.js";
import { desktopHomePaths } from "../planweaveHomePaths.js";
import { collaborationCurrentSelectionInputSchema } from "../../shared/collaboration.js";

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

const localProfileId = "planweave-local-loopback";
const localStartAttempts = 3;

function localWorkspaceIdForProject(projectId: string): string {
  return `workspace-local-${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}`;
}

async function allocateLoopbackPort(): Promise<number> {
  const listener = createServer();
  return new Promise<number>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
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
  status(): LoopbackServerStatus;
  start(): Promise<LoopbackServerStatus>;
  stop(): Promise<LoopbackServerStatus>;
  listActiveTrustedScopes(): readonly LoopbackTrustedProjectScope[];
  registerCurrentProject(actor: { kind: "human"; id: string }): LoopbackProjectRegistrationView;
  localProfile(): { profileId: string; displayName: string; serverBaseUrl: string; projectId: string; allowInsecureTransport: boolean } | null;
}

export class LocalCollaborationCoordinatorControl implements CollaborationCoordinatorControl {
  private selection: ResolvedSelection | null = null;
  private controller: LoopbackServerControlPort | null = null;
  private localPort: number | null = null;
  private operatorToken: string | null = null;
  private readonly vault: OperatorCredentialVault;

  private readonly projects: ProjectCatalogPort;
  private readonly createController: (createConfig: (profile: LoopbackServerProfile) => ServerConfig) => LoopbackServerControlPort;
  private readonly allocatePort: () => Promise<number>;

  constructor(options: {
    safeStorage: OperatorSafeStoragePort;
    projects?: ProjectCatalogPort;
    createController?: (createConfig: (profile: LoopbackServerProfile) => ServerConfig) => LoopbackServerControlPort;
    allocatePort?: () => Promise<number>;
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
    this.allocatePort = options.allocatePort ?? allocateLoopbackPort;
  }

  async setCurrentSelection(input: unknown): Promise<void> {
    const selected = collaborationCurrentSelectionInputSchema.parse(input);
    const projects = (await this.projects.listProjects()).filter((project) => project.projectId === selected.projectId);
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
    if (
      this.controller?.status().profile &&
      this.selection &&
      (this.selection.desktopProjectId !== next.desktopProjectId ||
        this.selection.canvasId !== next.canvasId)
    ) {
      await this.stop();
    }
    this.selection = next;
  }

  async clearCurrentSelection(): Promise<void> {
    if (this.status().profile) await this.stop();
    this.selection = null;
  }

  status(): LoopbackServerStatus {
    return this.controller?.status() ?? { profile: null, state: "stopped", startedAt: null, reason: null };
  }

  async start(): Promise<LoopbackServerStatus> {
    const selection = this.requireSelection();
    await this.ensureOperatorToken();
    const current = this.status();
    if (current.state === "running") return current;
    let lastStatus = current;
    for (let attempt = 0; attempt < localStartAttempts; attempt += 1) {
      this.localPort = await this.allocatePort();
      const controller = this.createController((profile) =>
        this.createConfig(profile, this.requireSelection())
      );
      this.controller = controller;
      const status = await controller.apply({ action: "start", profile: this.profileFor(selection) });
      if (status.state === "running") return status;
      lastStatus = status;
      this.controller = null;
      this.localPort = null;
      if (status.reason !== "start_failed") return status;
    }
    return lastStatus;
  }

  async stop(): Promise<LoopbackServerStatus> {
    const status = this.status();
    if (!this.controller || status.profile === null) return status;
    return this.controller.apply({ action: "stop", profileId: status.profile.profileId });
  }

  listActiveTrustedScopes(): readonly LoopbackTrustedProjectScope[] {
    const profile = this.requireRunningProfile();
    return this.controller!.listTrustedProjectScopes({ profileId: profile.profileId });
  }

  registerCurrentProject(actor: { kind: "human"; id: string }): LoopbackProjectRegistrationView {
    const selection = this.requireSelection();
    const profile = this.requireRunningProfile();
    const matches = this.controller!
      .listTrustedProjectScopes({ profileId: profile.profileId })
      .filter(
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
    const profile = this.profileFor(selection);
    return { ...profile, projectId: selection.authorityProjectId };
  }

  private requireSelection(): ResolvedSelection {
    if (!this.selection) throw new Error("local_collaboration_selection_required");
    return this.selection;
  }

  private requireRunningProfile(): LoopbackServerProfile {
    const status = this.status();
    if (status.state !== "running" || !status.profile) throw new Error("loopback_server_not_running");
    return status.profile;
  }

  private profileFor(_selection: ResolvedSelection): LoopbackServerProfile {
    const localPort = this.localPort;
    if (localPort === null) throw new Error("local_collaboration_port_allocation_required");
    return loopbackServerProfileSchema.parse({
      profileId: localProfileId,
      displayName: "Local collaboration server",
      serverBaseUrl: `http://127.0.0.1:${localPort}/`,
      allowInsecureTransport: true
    });
  }

  private async ensureOperatorToken(): Promise<void> {
    const storedToken = await this.vault.getOperatorToken(localProfileId);
    this.operatorToken = storedToken ?? null;
    if (this.operatorToken) return;
    const token = `pw_operator_${randomBytes(32).toString("base64url")}`;
    this.operatorToken = token;
    await this.vault.setOperatorToken(localProfileId, token, "desktop-local-admin");
  }

  private createConfig(profile: LoopbackServerProfile, selection: ResolvedSelection): ServerConfig {
    if (!this.operatorToken) throw new Error("local_collaboration_operator_credential_unavailable");
    const localPort = this.localPort;
    if (localPort === null) throw new Error("local_collaboration_port_allocation_required");
    const dataDirectory = join(desktopHomePaths().planweaveHome, "desktop", "local-collaboration-server");
    return parseServerConfig({
      version: "server-config/v1" as const,
      bind: { host: "127.0.0.1", port: localPort },
      publicUrl: profile.serverBaseUrl,
      allowInsecureDevelopment: true,
      dataDirectory,
      trustedProjects: [
        {
          workspaceId: localWorkspaceIdForProject(selection.authorityProjectId),
          projectId: selection.authorityProjectId,
          canvasId: selection.canvasId,
          projectRoot: selection.projectRoot
        }
      ],
      operatorCredentials: [
        {
          operatorId: "desktop-local-admin",
          tokenSha256: hashOperatorToken(this.operatorToken),
          projectIds: [selection.authorityProjectId],
          serverAdmin: false
        }
      ]
    });
  }
}

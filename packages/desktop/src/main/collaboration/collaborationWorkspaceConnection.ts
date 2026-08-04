import {
  activeWorkspaceConnectionViewSchema,
  workspacePickerPageSchema,
  type ActiveWorkspaceConnectionError,
  type ActiveWorkspaceConnectionStatus,
  type ActiveWorkspaceConnectionView,
  type WorkspaceConnectionProfile,
  type WorkspacePickerPage
} from "@planweave-ai/collaboration-protocol/connection";
import { assertSetupViewRedacted } from "@planweave-ai/collaboration-protocol/setup";
import type { CollaborationCredentialVault } from "./collaborationCredentialVault.js";
import {
  CollaborationSetupCodeClient,
  setupCodeFailureMessage
} from "./collaborationSetupCodeClient.js";
import {
  COLLABORATION_CONNECTION_ERROR_CODES,
  CollaborationClientError,
  collaborationConnectionErrorFromUnknown,
  collaborationErrorFromUnknown
} from "./collaborationErrors.js";
import { CollaborationWorkspaceClient } from "./CollaborationWorkspaceClient.js";
import { redactCollaborationText } from "./redaction.js";
import {
  WorkspaceConnectionProfileStore,
  type StoredWorkspaceConnectionProfile,
  type WorkspaceConnectionProfileStorePaths,
  workspaceConnectionProfileStorePaths
} from "./workspaceConnectionProfileStore.js";

export type CollaborationWorkspaceConnectionOptions = {
  store?: WorkspaceConnectionProfileStore;
  storePaths?: WorkspaceConnectionProfileStorePaths;
  vault: CollaborationCredentialVault;
  request?: typeof fetch;
  clock?: { now(): Date };
  onChange?: () => void;
};

function nowIso(clock?: { now(): Date }): string {
  return (clock?.now() ?? new Date()).toISOString();
}

function localOnlyView(): ActiveWorkspaceConnectionView {
  return activeWorkspaceConnectionViewSchema.parse({
    schemaVersion: "workspace-setup/v1",
    status: "local_only",
    profile: null,
    workspaceId: null,
    workspaceDisplayName: null,
    connectedAt: null,
    error: null
  });
}

function emptyWorkspacePickerPage(): WorkspacePickerPage {
  return workspacePickerPageSchema.parse({
    schemaVersion: "workspace-setup/v1",
    items: [],
    nextCursor: null
  });
}

function toPublicProfile(stored: StoredWorkspaceConnectionProfile): WorkspaceConnectionProfile {
  return {
    schemaVersion: stored.schemaVersion,
    profileId: stored.profileId,
    displayName: stored.displayName,
    serverBaseUrl: stored.serverBaseUrl,
    workspaceId: stored.workspaceId,
    allowInsecureTransport: stored.allowInsecureTransport
  };
}

/**
 * Single Server/Workspace connection session for Desktop.
 * Credentials stay in the vault; this module only builds redacted connection/picker views.
 */
export class CollaborationWorkspaceConnection {
  private readonly store: WorkspaceConnectionProfileStore;
  private readonly vault: CollaborationCredentialVault;
  private readonly request?: typeof fetch;
  private readonly clock?: { now(): Date };
  private readonly onChange?: () => void;

  private status: ActiveWorkspaceConnectionStatus = "local_only";
  private activeProfileId: string | null = null;
  private connectedAt: string | null = null;
  private error: ActiveWorkspaceConnectionError | null = null;
  private workspaceDisplayName: string | null = null;
  private lastAuthoritativePicker: WorkspacePickerPage = emptyWorkspacePickerPage();

  constructor(options: CollaborationWorkspaceConnectionOptions) {
    this.store =
      options.store ??
      new WorkspaceConnectionProfileStore(
        options.storePaths ?? workspaceConnectionProfileStorePaths()
      );
    this.vault = options.vault;
    this.request = options.request;
    this.clock = options.clock;
    this.onChange = options.onChange;
  }

  async hydrate(): Promise<void> {
    const activeId = await this.store.getActiveProfileId();
    if (!activeId) {
      this.status = "local_only";
      this.activeProfileId = null;
      this.connectedAt = null;
      this.error = null;
      this.workspaceDisplayName = null;
      return;
    }
    const stored = await this.store.get(activeId);
    if (!stored) {
      await this.store.setActiveProfileId(null);
      this.status = "local_only";
      this.activeProfileId = null;
      return;
    }
    const persistence = await this.vault.persistenceFor(activeId);
    this.activeProfileId = activeId;
    this.workspaceDisplayName = stored.workspaceDisplayName;
    if (persistence === "missing") {
      this.status = "disconnected";
      this.connectedAt = null;
      this.error = null;
      return;
    }
    // Restored profile remains disconnected until the user explicitly connects.
    this.status = "disconnected";
    this.connectedAt = null;
    this.error = null;
  }

  async buildView(): Promise<ActiveWorkspaceConnectionView> {
    if (this.status === "local_only" || this.activeProfileId === null) {
      const view = localOnlyView();
      assertSetupViewRedacted(view);
      return view;
    }
    const stored = await this.store.get(this.activeProfileId);
    if (!stored) {
      const view = localOnlyView();
      assertSetupViewRedacted(view);
      return view;
    }
    const profile = toPublicProfile(stored);
    const view = activeWorkspaceConnectionViewSchema.parse({
      schemaVersion: "workspace-setup/v1",
      status: this.status,
      profile:
        this.status === "connected" ||
        this.status === "reconnecting" ||
        this.status === "connecting" ||
        this.status === "error" ||
        this.status === "disconnected"
          ? profile
          : null,
      workspaceId: stored.workspaceId,
      workspaceDisplayName: this.workspaceDisplayName ?? stored.workspaceDisplayName,
      connectedAt: this.connectedAt,
      error: this.error
    });
    // connected/reconnecting require profile+workspace; disconnected/error/connecting allow profile
    // Re-parse after adjusting for disconnected with profile
    if (this.status === "disconnected" || this.status === "connecting" || this.status === "error") {
      const relaxed = {
        schemaVersion: "workspace-setup/v1" as const,
        status: this.status,
        profile,
        workspaceId: stored.workspaceId,
        workspaceDisplayName: this.workspaceDisplayName ?? stored.workspaceDisplayName,
        connectedAt: this.connectedAt,
        error: this.error
      };
      // Schema only requires profile for connected/reconnecting; disconnected may include profile.
      const parsed = activeWorkspaceConnectionViewSchema.parse(relaxed);
      assertSetupViewRedacted(parsed);
      return parsed;
    }
    assertSetupViewRedacted(view);
    return view;
  }

  async buildPickerPage(cursor = 0, limit = 50): Promise<WorkspacePickerPage> {
    const activeId = this.activeProfileId ?? (await this.store.getActiveProfileId());
    if (!activeId) {
      const page = emptyWorkspacePickerPage();
      assertSetupViewRedacted(page);
      return page;
    }
    const stored = await this.store.get(activeId);
    if (!stored) {
      throw new CollaborationClientError({
        kind: "protocol",
        code: "workspace_connection_profile_missing",
        message: "The active Workspace connection profile is unavailable.",
        retryable: false
      });
    }
    const page = await this.listAuthoritativeWorkspaces(stored, cursor, limit);
    assertSetupViewRedacted(page);
    return page;
  }

  buildCachedPickerPage(): WorkspacePickerPage {
    assertSetupViewRedacted(this.lastAuthoritativePicker);
    return this.lastAuthoritativePicker;
  }

  private async listAuthoritativeWorkspaces(
    stored: StoredWorkspaceConnectionProfile,
    cursor: number,
    limit: number
  ): Promise<WorkspacePickerPage> {
    const client = new CollaborationWorkspaceClient({
      profile: toPublicProfile(stored),
      credential: { getDeviceToken: () => this.vault.getDeviceToken(stored.profileId) },
      request: this.request
    });
    try {
      const page = await client.listWorkspaces({ cursor, limit });
      this.lastAuthoritativePicker = page;
      return page;
    } finally {
      client.dispose();
    }
  }

  private async findAuthoritativeWorkspace(
    stored: StoredWorkspaceConnectionProfile
  ): Promise<WorkspacePickerPage["items"][number] | null> {
    let cursor = 0;
    for (let pageCount = 0; pageCount < 100; pageCount += 1) {
      const page = await this.listAuthoritativeWorkspaces(stored, cursor, 100);
      const match = page.items.find(
        (item) =>
          item.workspaceId === stored.workspaceId &&
          item.membershipActive &&
          item.archivedAt === null
      );
      if (match) return match;
      if (page.nextCursor === null) return null;
      if (page.nextCursor <= cursor) {
        throw new CollaborationClientError({
          kind: "protocol",
          code: "workspace_connection_pagination_invalid",
          message: "Workspace picker pagination was invalid.",
          retryable: false
        });
      }
      cursor = page.nextCursor;
    }
    throw new CollaborationClientError({
      kind: "protocol",
      code: "workspace_connection_picker_limit_exceeded",
      message: "Workspace picker exceeded the supported page limit.",
      retryable: false
    });
  }

  /**
   * Redeem a one-time device setup code. Token stays in the vault; never returned.
   */
  async redeemDeviceSetupCode(input: {
    serverBaseUrl: string;
    allowInsecureTransport: boolean;
    setupCode: string;
    displayName: string;
    deviceLabel?: string;
  }): Promise<ActiveWorkspaceConnectionView> {
    this.status = "connecting";
    this.error = null;
    this.onChange?.();
    try {
      const client = new CollaborationSetupCodeClient({
        origin: {
          serverBaseUrl: input.serverBaseUrl,
          allowInsecureTransport: input.allowInsecureTransport
        },
        request: this.request
      });
      const response = await client.redeemDevice({
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session",
        setupCode: input.setupCode,
        displayName: input.displayName,
        ...(input.deviceLabel ? { deviceLabel: input.deviceLabel } : {})
      });
      const stored = await this.store.upsert({
        profile: response.connectionProfile,
        workspaceDisplayName: response.workspaceDisplayName,
        membershipRole:
          response.role === "owner" || response.role === "member" ? response.role : null,
        membershipActive: true
      });
      await this.vault.setDeviceToken(stored.profileId, response.deviceToken, {
        deviceCredentialId: response.deviceSessionId,
        humanPrincipalId: response.humanPrincipalId
      });
      await this.store.setActiveProfileId(stored.profileId);
      this.activeProfileId = stored.profileId;
      this.workspaceDisplayName = response.workspaceDisplayName;
      return await this.connectActiveProfile();
    } catch (error) {
      const setupError = collaborationErrorFromUnknown(error);
      const mapped = setupError.code.startsWith("setup_code_")
        ? setupError
        : collaborationConnectionErrorFromUnknown(setupError);
      this.status = "error";
      this.error = {
        code: mapped.code,
        message: setupCodeFailureMessage(error),
        retryable: mapped.retryable !== false
      };
      this.onChange?.();
      throw mapped;
    }
  }

  async connectActiveProfile(): Promise<ActiveWorkspaceConnectionView> {
    const activeId = this.activeProfileId ?? (await this.store.getActiveProfileId());
    if (!activeId) {
      this.status = "local_only";
      return this.buildView();
    }
    const stored = await this.store.get(activeId);
    if (!stored) {
      this.status = "local_only";
      this.activeProfileId = null;
      return this.buildView();
    }
    this.status = "connecting";
    this.error = null;
    this.activeProfileId = activeId;
    this.workspaceDisplayName = stored.workspaceDisplayName;
    this.onChange?.();
    try {
      const token = await this.vault.getDeviceToken(activeId);
      if (!token) {
        throw new CollaborationClientError({
          kind: "auth",
          code: "collaboration_credential_missing",
          message: "Human device credential is not available for this Workspace.",
          retryable: false
        });
      }
      const authoritative = await this.findAuthoritativeWorkspace(stored);
      if (!authoritative) {
        throw new CollaborationClientError({
          kind: "forbidden",
          code: COLLABORATION_CONNECTION_ERROR_CODES.workspaceForbidden,
          message: "The Server did not authorize this Workspace for the active device.",
          retryable: false
        });
      }
      await this.store.upsert({
        profile: toPublicProfile(stored),
        workspaceDisplayName: authoritative.displayName,
        membershipRole: authoritative.role,
        membershipActive: authoritative.membershipActive
      });
      this.workspaceDisplayName = authoritative.displayName;
      this.status = "connected";
      this.connectedAt = nowIso(this.clock);
      this.error = null;
      await this.store.setActiveProfileId(activeId);
      this.onChange?.();
      return this.buildView();
    } catch (error) {
      const mapped = collaborationConnectionErrorFromUnknown(error);
      this.status = "error";
      this.connectedAt = null;
      this.error = {
        code: mapped.code,
        message: mapped.message,
        retryable: mapped.retryable
      };
      this.onChange?.();
      throw mapped;
    }
  }

  async selectWorkspace(profileId: string): Promise<ActiveWorkspaceConnectionView> {
    const stored = await this.store.get(profileId);
    if (!stored) {
      throw new Error(`Unknown workspace connection profile: ${profileId}`);
    }
    await this.store.setActiveProfileId(profileId);
    this.activeProfileId = profileId;
    this.workspaceDisplayName = stored.workspaceDisplayName;
    this.status = "disconnected";
    this.connectedAt = null;
    this.error = null;
    this.onChange?.();
    return this.connectActiveProfile();
  }

  async selectWorkspaceByWorkspaceId(workspaceId: string): Promise<ActiveWorkspaceConnectionView> {
    const profiles = await this.store.list();
    const stored = profiles.find((profile) => profile.workspaceId === workspaceId);
    if (!stored) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    return this.selectWorkspace(stored.profileId);
  }

  async disconnectToLocalOnly(): Promise<ActiveWorkspaceConnectionView> {
    await this.store.setActiveProfileId(null);
    this.activeProfileId = null;
    this.workspaceDisplayName = null;
    this.status = "local_only";
    this.connectedAt = null;
    this.error = null;
    this.lastAuthoritativePicker = emptyWorkspacePickerPage();
    this.onChange?.();
    return this.buildView();
  }

  async retry(): Promise<ActiveWorkspaceConnectionView> {
    if (this.status !== "error" && this.status !== "disconnected") {
      return this.buildView();
    }
    return this.connectActiveProfile();
  }

  markError(code: string, message: string, retryable: boolean): void {
    if (this.status === "local_only") return;
    this.status = "error";
    this.error = {
      code,
      message: redactCollaborationText(message),
      retryable
    };
    this.onChange?.();
  }

  getActiveProfileId(): string | null {
    return this.activeProfileId;
  }

  async getActiveStoredProfile(): Promise<StoredWorkspaceConnectionProfile | null> {
    if (!this.activeProfileId) return null;
    return this.store.get(this.activeProfileId);
  }
}

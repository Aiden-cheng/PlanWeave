import {
  collaborationConnectionProfileSchema,
  humanBootstrapRequestSchema,
  humanConsumeInvitationRequestSchema,
  type CollaborationConnectionProfile,
  type HumanBootstrapRequest,
  type HumanBootstrapResponse,
  type HumanConsumeInvitationRequest,
  type HumanConsumeInvitationResponse
} from "@planweave-ai/collaboration-contracts";
import {
  assertNoSmuggledCollaborationSecrets,
  COLLABORATION_SESSION_ONLY_WARNING,
  collaborationBootstrapInputSchema,
  collaborationConsumeInvitationInputSchema,
  collaborationImportDeviceCredentialInputSchema,
  collaborationProfileIdInputSchema,
  collaborationUpsertProfileInputSchema,
  type CollaborationAuthHandoffView,
  type CollaborationProfileView,
  type CollaborationSessionPhase,
  type CollaborationStatus,
  type CollaborationUpsertProfileInput
} from "../../shared/collaboration.js";
import {
  CollaborationClient,
  type CollaborationClientOptions,
  type CollaborationObserverStatus
} from "./CollaborationClient.js";
import { collaborationErrorFromUnknown } from "./collaborationErrors.js";
import {
  CollaborationCredentialVault,
  type CollaborationSafeStoragePort
} from "./collaborationCredentialVault.js";
import {
  CollaborationProfileStore,
  type CollaborationProfileStorePaths
} from "./collaborationProfileStore.js";
import { collaborationCredentialVaultPaths } from "./collaborationCredentialVault.js";
import { collaborationProfileStorePaths } from "./collaborationProfileStore.js";
import { redactCollaborationText } from "./redaction.js";

export type CollaborationClientFactory = (
  options: CollaborationClientOptions
) => CollaborationClient;

export type CollaborationServiceOptions = {
  profileStore?: CollaborationProfileStore;
  vault?: CollaborationCredentialVault;
  safeStorage?: CollaborationSafeStoragePort;
  profileStorePaths?: CollaborationProfileStorePaths;
  credentialsPath?: string;
  createClient?: CollaborationClientFactory;
  request?: typeof fetch;
  clock?: { now(): Date };
  onStatusChange?: (status: CollaborationStatus) => void;
};

function nowIso(clock?: { now(): Date }): string {
  return (clock?.now() ?? new Date()).toISOString();
}

function toPublicProfile(
  profile: CollaborationConnectionProfile & { updatedAt: string },
  credential: {
    hasDeviceCredential: boolean;
    deviceCredentialPersistence: CollaborationProfileView["deviceCredentialPersistence"];
    deviceCredentialId: string | null;
    humanPrincipalId: string | null;
  }
): CollaborationProfileView {
  return {
    profileId: profile.profileId,
    displayName: profile.displayName,
    serverBaseUrl: profile.serverBaseUrl,
    projectId: profile.projectId,
    allowInsecureTransport: profile.allowInsecureTransport,
    hasDeviceCredential: credential.hasDeviceCredential,
    deviceCredentialPersistence: credential.deviceCredentialPersistence,
    deviceCredentialId: credential.deviceCredentialId,
    humanPrincipalId: credential.humanPrincipalId,
    updatedAt: profile.updatedAt
  };
}

function stripAuthHandoff(
  response: HumanBootstrapResponse | HumanConsumeInvitationResponse,
  persistence: CollaborationAuthHandoffView["deviceCredentialPersistence"],
  nonPersistenceWarning: string | null
): CollaborationAuthHandoffView {
  const base: CollaborationAuthHandoffView = {
    principal: response.principal,
    membership: response.membership,
    device: response.device,
    deviceCredentialPersistence: persistence,
    nonPersistenceWarning
  };
  if ("created" in response) {
    base.created = response.created;
  }
  if ("principalCreated" in response) {
    base.principalCreated = response.principalCreated;
  }
  if ("invitation" in response) {
    base.invitation = response.invitation;
  }
  return base;
}

/**
 * Electron-main orchestration for collaboration profiles, device credentials, and session lifecycle.
 * Renderer only sees public status/views — never tokens, ciphertext, paths, or Authorization headers.
 */
export class CollaborationService {
  private readonly profiles: CollaborationProfileStore;
  private readonly vault: CollaborationCredentialVault;
  private readonly createClient: CollaborationClientFactory;
  private readonly request?: typeof fetch;
  private readonly clock?: { now(): Date };
  private readonly onStatusChange?: (status: CollaborationStatus) => void;

  private client: CollaborationClient | null = null;
  private clientProfileId: string | null = null;
  private sessionPhase: CollaborationSessionPhase = "idle";
  private sessionDetail: string | null = null;
  private lastErrorCode: string | null = null;
  private lastErrorMessage: string | null = null;
  private observerStatus: CollaborationObserverStatus = { state: "stopped" };
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: CollaborationServiceOptions = {}) {
    const safeStorage = options.safeStorage;
    this.profiles =
      options.profileStore ??
      new CollaborationProfileStore(
        options.profileStorePaths ?? collaborationProfileStorePaths()
      );
    this.vault =
      options.vault ??
      new CollaborationCredentialVault({
        paths: options.credentialsPath
          ? collaborationCredentialVaultPaths(options.credentialsPath)
          : undefined,
        safeStorage
      });
    this.createClient =
      options.createClient ?? ((clientOptions) => new CollaborationClient(clientOptions));
    this.request = options.request;
    this.clock = options.clock;
    this.onStatusChange = options.onStatusChange;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(operation);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error("Collaboration service has been shut down.");
    }
  }

  private setSession(
    phase: CollaborationSessionPhase,
    detail: string | null = null,
    error?: { code: string; message: string } | null
  ): void {
    this.sessionPhase = phase;
    this.sessionDetail = detail;
    if (error === null) {
      this.lastErrorCode = null;
      this.lastErrorMessage = null;
    } else if (error) {
      this.lastErrorCode = error.code;
      this.lastErrorMessage = redactCollaborationText(error.message);
    }
  }

  private async buildStatus(): Promise<CollaborationStatus> {
    const documentProfiles = await this.profiles.list();
    const activeProfileId = await this.profiles.getActiveProfileId();
    const profiles: CollaborationProfileView[] = [];
    for (const profile of documentProfiles) {
      const persistence = await this.vault.persistenceFor(profile.profileId);
      const metadata = await this.vault.getMetadata(profile.profileId);
      profiles.push(
        toPublicProfile(profile, {
          hasDeviceCredential: persistence !== "missing",
          deviceCredentialPersistence: persistence,
          deviceCredentialId: metadata?.deviceCredentialId ?? null,
          humanPrincipalId: metadata?.humanPrincipalId ?? null
        })
      );
    }

    const hasSessionOnly = await this.vault.hasAnySessionOnlyCredential();
    // Also warn when active profile has session-only credential.
    let nonPersistenceWarning: string | null = null;
    if (this.vault.storageAvailability() === "unavailable") {
      const anyCredential = profiles.some((profile) => profile.hasDeviceCredential);
      if (anyCredential || hasSessionOnly) {
        nonPersistenceWarning = COLLABORATION_SESSION_ONLY_WARNING;
      }
    } else {
      const sessionOnlyProfile = profiles.find(
        (profile) => profile.deviceCredentialPersistence === "session-only"
      );
      if (sessionOnlyProfile) {
        nonPersistenceWarning = COLLABORATION_SESSION_ONLY_WARNING;
      }
    }

    let detail = this.sessionDetail;
    if (this.observerStatus.state !== "stopped" && this.client) {
      detail = `observer:${this.observerStatus.state}`;
    }

    return {
      profiles,
      activeProfileId,
      credentialStorage: this.vault.storageAvailability(),
      nonPersistenceWarning,
      session: {
        phase: this.sessionPhase,
        activeProfileId: this.clientProfileId ?? activeProfileId,
        detail,
        lastErrorCode: this.lastErrorCode,
        lastErrorMessage: this.lastErrorMessage
      },
      updatedAt: nowIso(this.clock)
    };
  }

  private async publishStatus(): Promise<CollaborationStatus> {
    const status = await this.buildStatus();
    this.onStatusChange?.(status);
    return status;
  }

  async getStatus(): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      return this.buildStatus();
    });
  }

  async upsertProfile(input: unknown): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledCollaborationSecrets(input, "upsertCollaborationProfile");
      const profile = collaborationUpsertProfileInputSchema.parse(input);
      await this.profiles.upsert(profile);
      if (this.clientProfileId === profile.profileId) {
        // Profile identity changed; drop live client so callers reconnect explicitly.
        await this.disposeClient("profile_updated");
      }
      return this.publishStatus();
    });
  }

  async removeProfile(input: unknown): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledCollaborationSecrets(input, "removeCollaborationProfile");
      const { profileId } = collaborationProfileIdInputSchema.parse(input);
      if (this.clientProfileId === profileId) {
        await this.disposeClient("profile_removed");
      }
      await this.vault.clear(profileId);
      await this.profiles.remove(profileId);
      return this.publishStatus();
    });
  }

  async setActiveProfile(input: unknown): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledCollaborationSecrets(input, "setActiveCollaborationProfile");
      const { profileId } = collaborationProfileIdInputSchema.parse(input);
      const profile = await this.profiles.get(profileId);
      if (!profile) {
        throw new Error(`Unknown collaboration profile: ${profileId}`);
      }
      if (this.clientProfileId && this.clientProfileId !== profileId) {
        await this.disposeClient("project_switch");
      }
      await this.profiles.setActiveProfileId(profileId);
      this.setSession(this.clientProfileId === profileId ? this.sessionPhase : "idle", null, null);
      return this.publishStatus();
    });
  }

  async clearActiveProfile(): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.disposeClient("active_cleared");
      await this.profiles.setActiveProfileId(null);
      this.setSession("idle", null, null);
      return this.publishStatus();
    });
  }

  async importDeviceCredential(input: unknown): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      // deviceToken is allowed only on this method — do not use assertNoSmuggled for the whole object.
      if (!input || typeof input !== "object") {
        throw new Error("importDeviceCredential requires an object payload.");
      }
      const record = input as Record<string, unknown>;
      for (const key of [
        "encryptedDeviceToken",
        "authorization",
        "Authorization",
        "credentialPath",
        "credentialsPath",
        "existingDeviceToken"
      ] as const) {
        if (key in record && record[key] !== undefined) {
          throw new Error(
            `Collaboration IPC rejected importDeviceCredential: field "${key}" is not allowed.`
          );
        }
      }
      const parsed = collaborationImportDeviceCredentialInputSchema.parse(input);
      const profile = await this.profiles.get(parsed.profileId);
      if (!profile) {
        throw new Error(`Unknown collaboration profile: ${parsed.profileId}`);
      }
      await this.vault.setDeviceToken(parsed.profileId, parsed.deviceToken, {
        deviceCredentialId: parsed.deviceCredentialId ?? null,
        humanPrincipalId: parsed.humanPrincipalId ?? null
      });
      if (this.clientProfileId === parsed.profileId) {
        await this.disposeClient("credential_imported");
      }
      return this.publishStatus();
    });
  }

  async clearDeviceCredential(input: unknown): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledCollaborationSecrets(input, "clearDeviceCredential");
      const { profileId } = collaborationProfileIdInputSchema.parse(input);
      if (this.clientProfileId === profileId) {
        await this.disposeClient("logout");
      }
      await this.vault.clear(profileId);
      return this.publishStatus();
    });
  }

  private async clientForProfile(
    profileId: string,
    requireCredential: boolean
  ): Promise<{ client: CollaborationClient; profile: CollaborationConnectionProfile }> {
    const stored = await this.profiles.get(profileId);
    if (!stored) {
      throw new Error(`Unknown collaboration profile: ${profileId}`);
    }
    const profile = collaborationConnectionProfileSchema.parse({
      profileId: stored.profileId,
      displayName: stored.displayName,
      serverBaseUrl: stored.serverBaseUrl,
      projectId: stored.projectId,
      allowInsecureTransport: stored.allowInsecureTransport
    });
    if (requireCredential) {
      const token = await this.vault.getDeviceToken(profileId);
      if (!token) {
        throw new Error("Human device credential is not available for this profile.");
      }
    }
    const client = this.createClient({
      profile,
      credential: {
        getDeviceToken: () => this.vault.getDeviceToken(profileId)
      },
      request: this.request
    });
    return { client, profile };
  }

  async bootstrapOwner(input: unknown): Promise<CollaborationAuthHandoffView> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledCollaborationSecrets(
        input && typeof input === "object"
          ? { ...(input as object), request: undefined }
          : input,
        "bootstrapCollaborationOwner"
      );
      if (input && typeof input === "object" && "request" in (input as object)) {
        assertNoSmuggledCollaborationSecrets(
          (input as { request: unknown }).request,
          "bootstrapCollaborationOwner.request"
        );
      }
      const parsed = collaborationBootstrapInputSchema.parse(input);
      const request: HumanBootstrapRequest = humanBootstrapRequestSchema.parse(parsed.request);
      const { client } = await this.clientForProfile(parsed.profileId, false);
      try {
        this.setSession("connecting", "bootstrap");
        const response = await client.bootstrapOwner(request);
        let persistence: CollaborationAuthHandoffView["deviceCredentialPersistence"] = "missing";
        if (response.deviceToken) {
          persistence = await this.vault.setDeviceToken(parsed.profileId, response.deviceToken, {
            deviceCredentialId: response.device.deviceCredentialId,
            humanPrincipalId: response.principal.humanPrincipalId
          });
        }
        await this.profiles.setActiveProfileId(parsed.profileId);
        this.setSession("ready", "bootstrap_complete", null);
        await this.publishStatus();
        const warning =
          persistence === "session-only" ? COLLABORATION_SESSION_ONLY_WARNING : null;
        return stripAuthHandoff(response, persistence, warning);
      } catch (error) {
        const mapped = collaborationErrorFromUnknown(error);
        this.setSession("error", "bootstrap_failed", {
          code: mapped.code,
          message: mapped.message
        });
        await this.publishStatus();
        throw mapped;
      } finally {
        client.dispose();
      }
    });
  }

  async consumeInvitation(input: unknown): Promise<CollaborationAuthHandoffView> {
    return this.enqueue(async () => {
      this.assertOpen();
      if (!input || typeof input !== "object") {
        throw new Error("consumeCollaborationInvitation requires an object payload.");
      }
      const outer = input as Record<string, unknown>;
      if ("existingDeviceToken" in outer && outer.existingDeviceToken !== undefined) {
        throw new Error(
          'Collaboration IPC rejected consumeCollaborationInvitation: field "existingDeviceToken" is not allowed across the renderer boundary.'
        );
      }
      assertNoSmuggledCollaborationSecrets(
        { profileId: outer.profileId },
        "consumeCollaborationInvitation"
      );
      if (outer.request && typeof outer.request === "object") {
        assertNoSmuggledCollaborationSecrets(outer.request, "consumeCollaborationInvitation.request");
      }
      const parsed = collaborationConsumeInvitationInputSchema.parse(input);
      const existing = await this.vault.getDeviceToken(parsed.profileId);
      const request: HumanConsumeInvitationRequest = humanConsumeInvitationRequestSchema.parse({
        ...parsed.request,
        ...(existing ? { existingDeviceToken: existing } : {})
      });
      const { client } = await this.clientForProfile(parsed.profileId, false);
      try {
        this.setSession("connecting", "consume_invitation");
        const response = await client.consumeInvitation(request);
        const persistence = await this.vault.setDeviceToken(
          parsed.profileId,
          response.deviceToken,
          {
            deviceCredentialId: response.device.deviceCredentialId,
            humanPrincipalId: response.principal.humanPrincipalId
          }
        );
        await this.profiles.setActiveProfileId(parsed.profileId);
        this.setSession("ready", "consume_invitation_complete", null);
        await this.publishStatus();
        const warning =
          persistence === "session-only" ? COLLABORATION_SESSION_ONLY_WARNING : null;
        return stripAuthHandoff(response, persistence, warning);
      } catch (error) {
        const mapped = collaborationErrorFromUnknown(error);
        this.setSession("error", "consume_invitation_failed", {
          code: mapped.code,
          message: mapped.message
        });
        await this.publishStatus();
        throw mapped;
      } finally {
        client.dispose();
      }
    });
  }

  async connectSession(input: unknown): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledCollaborationSecrets(input, "connectCollaborationSession");
      const { profileId } = collaborationProfileIdInputSchema.parse(input);
      if (this.clientProfileId === profileId && this.client) {
        return this.publishStatus();
      }
      await this.disposeClient("reconnect");
      const token = await this.vault.getDeviceToken(profileId);
      if (!token) {
        throw new Error("Human device credential is not available for this profile.");
      }
      const { client } = await this.clientForProfile(profileId, true);
      this.client = client;
      this.clientProfileId = profileId;
      await this.profiles.setActiveProfileId(profileId);
      this.observerStatus = { state: "stopped" };
      try {
        this.setSession("connecting", "observer");
        client.startObserver({
          onStatus: (status) => {
            this.observerStatus = status;
            if (status.state === "connected") {
              this.setSession("connected", `observer:${status.state}`, null);
            } else if (status.state === "auth_expired") {
              this.setSession("error", `observer:${status.state}`, {
                code: status.code,
                message: "Collaboration device credential was rejected by the server."
              });
              void this.vault.clear(profileId).then(() => this.publishStatus());
            } else if (status.state === "failed") {
              this.setSession("error", `observer:${status.state}`, {
                code: status.code,
                message: status.code
              });
            } else if (status.state === "reconnecting" || status.state === "connecting") {
              this.setSession("connecting", `observer:${status.state}`);
            } else if (status.state === "catching_up") {
              this.setSession("connected", `observer:${status.state}`);
            }
            void this.publishStatus();
          }
        });
        this.setSession("connecting", "observer_started", null);
      } catch (error) {
        const mapped = collaborationErrorFromUnknown(error);
        await this.disposeClient("connect_failed");
        this.setSession("error", "connect_failed", {
          code: mapped.code,
          message: mapped.message
        });
        await this.publishStatus();
        throw mapped;
      }
      return this.publishStatus();
    });
  }

  async disconnectSession(): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.disposeClient("disconnect");
      this.setSession("idle", null, null);
      return this.publishStatus();
    });
  }

  private async disposeClient(reason: string): Promise<void> {
    const client = this.client;
    this.client = null;
    this.clientProfileId = null;
    this.observerStatus = { state: "stopped" };
    if (client) {
      try {
        client.stopObserver();
      } catch {
        // ignore stop errors during dispose
      }
      try {
        client.dispose();
      } catch {
        // ignore dispose errors
      }
      this.sessionDetail = reason;
    }
  }

  /** Abort live clients and clear process memory on app shutdown. Durable ciphertext is kept. */
  async shutdown(): Promise<void> {
    await this.enqueue(async () => {
      await this.disposeClient("shutdown");
      this.vault.clearSessionMemory();
      this.setSession("idle", "shutdown", null);
      this.disposed = true;
    });
  }
}

// Re-export input type for handlers
export type { CollaborationUpsertProfileInput };

import { z } from "zod";
import {
  activityListWireQuerySchema,
  assignmentListQuerySchema,
  assignmentUpdateWireCommandSchema,
  collaborationConnectionProfileSchema,
  commentCreateWireCommandSchema,
  commentEditWireCommandSchema,
  commentListWireQuerySchema,
  commentTombstoneWireCommandSchema,
  createPendingAttachmentRequestSchema,
  humanBootstrapRequestSchema,
  humanConsumeInvitationRequestSchema,
  humanDeviceListQuerySchema,
  humanInvitationListQuerySchema,
  humanPageQuerySchema,
  opaqueIdentifierSchema,
  remoteDispatchWireCommandSchema,
  remoteEventQuerySchema,
  remoteInteractionPageQuerySchema,
  workItemRefSchema,
  type ActivityListPage,
  type AssignmentDisplayProjection,
  type AssignmentListPage,
  type CollaborationConnectionProfile,
  type CommentDisplayProjection,
  type CommentListPage,
  type EligibleAssigneesResponse,
  type FinalizePendingAttachmentResponse,
  type HumanBootstrapRequest,
  type HumanBootstrapResponse,
  type HumanConsumeInvitationRequest,
  type HumanConsumeInvitationResponse,
  type HumanDevicePage,
  type HumanInvitationPage,
  type HumanInvitationView,
  type HumanMemberPage,
  type PendingAttachmentView,
  type RemoteActionView,
  type RemoteEventReplay,
  type RemoteInteractionPage,
  type RemoteInteractionView,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-contracts";
import {
  assertNoSmuggledCollaborationSecrets,
  COLLABORATION_SESSION_ONLY_WARNING,
  collaborationBootstrapInputSchema,
  collaborationConsumeInvitationInputSchema,
  collaborationCreateInvitationInputSchema,
  collaborationDeviceCredentialIdInputSchema,
  collaborationFinalizePendingAttachmentInputSchema,
  collaborationHumanPrincipalIdInputSchema,
  collaborationImportDeviceCredentialInputSchema,
  collaborationInvitationIdInputSchema,
  collaborationPresenceCanvasInputSchema,
  collaborationPresenceUpdateInputSchema,
  collaborationProfileIdInputSchema,
  collaborationUploadPendingAttachmentInputSchema,
  collaborationUpsertProfileInputSchema,
  type CollaborationAuthHandoffView,
  type CollaborationInvitationCreateView,
  type CollaborationObserverSignal,
  type CollaborationPresenceSignal,
  type CollaborationProfileView,
  type CollaborationSessionPhase,
  type CollaborationStatus,
  type CollaborationUpsertProfileInput
} from "../../shared/collaboration.js";
import {
  collaborationRemoteActionInputSchema,
  collaborationRemoteInteractionRespondInputSchema,
  collaborationRemoteOperationIdInputSchema
} from "../../shared/collaborationReadModels.js";
import {
  CollaborationClient,
  type CollaborationClientOptions,
  type CollaborationPresenceStatus,
  type CollaborationObserverStatus
} from "./CollaborationClient.js";
import { CollaborationClientError, collaborationErrorFromUnknown } from "./collaborationErrors.js";
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
  onObserverSignal?: (signal: CollaborationObserverSignal) => void;
  onPresenceSignal?: (signal: CollaborationPresenceSignal) => void;
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
  private readonly onObserverSignal?: (signal: CollaborationObserverSignal) => void;
  private readonly onPresenceSignal?: (signal: CollaborationPresenceSignal) => void;

  private client: CollaborationClient | null = null;
  private clientProfileId: string | null = null;
  private sessionPhase: CollaborationSessionPhase = "idle";
  private sessionDetail: string | null = null;
  private lastErrorCode: string | null = null;
  private lastErrorMessage: string | null = null;
  private observerStatus: CollaborationObserverStatus = { state: "stopped" };
  /** Last validated observer cursor preserved across dispose/reconnect for the same profile. */
  private lastValidatedObserverCursor = 0;
  private lastValidatedObserverProfileId: string | null = null;
  private observerGeneration = 0;
  private presenceCanvasId: string | null = null;
  private presenceGeneration = 0;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: CollaborationServiceOptions = {}) {
    const safeStorage = options.safeStorage;
    this.profiles =
      options.profileStore ??
      new CollaborationProfileStore(options.profileStorePaths ?? collaborationProfileStorePaths());
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
    this.onObserverSignal = options.onObserverSignal;
    this.onPresenceSignal = options.onPresenceSignal;
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
      const existing = await this.profiles.get(profile.profileId);
      await this.profiles.upsert(profile);
      if (this.clientProfileId === profile.profileId) {
        // Profile identity changed; drop live client so callers reconnect explicitly.
        await this.disposeClient("profile_updated");
      }
      if (
        existing &&
        (existing.serverBaseUrl !== profile.serverBaseUrl ||
          existing.projectId !== profile.projectId)
      ) {
        this.clearRememberedObserverCursor(profile.profileId);
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
      } else {
        this.clearRememberedObserverCursor(profileId);
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
      } else {
        this.clearRememberedObserverCursor(profileId);
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
        input && typeof input === "object" ? { ...(input as object), request: undefined } : input,
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
        const warning = persistence === "session-only" ? COLLABORATION_SESSION_ONLY_WARNING : null;
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
        assertNoSmuggledCollaborationSecrets(
          outer.request,
          "consumeCollaborationInvitation.request"
        );
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
        const warning = persistence === "session-only" ? COLLABORATION_SESSION_ONLY_WARNING : null;
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
      const { client, profile } = await this.clientForProfile(profileId, true);
      this.client = client;
      this.clientProfileId = profileId;
      const observerGeneration = this.observerGeneration;
      const isCurrentObserver = () =>
        this.client === client &&
        this.clientProfileId === profileId &&
        this.observerGeneration === observerGeneration;
      await this.profiles.setActiveProfileId(profileId);
      this.observerStatus = { state: "stopped" };
      const resumeCursor =
        this.lastValidatedObserverProfileId === profileId ? this.lastValidatedObserverCursor : 0;
      try {
        this.setSession("connecting", "observer");
        client.startObserver(
          {
            onStatus: (status) => {
              if (!isCurrentObserver()) return;
              this.observerStatus = status;
              if (status.state === "connected") {
                this.rememberObserverCursor(profileId, status.cursor);
                this.setSession("connected", `observer:${status.state}`, null);
                this.publishObserverSignal({
                  type: "human.observer.cursor",
                  profileId,
                  projectId: profile.projectId,
                  cursor: status.cursor
                });
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
                this.rememberObserverCursor(profileId, status.resumeCursor);
                this.setSession("connected", `observer:${status.state}`);
              }
              void this.publishStatus();
            },
            onEvent: (message) => {
              if (!isCurrentObserver()) return;
              this.rememberObserverCursor(profileId, message.cursor);
              this.publishObserverSignal({
                type: "human.observer.event",
                profileId,
                projectId: profile.projectId,
                event: message
              });
            },
            onCatchupRequired: (message) => {
              if (!isCurrentObserver()) return;
              this.rememberObserverCursor(profileId, message.resumeCursor);
              this.publishObserverSignal({
                type: "human.observer.catchup_required",
                profileId,
                projectId: profile.projectId,
                reason: message.reason,
                resumeCursor: message.resumeCursor,
                droppedThroughCursor: message.droppedThroughCursor
              });
            }
          },
          { cursor: resumeCursor }
        );
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

  /** Bind ephemeral presence to the active profile/project and selected canvas. */
  async startPresence(input: unknown): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      const { canvasId } = collaborationPresenceCanvasInputSchema.parse(input);
      const client = this.client;
      const profileId = this.clientProfileId;
      if (!client || !profileId) {
        throw new CollaborationClientError({
          kind: "aborted",
          code: "collaboration_session_not_connected",
          message: "Collaboration session is not connected."
        });
      }
      if (this.presenceCanvasId === canvasId && client.presenceCanvas() === canvasId) return;
      this.presenceGeneration += 1;
      const generation = this.presenceGeneration;
      this.presenceCanvasId = canvasId;
      const isCurrent = () =>
        this.client === client &&
        this.clientProfileId === profileId &&
        this.presenceCanvasId === canvasId &&
        this.presenceGeneration === generation;
      client.startPresence(canvasId, {
        onSnapshot: (message) => {
          if (!isCurrent()) return;
          this.publishPresenceSignal({ profileId, message });
        },
        onUpdate: (message) => {
          if (!isCurrent()) return;
          this.publishPresenceSignal({ profileId, message });
        },
        onLeave: (message) => {
          if (!isCurrent()) return;
          this.publishPresenceSignal({ profileId, message });
        },
        onError: (message) => {
          if (!isCurrent()) return;
          this.publishPresenceSignal({ profileId, message });
        },
        onStatus: (status: CollaborationPresenceStatus) => {
          if (!isCurrent()) return;
          if (status.state === "reconnecting") {
            this.publishPresenceSignal({
              profileId,
              reset: { canvasId, reason: "disconnected" }
            });
          } else if (status.state === "auth_expired") {
            this.publishPresenceSignal({
              profileId,
              reset: { canvasId, reason: "auth_expired" }
            });
          } else if (status.state === "error") {
            this.publishPresenceSignal({ profileId, reset: { canvasId, reason: "error" } });
          }
          if (status.state === "auth_expired") {
            this.presenceCanvasId = null;
            this.presenceGeneration += 1;
            try {
              client.stopPresence();
            } catch {
              // ignore close races during auth invalidation
            }
            this.setSession("error", "presence:auth_expired", {
              code: status.code,
              message: "Collaboration device credential was rejected by the server."
            });
            void this.vault.clear(profileId).then(() => this.publishStatus());
          } else if (status.state === "error") {
            this.setSession("error", `presence:${status.state}`, {
              code: status.code,
              message: status.code
            });
            void this.publishStatus();
          }
        }
      });
    });
  }

  async stopPresence(): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      this.presenceGeneration += 1;
      this.presenceCanvasId = null;
      try {
        this.client?.stopPresence();
      } catch {
        // ignore close races during scope teardown
      }
    });
  }

  async publishPresence(input: unknown): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      const parsed = collaborationPresenceUpdateInputSchema.parse(input);
      const client = this.client;
      if (!client || !this.clientProfileId || !this.presenceCanvasId) {
        throw new CollaborationClientError({
          kind: "aborted",
          code: "collaboration_presence_not_connected",
          message: "Canvas presence is not connected."
        });
      }
      client.publishPresence(parsed);
    });
  }

  // ---------------------------------------------------------------------------
  // Session-scoped read models / mutations (require active connected client)
  // ---------------------------------------------------------------------------

  async listMembers(input: unknown = {}): Promise<HumanMemberPage> {
    return this.withActiveClient((client) =>
      client.listMembers(humanPageQuerySchema.parse(input ?? {}))
    );
  }

  async listDevices(input: unknown = {}): Promise<HumanDevicePage> {
    return this.withActiveClient((client) =>
      client.listDevices(humanDeviceListQuerySchema.parse(input ?? {}))
    );
  }

  async listInvitations(input: unknown = {}): Promise<HumanInvitationPage> {
    return this.withActiveClient((client) =>
      client.listInvitations(humanInvitationListQuerySchema.parse(input ?? {}))
    );
  }

  async createInvitation(input: unknown = {}): Promise<CollaborationInvitationCreateView> {
    const parsed = collaborationCreateInvitationInputSchema.parse(input ?? {});
    return this.withActiveClient((client) => client.createInvitation(parsed));
  }

  async revokeInvitation(input: unknown): Promise<HumanInvitationView> {
    const { invitationId } = collaborationInvitationIdInputSchema.parse(input);
    return this.withActiveClient((client) => client.revokeInvitation(invitationId));
  }

  async removeMember(input: unknown): Promise<void> {
    const { humanPrincipalId } = collaborationHumanPrincipalIdInputSchema.parse(input);
    return this.withActiveClient((client) => client.removeMember(humanPrincipalId));
  }

  async promoteOwner(input: unknown): Promise<void> {
    const { humanPrincipalId } = collaborationHumanPrincipalIdInputSchema.parse(input);
    return this.withActiveClient((client) => client.promoteOwner(humanPrincipalId));
  }

  async demoteOwner(input: unknown): Promise<void> {
    const { humanPrincipalId } = collaborationHumanPrincipalIdInputSchema.parse(input);
    return this.withActiveClient((client) => client.demoteOwner(humanPrincipalId));
  }

  async revokeDevice(input: unknown): Promise<void> {
    const { deviceCredentialId } = collaborationDeviceCredentialIdInputSchema.parse(input);
    return this.withActiveClient((client) => client.revokeDevice(deviceCredentialId));
  }

  async listAssignments(input: unknown = {}): Promise<AssignmentListPage> {
    return this.withActiveClient((client) =>
      client.listAssignments(assignmentListQuerySchema.parse(input ?? {}))
    );
  }

  async getAssignment(input: unknown): Promise<AssignmentDisplayProjection> {
    const { workItem } = zWorkItemPayload(input);
    return this.withActiveClient((client) => client.getAssignment(workItem));
  }

  async listEligibleAssignees(input: unknown): Promise<EligibleAssigneesResponse> {
    const { workItem } = zWorkItemPayload(input);
    return this.withActiveClient((client) => client.listEligibleAssignees(workItem));
  }

  async listComments(input: unknown): Promise<CommentListPage> {
    const query = commentListWireQuerySchema.parse(input);
    return this.withActiveClient((client) => client.listComments(query));
  }

  async listActivity(input: unknown = {}): Promise<ActivityListPage> {
    return this.withActiveClient((client) =>
      client.listActivity(activityListWireQuerySchema.parse(input ?? {}))
    );
  }

  async updateAssignment(input: unknown): Promise<AssignmentDisplayProjection> {
    const command = assignmentUpdateWireCommandSchema.parse(input);
    return this.withActiveClient((client) => client.updateAssignment(command));
  }

  async createComment(input: unknown): Promise<CommentDisplayProjection> {
    const command = commentCreateWireCommandSchema.parse(input);
    return this.withActiveClient((client) => client.createComment(command));
  }

  async editComment(input: unknown): Promise<CommentDisplayProjection> {
    const command = commentEditWireCommandSchema.parse(input);
    return this.withActiveClient((client) => client.editComment(command));
  }

  async tombstoneComment(input: unknown): Promise<CommentDisplayProjection> {
    const command = commentTombstoneWireCommandSchema.parse(input);
    return this.withActiveClient((client) => client.tombstoneComment(command));
  }

  async createPendingAttachment(input: unknown): Promise<PendingAttachmentView> {
    const body = createPendingAttachmentRequestSchema.parse(input);
    return this.withActiveClient((client) => client.createPendingAttachment(body));
  }

  async uploadPendingAttachment(input: unknown): Promise<PendingAttachmentView> {
    const body = collaborationUploadPendingAttachmentInputSchema.parse(input);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(body.bodyBase64, "base64");
    } catch {
      throw new CollaborationClientError({
        kind: "validation",
        code: "collaboration_attachment_body_invalid",
        message: "Attachment body must be valid base64.",
        retryable: false
      });
    }
    if (bytes.byteLength === 0 || bytes.byteLength > 8_388_608) {
      throw new CollaborationClientError({
        kind: "validation",
        code: "collaboration_attachment_size_invalid",
        message: "Attachment body size is outside the allowed range.",
        retryable: false
      });
    }
    return this.withActiveClient((client) =>
      client.uploadPendingAttachment(body.pendingUploadId, {
        body: bytes,
        mediaType: body.mediaType,
        digestSha256: body.digestSha256
      })
    );
  }

  async dispatchRemoteOperation(input: unknown): Promise<RemoteOperationObservation> {
    const command = remoteDispatchWireCommandSchema.parse(input);
    return this.withActiveClient((client) => client.dispatchRemoteOperation(command));
  }

  async observeRemoteOperation(input: unknown): Promise<RemoteOperationObservation> {
    const { operationId } = collaborationRemoteOperationIdInputSchema.parse(input);
    return this.withActiveClient((client) => client.observeRemoteOperation(operationId));
  }

  async executeRemoteOperationAction(input: unknown): Promise<RemoteActionView> {
    const { operationId, action } = collaborationRemoteActionInputSchema.parse(input);
    return this.withActiveClient((client) =>
      client.executeRemoteOperationAction(operationId, action)
    );
  }

  async replayRemoteOperationEvents(input: unknown): Promise<RemoteEventReplay> {
    const parsed = z
      .object({
        operationId: opaqueIdentifierSchema,
        query: remoteEventQuerySchema.optional()
      })
      .strict()
      .parse(input);
    return this.withActiveClient((client) =>
      client.replayRemoteOperationEvents(parsed.operationId, parsed.query ?? {})
    );
  }

  async listRemoteOperationInteractions(input: unknown): Promise<RemoteInteractionPage> {
    const parsed = z
      .object({
        operationId: opaqueIdentifierSchema,
        query: remoteInteractionPageQuerySchema.optional()
      })
      .strict()
      .parse(input);
    return this.withActiveClient((client) =>
      client.listRemoteOperationInteractions(parsed.operationId, parsed.query ?? {})
    );
  }

  async settleRemoteOperationInteraction(input: unknown): Promise<RemoteInteractionView> {
    const { operationId, settlement } =
      collaborationRemoteInteractionRespondInputSchema.parse(input);
    return this.withActiveClient((client) =>
      client.settleRemoteOperationInteraction(operationId, settlement)
    );
  }

  async finalizePendingAttachment(input: unknown): Promise<FinalizePendingAttachmentResponse> {
    const body = collaborationFinalizePendingAttachmentInputSchema.parse(input);
    return this.withActiveClient((client) =>
      client.finalizePendingAttachment(body.pendingUploadId, {
        expectedDigestSha256: body.expectedDigestSha256
      })
    );
  }

  private async withActiveClient<T>(
    operation: (client: CollaborationClient) => Promise<T>
  ): Promise<T> {
    this.assertOpen();
    const client = this.client;
    if (!client || !this.clientProfileId) {
      throw new CollaborationClientError({
        kind: "offline",
        code: "collaboration_session_inactive",
        message: "No active collaboration session. Connect a profile before loading read models.",
        retryable: false
      });
    }
    try {
      return await operation(client);
    } catch (error) {
      throw collaborationErrorFromUnknown(error);
    }
  }

  private publishObserverSignal(signal: CollaborationObserverSignal): void {
    this.onObserverSignal?.(signal);
  }

  private publishPresenceSignal(signal: CollaborationPresenceSignal): void {
    this.onPresenceSignal?.(signal);
  }

  private rememberObserverCursor(profileId: string, cursor: number): void {
    if (!Number.isFinite(cursor) || cursor < 0) return;
    if (this.lastValidatedObserverProfileId !== profileId) {
      this.lastValidatedObserverProfileId = profileId;
      this.lastValidatedObserverCursor = cursor;
      return;
    }
    if (cursor > this.lastValidatedObserverCursor) {
      this.lastValidatedObserverCursor = cursor;
    }
  }

  private clearRememberedObserverCursor(profileId?: string | null): void {
    if (profileId == null || this.lastValidatedObserverProfileId === profileId) {
      this.lastValidatedObserverCursor = 0;
      this.lastValidatedObserverProfileId = null;
    }
  }

  private async disposeClient(reason: string): Promise<void> {
    const client = this.client;
    const profileId = this.clientProfileId;
    this.observerGeneration += 1;
    this.presenceGeneration += 1;
    this.presenceCanvasId = null;
    // Preserve validated cursor across dispose so the next connectSession can resume.
    if (client && profileId) {
      try {
        this.rememberObserverCursor(profileId, client.lastObserverCursor());
      } catch {
        // ignore cursor capture races during dispose
      }
    }
    this.client = null;
    this.clientProfileId = null;
    this.observerStatus = { state: "stopped" };
    if (client) {
      try {
        client.stopPresence();
      } catch {
        // ignore stop errors during dispose
      }
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
    // Drop resume continuity only when the device/profile identity is torn down.
    if (reason === "logout" || reason === "profile_removed" || reason === "shutdown") {
      this.clearRememberedObserverCursor(profileId);
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

function zWorkItemPayload(input: unknown): {
  workItem: ReturnType<typeof workItemRefSchema.parse>;
} {
  if (!input || typeof input !== "object" || !("workItem" in input)) {
    throw new CollaborationClientError({
      kind: "validation",
      code: "collaboration_work_item_required",
      message: "workItem is required.",
      retryable: false
    });
  }
  return { workItem: workItemRefSchema.parse((input as { workItem: unknown }).workItem) };
}

// Re-export input type for handlers
export type { CollaborationUpsertProfileInput };

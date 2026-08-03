import { COLLABORATION_REQUEST_TIMEOUT_MS } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  collaborationConnectionProfileSchema,
  type CollaborationConnectionProfile,
  type ActiveWorkspaceConnectionView,
  type WorkspacePickerPage
} from "@planweave-ai/collaboration-protocol/connection";
import {
  humanBootstrapRequestSchema,
  humanConsumeInvitationRequestSchema,
  humanDeviceListQuerySchema,
  humanInvitationListQuerySchema,
  humanPageQuerySchema,
  type HumanBootstrapRequest,
  type HumanBootstrapResponse,
  type HumanConsumeInvitationRequest,
  type HumanConsumeInvitationResponse,
  type HumanDevicePage,
  type HumanInvitationPage,
  type HumanInvitationView,
  type HumanMemberPage
} from "@planweave-ai/collaboration-protocol/identity/workspace";
import {
  type ActivityListPage,
  type CommentDisplayProjection,
  type CommentListPage
} from "@planweave-ai/collaboration-protocol/activity/comments";
import {
  type AssignmentDisplayProjection,
  type AssignmentListPage,
  type EligibleAssigneesResponse
} from "@planweave-ai/collaboration-protocol/work/assignment";
import {
  type CollaborationWorkScope,
  type ResponsibilityReadModel
} from "@planweave-ai/collaboration-protocol/work/responsibility";
import { type ExecutionTargetReadModel } from "@planweave-ai/collaboration-protocol/work/execution-target";
import {
  type FinalizePendingAttachmentResponse,
  type PendingAttachmentView
} from "@planweave-ai/collaboration-protocol/activity/attachments";
import {
  type RemoteActionView,
  type RemoteEventReplay,
  type RemoteInteractionPage,
  type RemoteInteractionView,
  type RemoteOperationObservation
} from "@planweave-ai/collaboration-protocol/remote-run";
import { type ReviewAssignmentReadModel } from "@planweave-ai/collaboration-protocol/work/review";
import { type WorkAuthorityProjection } from "@planweave-ai/collaboration-protocol/work/authority";
import { type WorkItemRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  type AccessScope,
  type AccessMutationRequest,
  type AccessMutationResult,
  type CurrentCanvasAccessView
} from "@planweave-ai/collaboration-protocol/access/control";
import {
  assertNoSmuggledCollaborationSecrets,
  COLLABORATION_SESSION_ONLY_WARNING,
  collaborationBootstrapInputSchema,
  collaborationConsumeInvitationInputSchema,
  collaborationCreateInvitationInputSchema,
  collaborationDeviceCredentialIdInputSchema,
  collaborationHumanPrincipalIdInputSchema,
  collaborationImportDeviceCredentialInputSchema,
  collaborationInvitationIdInputSchema,
  collaborationInvitationIdsInputSchema,
  collaborationProfileIdInputSchema,
  collaborationUpsertProfileInputSchema,
  collaborationCurrentCanvasAccessInputSchema,
  collaborationAccessMutationInputSchema,
  collaborationCanvasSessionInputSchema,
  type CollaborationAuthHandoffView,
  type CollaborationCommentAttachmentBody,
  type CollaborationInvitationCreateView,
  type CollaborationObserverSignal,
  type CollaborationPresenceSignal,
  type CollaborationCanvasLiveSyncSignal,
  type CollaborationSessionPhase,
  type CollaborationStatus,
  type CollaborationUpsertProfileInput
} from "../../shared/collaboration.js";
import {
  CollaborationClient,
  type CollaborationClientOptions,
  type CollaborationObserverStatus
} from "./CollaborationClient.js";
import { CollaborationRegistryService } from "./CollaborationRegistryService.js";
import {
  CollaborationCanvasCommandFacade,
  type CollaborationCanvasCommandSubmitResult,
  type CollaborationCanvasReconnectResult,
  type CollaborationCanvasCommandSessionView
} from "./collaborationCanvasCommands.js";
import { ContentVersionFacade } from "./ContentVersionFacade.js";
import { CollaborationRemoteOperationsFacade } from "./collaborationRemoteOperations.js";
import { CollaborationPresenceSession } from "./collaborationPresenceSession.js";
import { CollaborationCanvasLiveSyncSession } from "./collaborationCanvasLiveSyncSession.js";
import { CollaborationReadMutationsFacade } from "./collaborationReadMutations.js";
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
import { CollaborationWorkspaceConnection } from "./collaborationWorkspaceConnection.js";
import { CollaborationWorkspaceConnectionFacade } from "./collaborationWorkspaceConnectionFacade.js";
import { buildCollaborationStatus } from "./collaborationStatusView.js";
import {
  WorkspaceConnectionProfileStore,
  type WorkspaceConnectionProfileStorePaths,
  workspaceConnectionProfileStorePaths
} from "./workspaceConnectionProfileStore.js";
import { redactCollaborationText } from "./redaction.js";
import { CollaborationInvitationVault } from "./collaborationInvitationVault.js";
import { CanvasReplicaStore } from "./CanvasReplicaStore.js";
import { CanvasReplicaDiskMirror } from "./CanvasReplicaDiskMirror.js";
import type { CollaborationCanvasReplicaSignal } from "../../shared/canvasReplicaIpc.js";

export type CollaborationClientFactory = (
  options: CollaborationClientOptions
) => CollaborationClient;

function observerFailureMessage(code: string): string {
  if (code === "collaboration_observer_http_403") {
    return "Realtime updates are unavailable because this member does not have project read access. Ask an owner to share the project or grant this member project access.";
  }
  return code;
}

export type CollaborationServiceOptions = {
  profileStore?: CollaborationProfileStore;
  vault?: CollaborationCredentialVault;
  safeStorage?: CollaborationSafeStoragePort;
  profileStorePaths?: CollaborationProfileStorePaths;
  workspaceProfileStore?: WorkspaceConnectionProfileStore;
  workspaceProfileStorePaths?: WorkspaceConnectionProfileStorePaths;
  credentialsPath?: string;
  invitationVault?: CollaborationInvitationVault;
  invitationsPath?: string;
  createClient?: CollaborationClientFactory;
  request?: typeof fetch;
  clock?: { now(): Date };
  onStatusChange?: (status: CollaborationStatus) => void;
  onObserverSignal?: (signal: CollaborationObserverSignal) => void;
  onPresenceSignal?: (signal: CollaborationPresenceSignal) => void;
  onCanvasLiveSyncSignal?: (signal: CollaborationCanvasLiveSyncSignal) => void;
  onCanvasReplicaSignal?: (signal: CollaborationCanvasReplicaSignal) => void;
};

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
  private readonly invitationVault: CollaborationInvitationVault;
  private readonly createClient: CollaborationClientFactory;
  private readonly request?: typeof fetch;
  private readonly clock?: { now(): Date };
  private readonly onStatusChange?: (status: CollaborationStatus) => void;
  private readonly onObserverSignal?: (signal: CollaborationObserverSignal) => void;
  private readonly onPresenceSignal?: (signal: CollaborationPresenceSignal) => void;
  private readonly onCanvasLiveSyncSignal?: (signal: CollaborationCanvasLiveSyncSignal) => void;
  private readonly onCanvasReplicaSignal?: (signal: CollaborationCanvasReplicaSignal) => void;
  private readonly canvasReplicas: CanvasReplicaStore;
  private readonly canvasReplicaMirror: CanvasReplicaDiskMirror;
  private readonly registryService: CollaborationRegistryService;
  private readonly canvasCommands: CollaborationCanvasCommandFacade;
  private readonly contentVersions: ContentVersionFacade;
  private readonly remoteOperations: CollaborationRemoteOperationsFacade;
  private readonly readMutations: CollaborationReadMutationsFacade;
  private readonly workspaceConnection: CollaborationWorkspaceConnection;
  private readonly workspaceConnectionFacade: CollaborationWorkspaceConnectionFacade;
  private workspaceHydrated = false;

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
  private observerConnectDeadline: ReturnType<typeof setTimeout> | null = null;
  private readonly presenceSession: CollaborationPresenceSession;
  private readonly canvasLiveSyncSession: CollaborationCanvasLiveSyncSession;
  private disposed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private statusPublicationTransactionDepth = 0;
  private statusPublicationPending = false;

  constructor(options: CollaborationServiceOptions = {}) {
    const safeStorage = options.safeStorage ?? {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error("safeStorage is not configured");
      },
      decryptString: () => {
        throw new Error("safeStorage is not configured");
      }
    };
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
    this.invitationVault =
      options.invitationVault ??
      new CollaborationInvitationVault({ path: options.invitationsPath, safeStorage });
    this.createClient =
      options.createClient ?? ((clientOptions) => new CollaborationClient(clientOptions));
    this.request = options.request;
    this.clock = options.clock;
    this.onStatusChange = options.onStatusChange;
    this.onObserverSignal = options.onObserverSignal;
    this.onPresenceSignal = options.onPresenceSignal;
    this.onCanvasLiveSyncSignal = options.onCanvasLiveSyncSignal;
    this.onCanvasReplicaSignal = options.onCanvasReplicaSignal;
    this.canvasReplicaMirror = new CanvasReplicaDiskMirror();
    this.canvasReplicas = new CanvasReplicaStore(
      (projection) => this.onCanvasReplicaSignal?.({ type: "canvas.replica.changed", projection }),
      (snapshot) => this.canvasReplicaMirror.capture(snapshot)
    );
    this.registryService = new CollaborationRegistryService(() => this.client);
    this.contentVersions = new ContentVersionFacade(() => this.client);
    this.canvasCommands = new CollaborationCanvasCommandFacade({
      resolveClient: () => this.client,
      resolveCanvasBinding: (input) => this.contentVersions.resolveCanvasBinding(input),
      resolveCanvasScope: (input) => this.contentVersions.resolveCanvasScope(input),
      resolveAuthorityId: () =>
        this.client ? this.contentVersions.authorityIdForClient(this.client) : null,
      store: this.canvasReplicas,
      mirror: this.canvasReplicaMirror
    });
    this.remoteOperations = new CollaborationRemoteOperationsFacade((operation) =>
      this.withActiveClient(operation)
    );
    this.presenceSession = new CollaborationPresenceSession({
      getClient: () => this.client,
      getClientProfileId: () => this.clientProfileId,
      publishPresenceSignal: (signal) => this.publishPresenceSignal(signal),
      setSessionError: (detail, error) => this.setSession("error", detail, error),
      clearDeviceCredential: (profileId) => this.vault.clear(profileId),
      publishStatus: () => this.publishStatus()
    });
    this.canvasLiveSyncSession = new CollaborationCanvasLiveSyncSession({
      getClient: () => this.client,
      getClientProfileId: () => this.clientProfileId,
      resolveCanvasBinding: (input) => this.contentVersions.resolveCanvasBinding(input),
      publishCanvasLiveSyncSignal: (signal) => this.publishCanvasLiveSyncSignal(signal),
      clearDeviceCredential: (profileId) => this.vault.clear(profileId),
      publishStatus: () => this.publishStatus()
    });
    this.readMutations = new CollaborationReadMutationsFacade(
      (operation) => this.withActiveClient(operation),
      (client, workItem) => this.toAuthorityScope(client, workItem)
    );
    this.workspaceConnection = new CollaborationWorkspaceConnection({
      store:
        options.workspaceProfileStore ??
        new WorkspaceConnectionProfileStore(
          options.workspaceProfileStorePaths ?? workspaceConnectionProfileStorePaths()
        ),
      vault: this.vault,
      request: options.request,
      clock: options.clock
    });
    this.workspaceConnectionFacade = new CollaborationWorkspaceConnectionFacade({
      connection: this.workspaceConnection,
      publishStatus: () => this.publishStatus(),
      setSession: (phase, detail, error) => this.setSession(phase, detail, error)
    });
  }

  private async ensureWorkspaceHydrated(): Promise<void> {
    if (this.workspaceHydrated) return;
    await this.workspaceConnection.hydrate();
    this.workspaceHydrated = true;
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
    await this.ensureWorkspaceHydrated();
    return buildCollaborationStatus({
      profiles: this.profiles,
      vault: this.vault,
      workspaceConnection: this.workspaceConnection,
      session: {
        phase: this.sessionPhase,
        detail: this.sessionDetail,
        lastErrorCode: this.lastErrorCode,
        lastErrorMessage: this.lastErrorMessage,
        clientProfileId: this.clientProfileId,
        observerStatus: this.observerStatus,
        client: this.client
      },
      clock: this.clock
    });
  }

  private async publishStatus(): Promise<CollaborationStatus> {
    const status = await this.buildStatus();
    if (this.statusPublicationTransactionDepth > 0) {
      this.statusPublicationPending = true;
      return status;
    }
    this.onStatusChange?.(status);
    return status;
  }

  /** Main-only status transaction: nested operations publish one final renderer snapshot. */
  async runStatusPublicationTransaction<T>(operation: () => Promise<T>): Promise<T> {
    this.statusPublicationTransactionDepth += 1;
    try {
      return await operation();
    } finally {
      this.statusPublicationTransactionDepth -= 1;
      if (this.statusPublicationTransactionDepth === 0 && this.statusPublicationPending) {
        this.statusPublicationPending = false;
        const status = await this.buildStatus();
        this.onStatusChange?.(status);
      }
    }
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
      const connectionIdentityChanged =
        !existing ||
        existing.serverBaseUrl !== profile.serverBaseUrl ||
        existing.projectId !== profile.projectId ||
        existing.allowInsecureTransport !== profile.allowInsecureTransport;
      await this.profiles.upsert(profile);
      if (this.clientProfileId === profile.profileId && connectionIdentityChanged) {
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
      await this.invitationVault.clearProfile(profileId);
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

  /** Main-only identity lookup for local coordinator authorization; never crosses IPC. */
  async activeHumanPrincipalId(profileId: string): Promise<string | null> {
    const metadata = await this.vault.getMetadata(profileId);
    return metadata?.humanPrincipalId ?? null;
  }

  /** Main-only compatibility migration from the former global loopback profile. */
  async migrateLocalProfileCredential(
    sourceProfileId: string,
    targetProfileId: string
  ): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      if (sourceProfileId === targetProfileId) return;
      const [sourceProfile, targetProfile, targetToken] = await Promise.all([
        this.profiles.get(sourceProfileId),
        this.profiles.get(targetProfileId),
        this.vault.getDeviceToken(targetProfileId)
      ]);
      if (!sourceProfile || !targetProfile || sourceProfile.projectId !== targetProfile.projectId) {
        return;
      }
      if (targetToken) return;
      const [sourceToken, sourceMetadata] = await Promise.all([
        this.vault.getDeviceToken(sourceProfileId),
        this.vault.getMetadata(sourceProfileId)
      ]);
      if (!sourceToken) return;
      await this.vault.setDeviceToken(targetProfileId, sourceToken, sourceMetadata ?? undefined);
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
      if (
        this.clientProfileId === profileId &&
        this.client &&
        (this.sessionPhase === "connecting" ||
          (this.sessionPhase === "connected" &&
            this.observerStatus.state !== "failed" &&
            this.observerStatus.state !== "stopped"))
      ) {
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
      let preflightComplete = false;
      try {
        this.setSession("connecting", "http_preflight", null);
        await client.verifyAccess();
        preflightComplete = true;
        this.setSession("connected", "http_ready", null);
        this.armObserverConnectDeadline({ client, profileId, observerGeneration });
        client.startObserver(
          {
            onStatus: (status) => {
              if (!isCurrentObserver()) return;
              this.observerStatus = status;
              if (status.state === "connected") {
                this.clearObserverConnectDeadline();
                this.rememberObserverCursor(profileId, status.cursor);
                this.setSession("connected", `observer:${status.state}`, null);
                this.publishObserverSignal({
                  type: "human.observer.cursor",
                  profileId,
                  projectId: profile.projectId,
                  cursor: status.cursor
                });
              } else if (status.state === "auth_expired") {
                this.clearObserverConnectDeadline();
                this.setSession("error", `observer:${status.state}`, {
                  code: status.code,
                  message: "Collaboration device credential was rejected by the server."
                });
                void this.vault.clear(profileId).then(() => this.publishStatus());
              } else if (status.state === "failed") {
                this.clearObserverConnectDeadline();
                this.setSession("connected", `observer:${status.state}`, {
                  code: status.code,
                  message: observerFailureMessage(status.code)
                });
              } else if (status.state === "reconnecting" || status.state === "connecting") {
                if (status.state === "reconnecting" && this.observerConnectDeadline === null) {
                  this.armObserverConnectDeadline({ client, profileId, observerGeneration });
                }
                this.setSession("connected", `observer:${status.state}`);
              } else if (status.state === "catching_up") {
                this.clearObserverConnectDeadline();
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
      } catch (error) {
        const mapped = collaborationErrorFromUnknown(error);
        await this.disposeClient("connect_failed");
        if (!preflightComplete && mapped.kind === "auth") {
          await this.vault.clear(profileId);
        }
        this.setSession(
          "error",
          preflightComplete ? "connect_failed" : "connect_preflight_failed",
          {
            code: mapped.code,
            message: mapped.message
          }
        );
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

  async redeemSetupCode(input: unknown): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      return this.workspaceConnectionFacade.redeemSetupCode(input);
    });
  }

  async getActiveWorkspaceConnection(): Promise<ActiveWorkspaceConnectionView> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      return this.workspaceConnectionFacade.getActiveWorkspaceConnection();
    });
  }

  async listWorkspacePicker(input: unknown = {}): Promise<WorkspacePickerPage> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      return this.workspaceConnectionFacade.listWorkspacePicker(input);
    });
  }

  async selectWorkspaceConnection(input: unknown): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      return this.workspaceConnectionFacade.selectWorkspaceConnection(input);
    });
  }

  async connectWorkspaceConnection(): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      return this.workspaceConnectionFacade.connectWorkspaceConnection();
    });
  }

  async disconnectWorkspaceConnection(): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      return this.workspaceConnectionFacade.disconnectWorkspaceConnection();
    });
  }

  async retryWorkspaceConnection(): Promise<CollaborationStatus> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.ensureWorkspaceHydrated();
      return this.workspaceConnectionFacade.retryWorkspaceConnection();
    });
  }

  async getCurrentCanvasAccess(input: unknown): Promise<CurrentCanvasAccessView> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledCollaborationSecrets(input, "getCurrentCanvasAccess");
      const parsed = collaborationCurrentCanvasAccessInputSchema.parse(input);
      return (await this.currentCanvasAccessContext(parsed.canvasId)).view;
    });
  }

  async mutateCurrentCanvasAccess(input: unknown): Promise<AccessMutationResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledCollaborationSecrets(input, "mutateCurrentCanvasAccess");
      const mutation = collaborationAccessMutationInputSchema.parse(input);
      const { scope } = await this.currentCanvasAccessContext(mutation.canvasId);
      const request = mutation.request;
      if (
        request.scope.workspaceId !== scope.workspaceId ||
        request.scope.projectId !== scope.projectId ||
        (request.scope.scopeKind === "canvas" && request.scope.canvasId !== scope.canvasId)
      ) {
        throw new CollaborationClientError({
          kind: "forbidden",
          code: "collaboration_access_scope_mismatch",
          message: "The requested access scope does not match the active Workspace canvas."
        });
      }
      const canonicalScope: AccessScope =
        request.scope.scopeKind === "canvas"
          ? scope
          : {
              scopeKind: "project",
              workspaceId: scope.workspaceId,
              projectId: scope.projectId,
              canvasId: null
            };
      const scopedRequest: AccessMutationRequest = { ...request, scope: canonicalScope };
      return this.withActiveClient((client) =>
        client.mutateCurrentCanvasAccess({ canvasId: scope.canvasId, request: scopedRequest })
      );
    });
  }

  private async currentCanvasAccessContext(canvasId: string): Promise<{
    scope: Extract<AccessScope, { scopeKind: "canvas" }>;
    view: CurrentCanvasAccessView;
  }> {
    await this.ensureWorkspaceHydrated();
    const connection = await this.workspaceConnection.buildView();
    return this.withActiveClient(async (client) => {
      if (
        connection.status === "connected" &&
        connection.profile?.serverBaseUrl !== client.connectionProfile.serverBaseUrl
      ) {
        throw new CollaborationClientError({
          kind: "forbidden",
          code: "collaboration_workspace_connection_mismatch",
          message:
            "The active Workspace connection does not authorize the active collaboration project."
        });
      }
      const view = await client.getCurrentCanvasAccess(canvasId);
      const scope = view.scope;
      if (
        scope.projectId !== client.projectId ||
        scope.canvasId !== canvasId ||
        (connection.status === "connected" && connection.workspaceId !== scope.workspaceId)
      ) {
        throw new CollaborationClientError({
          kind: "forbidden",
          code: "collaboration_access_scope_mismatch",
          message: "The Server returned access data for a different Workspace canvas."
        });
      }
      this.assertCurrentCanvasAccessScope(view, scope);
      return { scope, view };
    });
  }

  private assertCurrentCanvasAccessScope(
    view: CurrentCanvasAccessView,
    scope: Extract<AccessScope, { scopeKind: "canvas" }>
  ): void {
    if (
      view.scope.workspaceId !== scope.workspaceId ||
      view.scope.projectId !== scope.projectId ||
      view.scope.canvasId !== scope.canvasId
    ) {
      throw new CollaborationClientError({
        kind: "forbidden",
        code: "collaboration_access_scope_mismatch",
        message: "The Server returned access data for a different Workspace canvas."
      });
    }
  }

  /** Bind ephemeral presence to the active profile/project and selected canvas. */
  async startPresence(input: unknown): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.presenceSession.start(input);
    });
  }

  async stopPresence(): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.presenceSession.stop();
    });
  }

  /** Start a read-only remote Canvas journal notification stream for the bound command session. */
  async startCanvasLiveSync(input: unknown): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.canvasLiveSyncSession.start(input);
    });
  }

  async stopCanvasLiveSync(): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      this.canvasLiveSyncSession.stop();
    });
  }

  async publishPresence(input: unknown): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.presenceSession.publish(input);
    });
  }

  // ---------------------------------------------------------------------------
  // Server-authoritative canvas commands (durable; independent of presence)
  // ---------------------------------------------------------------------------

  async submitCanvasCommand(input: unknown): Promise<CollaborationCanvasCommandSubmitResult> {
    // Hold the global service queue only for sync validation + optimistic enqueue.
    // Network submit must not block a second op from entering optimistic pending.
    let pending: Promise<CollaborationCanvasCommandSubmitResult>;
    await this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledCollaborationSecrets(input, "submitCollaborationCanvasCommand");
      pending = this.canvasCommands.submit(input);
    });
    return pending!;
  }

  async reconnectCanvas(input: unknown): Promise<CollaborationCanvasReconnectResult> {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledCollaborationSecrets(input, "reconnectCollaborationCanvas");
      return this.canvasCommands.reconnect(input);
    });
  }

  async bindCanvasCommandSession(input: unknown): Promise<CollaborationCanvasCommandSessionView> {
    return this.enqueue(async () => {
      this.assertOpen();
      return this.canvasCommands.bind(input);
    });
  }

  async getCanvasCommandSession(): Promise<CollaborationCanvasCommandSessionView> {
    return this.enqueue(async () => {
      this.assertOpen();
      return this.canvasCommands.session();
    });
  }

  async flushCanvasReplicaMaterialization(): Promise<void> {
    return this.enqueue(async () => {
      this.assertOpen();
      await this.canvasCommands.flushMaterialization();
    });
  }

  async resolveCanvasScope(input: unknown) {
    return this.enqueue(async () => {
      this.assertOpen();
      return this.contentVersions.resolveCanvasScope(input);
    });
  }

  async readCanvasRuntimeStatus(input: unknown) {
    return this.enqueue(async () => {
      this.assertOpen();
      return this.contentVersions.readRuntimeStatus(input);
    });
  }

  async getCanvasReplicaProjection(input: unknown) {
    return this.enqueue(async () => {
      this.assertOpen();
      const requested = collaborationCanvasSessionInputSchema.parse(input);
      const fromBinding = this.canvasCommands.projectionForBinding(requested);
      if (fromBinding) return fromBinding;
      const authorityId = this.client
        ? this.contentVersions.authorityIdForClient(this.client)
        : null;
      const scope = await this.contentVersions.resolveCanvasScope(requested);
      if (!authorityId || !scope) return null;
      return this.canvasReplicas.projection({
        authorityId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        canvasId: scope.canvasId
      });
    });
  }

  async bindContentAuthority(input: unknown) {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledCollaborationSecrets(input, "bindCollaborationContentAuthority");
      return this.contentVersions.bind(input);
    });
  }

  async getContentAuthority() {
    return this.enqueue(async () => {
      this.assertOpen();
      return this.contentVersions.read();
    });
  }

  async refreshContentAuthority() {
    return this.enqueue(async () => {
      this.assertOpen();
      return this.contentVersions.refresh();
    });
  }

  async publishInitialContent() {
    return this.enqueue(async () => {
      this.assertOpen();
      return this.contentVersions.publishInitial();
    });
  }

  async materializeContentHead() {
    return this.enqueue(async () => {
      this.assertOpen();
      return this.contentVersions.materializeHead();
    });
  }

  async listContentBootstrapCandidates() {
    return this.enqueue(async () => {
      this.assertOpen();
      return this.contentVersions.listBootstrapCandidates();
    });
  }

  async bootstrapContent(input: unknown) {
    return this.enqueue(async () => {
      this.assertOpen();
      assertNoSmuggledCollaborationSecrets(input, "bootstrapCollaborationContent");
      return this.contentVersions.bootstrap(input);
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

  registry(): CollaborationRegistryService {
    return this.registryService;
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
    const profileId = this.clientProfileId;
    if (!profileId) {
      return this.withActiveClient((client) => client.createInvitation(parsed));
    }
    const invitation = await this.withActiveClient((client) => client.createInvitation(parsed));
    await this.invitationVault.set(profileId, invitation);
    return invitation;
  }

  async getInvitationSecret(input: unknown): Promise<CollaborationInvitationCreateView> {
    const { invitationId } = collaborationInvitationIdInputSchema.parse(input);
    const profileId = this.clientProfileId;
    if (!profileId) {
      throw new Error("No active collaboration profile.");
    }
    const invitation = await this.invitationVault.get(profileId, invitationId);
    if (!invitation) {
      throw new Error(
        "Complete invitation is unavailable. Create a new invitation to store it securely."
      );
    }
    return invitation;
  }

  async revokeInvitation(input: unknown): Promise<HumanInvitationView> {
    const { invitationId } = collaborationInvitationIdInputSchema.parse(input);
    const profileId = this.clientProfileId;
    const revoked = await this.withActiveClient((client) => client.revokeInvitation(invitationId));
    if (profileId) await this.invitationVault.delete(profileId, invitationId);
    return revoked;
  }

  async revokeInvitations(input: unknown) {
    const parsed = collaborationInvitationIdsInputSchema.parse(input);
    const profileId = this.clientProfileId;
    const revoked = await this.withActiveClient((client) => client.revokeInvitations(parsed));
    if (profileId) {
      await Promise.all(
        parsed.invitationIds.map((id) => this.invitationVault.delete(profileId, id))
      );
    }
    return revoked;
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
    return this.readMutations.listAssignments(input);
  }

  async getAssignment(input: unknown): Promise<AssignmentDisplayProjection> {
    return this.readMutations.getAssignment(input);
  }

  async listEligibleAssignees(input: unknown): Promise<EligibleAssigneesResponse> {
    return this.readMutations.listEligibleAssignees(input);
  }

  async getWorkAuthority(input: unknown): Promise<WorkAuthorityProjection> {
    return this.readMutations.getWorkAuthority(input);
  }

  async updateResponsibility(input: unknown): Promise<ResponsibilityReadModel> {
    return this.readMutations.updateResponsibility(input);
  }

  async updateReviewer(input: unknown): Promise<ReviewAssignmentReadModel> {
    return this.readMutations.updateReviewer(input);
  }

  async updateExecutionTarget(input: unknown): Promise<ExecutionTargetReadModel> {
    return this.readMutations.updateExecutionTarget(input);
  }

  async listComments(input: unknown): Promise<CommentListPage> {
    return this.readMutations.listComments(input);
  }

  async listActivity(input: unknown = {}): Promise<ActivityListPage> {
    return this.readMutations.listActivity(input);
  }

  async updateAssignment(input: unknown): Promise<AssignmentDisplayProjection> {
    return this.readMutations.updateAssignment(input);
  }

  async createComment(input: unknown): Promise<CommentDisplayProjection> {
    return this.readMutations.createComment(input);
  }

  async editComment(input: unknown): Promise<CommentDisplayProjection> {
    return this.readMutations.editComment(input);
  }

  async tombstoneComment(input: unknown): Promise<CommentDisplayProjection> {
    return this.readMutations.tombstoneComment(input);
  }

  async createPendingAttachment(input: unknown): Promise<PendingAttachmentView> {
    return this.readMutations.createPendingAttachment(input);
  }

  async uploadPendingAttachment(input: unknown): Promise<PendingAttachmentView> {
    return this.readMutations.uploadPendingAttachment(input);
  }

  async dispatchRemoteOperation(input: unknown): Promise<RemoteOperationObservation> {
    return this.remoteOperations.dispatch(input);
  }

  async observeRemoteOperation(input: unknown): Promise<RemoteOperationObservation> {
    return this.remoteOperations.observe(input);
  }

  async executeRemoteOperationAction(input: unknown): Promise<RemoteActionView> {
    return this.remoteOperations.executeAction(input);
  }

  async replayRemoteOperationEvents(input: unknown): Promise<RemoteEventReplay> {
    return this.remoteOperations.replayEvents(input);
  }

  async listRemoteOperationInteractions(input: unknown): Promise<RemoteInteractionPage> {
    return this.remoteOperations.listInteractions(input);
  }

  async settleRemoteOperationInteraction(input: unknown): Promise<RemoteInteractionView> {
    return this.remoteOperations.settleInteraction(input);
  }

  async finalizePendingAttachment(input: unknown): Promise<FinalizePendingAttachmentResponse> {
    return this.readMutations.finalizePendingAttachment(input);
  }

  async readCommentAttachment(input: unknown): Promise<CollaborationCommentAttachmentBody> {
    return this.readMutations.readCommentAttachment(input);
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

  /**
   * Build a Server authority scope from a work item.
   * Workspace ID is resolved from the registry for the active project — never from local paths.
   */
  private async toAuthorityScope(
    client: CollaborationClient,
    workItem: WorkItemRef
  ): Promise<CollaborationWorkScope> {
    const page = await client.registry().listProjects({ limit: 100, cursor: 0 });
    const match = page.items.find((item) => item.registry.projectId === client.projectId);
    if (!match) {
      throw new CollaborationClientError({
        kind: "forbidden",
        code: "collaboration_workspace_unresolved",
        message: "Active project has no authorized Workspace registry entry.",
        retryable: false
      });
    }
    const workspaceId = match.registry.workspaceId;
    const projectId = client.projectId;
    if (workItem.kind === "task") {
      return {
        kind: "task",
        workspaceId,
        projectId,
        canvasId: workItem.canvasId,
        taskId: workItem.taskId
      };
    }
    return {
      kind: "block",
      workspaceId,
      projectId,
      canvasId: workItem.canvasId,
      blockRef: workItem.blockRef
    };
  }

  private publishObserverSignal(signal: CollaborationObserverSignal): void {
    this.onObserverSignal?.(signal);
  }

  private publishPresenceSignal(signal: CollaborationPresenceSignal): void {
    this.onPresenceSignal?.(signal);
  }

  private publishCanvasLiveSyncSignal(signal: CollaborationCanvasLiveSyncSignal): void {
    this.onCanvasLiveSyncSignal?.(signal);
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

  private clearObserverConnectDeadline(): void {
    if (this.observerConnectDeadline === null) return;
    clearTimeout(this.observerConnectDeadline);
    this.observerConnectDeadline = null;
  }

  private armObserverConnectDeadline(input: {
    client: CollaborationClient;
    profileId: string;
    observerGeneration: number;
  }): void {
    this.clearObserverConnectDeadline();
    const deadline = setTimeout(() => {
      this.observerConnectDeadline = null;
      void this.enqueue(async () => {
        const isCurrentObserver =
          this.client === input.client &&
          this.clientProfileId === input.profileId &&
          this.observerGeneration === input.observerGeneration;
        if (
          !isCurrentObserver ||
          (this.observerStatus.state !== "connecting" &&
            this.observerStatus.state !== "reconnecting")
        ) {
          return;
        }

        input.client.stopObserver();
        this.observerStatus = { state: "stopped" };
        this.setSession("connected", "observer:connect_timeout", {
          code: "collaboration_observer_connect_timeout",
          message:
            "Authenticated HTTP access is available, but realtime WebSocket updates did not connect before the deadline."
        });
        await this.publishStatus();
      });
    }, COLLABORATION_REQUEST_TIMEOUT_MS);
    deadline.unref?.();
    this.observerConnectDeadline = deadline;
  }

  private async disposeClient(reason: string): Promise<void> {
    this.clearObserverConnectDeadline();
    const client = this.client;
    const profileId = this.clientProfileId;
    this.observerGeneration += 1;
    this.presenceSession.reset();
    this.canvasLiveSyncSession.reset();
    try {
      await this.canvasCommands.flushMaterialization();
    } catch (error) {
      const mapped = collaborationErrorFromUnknown(error);
      this.setSession("error", "canvas_replica_persistence_failed", {
        code: mapped.code,
        message: mapped.message
      });
    }
    // Bump replica generations so late baseline/submit responses cannot overwrite the next session.
    this.canvasCommands.clearAllSessions();
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
    this.setSession("idle", reason, null);
    if (client) {
      try {
        client.stopPresence();
      } catch {
        // ignore stop errors during dispose
      }
      try {
        client.stopLiveSync();
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

// Re-export input type for handlers
export type { CollaborationUpsertProfileInput };

import { z } from "zod";
import {
  COMMENT_ATTACHMENT_MAX_BYTES,
  canvasCommandIntentSchema,
  canvasCommandOperationIdSchema,
  canvasPresencePointerSchema,
  canvasPresenceSelectionIdsSchema,
  accessMutationRequestSchema,
  collaborationConnectionProfileSchema,
  collaborationServerOriginSchema,
  commentContentSha256Schema,
  createPendingAttachmentRequestSchema,
  humanDisplayNameSchema,
  humanDeviceLabelSchema,
  setupCodeTokenSchema,
  type ActiveWorkspaceConnectionView,
  type CanvasAccessPage,
  type CreatePackageSnapshotRequest,
  type CreatePackageSnapshotResult,
  humanBootstrapRequestSchema,
  humanConsumeInvitationRequestSchema,
  humanCreateInvitationRequestSchema,
  humanDeviceTokenSchema,
  pendingAttachmentUploadIdSchema,
  type ActivityListPage,
  type AssignmentDisplayProjection,
  type AssignmentListPage,
  type CollaborationConnectionProfile,
  type CommentDisplayProjection,
  type CommentListPage,
  type CreatePendingAttachmentRequest,
  type EligibleAssigneesResponse,
  type FinalizePendingAttachmentResponse,
  type HumanBootstrapRequest,
  type HumanConsumeInvitationRequest,
  type HumanCreateInvitationResponse,
  type HumanDevicePage,
  type HumanDeviceView,
  type HumanInvitationPage,
  type HumanInvitationView,
  type HumanMemberPage,
  type HumanMembershipView,
  type HumanPrincipalView,
  type PackageSnapshot,
  type PendingAttachmentView,
  type ProjectAccessPage,
  type RegistryPageQuery,
  type CanvasCommandOutcome,
  type CanvasJournalEntry,
  type CanvasReconnectResponse,
  type CanvasPresenceServerMessage,
  type RemoteActionView,
  type RemoteDispatchIntent,
  type RemoteDispatchWireCommand,
  type RemoteEventReplay,
  type RemoteHumanExecutionActionCommand,
  type RemoteInteractionPage,
  type RemoteInteractionResponse,
  type RemoteInteractionView,
  type RemoteOperationObservation,
  type ResponsibilityReadModel,
  type RestorePackageSnapshotRequest,
  type RestorePackageSnapshotResult,
  type ReviewAssignmentReadModel,
  type ExecutionTargetReadModel,
  type WorkAuthorityProjection,
  type WorkspacePickerPage,
  type ContentVersionDesktopReadModel,
  type CurrentCanvasAccessView,
  type AccessMutationResult,
  type LoopbackProjectRegistrationView,
  type LoopbackServerStatus,
  type LoopbackTrustedProjectScope
} from "@planweave-ai/collaboration-contracts";
import type {
  CollaborationActivityListQueryInput,
  CollaborationAssignmentListQueryInput,
  CollaborationAssignmentUpdateInput,
  CollaborationCommentCreateInput,
  CollaborationCommentEditInput,
  CollaborationCommentListQueryInput,
  CollaborationCommentTombstoneInput,
  CollaborationDeviceListQueryInput,
  CollaborationExecutionTargetUpdateInput,
  CollaborationInvitationListQueryInput,
  CollaborationObserverSignal,
  CollaborationPageQueryInput,
  CollaborationRemoteEventQueryInput,
  CollaborationRemoteInteractionPageQueryInput,
  CollaborationRemoteOperationIdInput,
  CollaborationResponsibilityUpdateInput,
  CollaborationReviewerUpdateInput,
  CollaborationWorkAuthorityScopeInput,
  CollaborationWorkItemInput
} from "./collaborationReadModels.js";

/** Whether the OS-backed encryptor can persist device credentials across restarts. */
export type CollaborationCredentialStorage = "available" | "unavailable";

/** How the current device credential is held for a profile. */
export type CollaborationCredentialPersistence = "persisted" | "session-only" | "missing";

/**
 * Public profile view for renderer/preload.
 * Never includes deviceToken, encrypted ciphertext, credential path, or Authorization.
 */
export type CollaborationProfileView = {
  profileId: string;
  displayName: string;
  serverBaseUrl: string;
  projectId: string;
  allowInsecureTransport: boolean;
  hasDeviceCredential: boolean;
  deviceCredentialPersistence: CollaborationCredentialPersistence;
  deviceCredentialId: string | null;
  humanPrincipalId: string | null;
  updatedAt: string;
};

export type CollaborationSessionPhase = "idle" | "ready" | "connecting" | "connected" | "error";

export type CollaborationSessionView = {
  phase: CollaborationSessionPhase;
  activeProfileId: string | null;
  /** Observer/client lifecycle status for the active session (non-secret). */
  detail: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

export type CollaborationStatus = {
  profiles: CollaborationProfileView[];
  activeProfileId: string | null;
  credentialStorage: CollaborationCredentialStorage;
  /**
   * Explicit warning when a session-only credential is held because safeStorage is unavailable.
   * Null when every credential is either missing or restorable from encrypted storage.
   */
  nonPersistenceWarning: string | null;
  session: CollaborationSessionView;
  /**
   * Single Server/Workspace connection. Defaults to local_only until the user
   * explicitly redeems a setup code or connects a stored Workspace profile.
   * Never includes secrets.
   */
  workspaceConnection: ActiveWorkspaceConnectionView;
  /** Redacted Workspace picker rows last authenticated by the connected Server. */
  workspacePicker: WorkspacePickerPage;
  updatedAt: string;
};

/** Bootstrap / consume handoff returned to renderer — deviceToken always stripped. */
export type CollaborationAuthHandoffView = {
  principal: HumanPrincipalView;
  membership: HumanMembershipView;
  device: HumanDeviceView;
  invitation?: HumanInvitationView;
  created?: boolean;
  principalCreated?: boolean;
  /** Mirrors credential vault persistence after main stored the one-shot token. */
  deviceCredentialPersistence: CollaborationCredentialPersistence;
  nonPersistenceWarning: string | null;
};

const forbiddenSecretKeys = [
  "deviceToken",
  "encryptedDeviceToken",
  "encryptedRuntimeApiKey",
  "authorization",
  "Authorization",
  "credentialPath",
  "credentialsPath",
  "existingDeviceToken",
  "setupCode",
  "operatorToken",
  "hostCredentialToken",
  "hostEnrollmentCode",
  "enrollmentCode",
  "projectRoot",
  "localRoot",
  "url",
  "headers",
  "path",
  "command"
] as const;

/**
 * Reject payloads that try to smuggle secrets or credential paths into main via renderer IPC.
 * Profile upserts must only carry logical identity fields.
 */
export function assertNoSmuggledCollaborationSecrets(value: unknown, context: string): void {
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of forbiddenSecretKeys) {
    if (key in record && record[key] !== undefined) {
      throw new Error(
        `Collaboration IPC rejected ${context}: field "${key}" is not allowed across the renderer boundary.`
      );
    }
  }
}

export const collaborationProfileInputSchema = collaborationConnectionProfileSchema;
export type CollaborationProfileInput = CollaborationConnectionProfile;

export const collaborationUpsertProfileInputSchema = collaborationConnectionProfileSchema;
export type CollaborationUpsertProfileInput = z.infer<typeof collaborationUpsertProfileInputSchema>;

export const collaborationProfileIdInputSchema = z
  .object({
    profileId: z.string().trim().min(1).max(128)
  })
  .strict();
export type CollaborationProfileIdInput = z.infer<typeof collaborationProfileIdInputSchema>;

/**
 * One-shot device credential import for recovery/tests.
 * Token is accepted only on this dedicated method; it is never returned later.
 */
export const collaborationImportDeviceCredentialInputSchema = z
  .object({
    profileId: z.string().trim().min(1).max(128),
    deviceToken: humanDeviceTokenSchema,
    deviceCredentialId: z.string().trim().min(1).max(128).optional(),
    humanPrincipalId: z.string().trim().min(1).max(128).optional()
  })
  .strict();
export type CollaborationImportDeviceCredentialInput = z.infer<
  typeof collaborationImportDeviceCredentialInputSchema
>;

export const collaborationBootstrapInputSchema = z
  .object({
    profileId: z.string().trim().min(1).max(128),
    request: humanBootstrapRequestSchema
  })
  .strict();
export type CollaborationBootstrapInput = z.infer<typeof collaborationBootstrapInputSchema>;

/**
 * Dedicated setup-code redeem input. `setupCode` is accepted only on this method;
 * main stores the resulting device token and never returns secrets.
 */
export const collaborationRedeemSetupCodeInputSchema = z
  .object({
    serverBaseUrl: collaborationServerOriginSchema,
    allowInsecureTransport: z.boolean().default(false),
    setupCode: setupCodeTokenSchema,
    displayName: humanDisplayNameSchema,
    deviceLabel: humanDeviceLabelSchema.optional()
  })
  .strict();
export type CollaborationRedeemSetupCodeInput = z.infer<
  typeof collaborationRedeemSetupCodeInputSchema
>;

export const collaborationWorkspacePickerQuerySchema = z
  .object({
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50)
  })
  .strict();
export type CollaborationWorkspacePickerQuery = z.infer<
  typeof collaborationWorkspacePickerQuerySchema
>;

/**
 * Invitation consume from renderer.
 * `existingDeviceToken` is forbidden here — main injects a vault token when present.
 */
export const collaborationConsumeInvitationInputSchema = z
  .object({
    profileId: z.string().trim().min(1).max(128),
    request: humanConsumeInvitationRequestSchema.omit({ existingDeviceToken: true })
  })
  .strict();
export type CollaborationConsumeInvitationInput = z.infer<
  typeof collaborationConsumeInvitationInputSchema
>;

export type HumanBootstrapRequestInput = HumanBootstrapRequest;
export type HumanConsumeInvitationRequestInput = Omit<
  HumanConsumeInvitationRequest,
  "existingDeviceToken"
>;

/**
 * Create-invitation request from renderer.
 * Response includes a one-shot invitationToken (shareable secret) — never a device token.
 */
export const collaborationCreateInvitationInputSchema = humanCreateInvitationRequestSchema;
export type CollaborationCreateInvitationInput = z.input<
  typeof collaborationCreateInvitationInputSchema
>;

/** IPC identity payloads use plain opaque ids; main re-validates against wire schemas. */
const collaborationOpaqueIdSchema = z.string().trim().min(1).max(128);

export const collaborationInvitationIdInputSchema = z
  .object({
    invitationId: collaborationOpaqueIdSchema
  })
  .strict();
export type CollaborationInvitationIdInput = z.infer<typeof collaborationInvitationIdInputSchema>;

export const collaborationHumanPrincipalIdInputSchema = z
  .object({
    humanPrincipalId: collaborationOpaqueIdSchema
  })
  .strict();
export type CollaborationHumanPrincipalIdInput = z.infer<
  typeof collaborationHumanPrincipalIdInputSchema
>;

export const collaborationDeviceCredentialIdInputSchema = z
  .object({
    deviceCredentialId: collaborationOpaqueIdSchema
  })
  .strict();
export type CollaborationDeviceCredentialIdInput = z.infer<
  typeof collaborationDeviceCredentialIdInputSchema
>;

/** Create a staged comment attachment upload (metadata only — no bytes). */
export const collaborationCreatePendingAttachmentInputSchema = createPendingAttachmentRequestSchema;
export type CollaborationCreatePendingAttachmentInput = CreatePendingAttachmentRequest;

/**
 * Upload staged attachment bytes over IPC as base64.
 * Renderer never sends filesystem paths; only basename + content + declared media type.
 * Max payload tracks COMMENT_ATTACHMENT_MAX_BYTES (base64 expansion ~4/3).
 */
export const collaborationUploadPendingAttachmentInputSchema = z
  .object({
    pendingUploadId: pendingAttachmentUploadIdSchema,
    mediaType: z.string().min(1).max(128),
    bodyBase64: z
      .string()
      .min(1)
      .max(Math.ceil((COMMENT_ATTACHMENT_MAX_BYTES * 4) / 3) + 8),
    digestSha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]+$/)
      .optional()
  })
  .strict();
export type CollaborationUploadPendingAttachmentInput = z.infer<
  typeof collaborationUploadPendingAttachmentInputSchema
>;

export const collaborationFinalizePendingAttachmentInputSchema = z
  .object({
    pendingUploadId: pendingAttachmentUploadIdSchema,
    expectedDigestSha256: commentContentSha256Schema.optional()
  })
  .strict();
export type CollaborationFinalizePendingAttachmentInput = z.infer<
  typeof collaborationFinalizePendingAttachmentInputSchema
>;

/** One-shot invitation create view — token is display/copy-once only; never persisted by Desktop. */
export type CollaborationInvitationCreateView = HumanCreateInvitationResponse;

/** Selected canvas binding for the ephemeral presence socket. */
export const collaborationPresenceCanvasInputSchema = z
  .object({ canvasId: z.string().trim().min(1).max(128) })
  .strict();
export type CollaborationPresenceCanvasInput = z.infer<
  typeof collaborationPresenceCanvasInputSchema
>;

/** Renderer may publish only bounded pointer/selection state; identity and scope stay in main. */
export const collaborationPresenceUpdateInputSchema = z
  .object({
    pointer: canvasPresencePointerSchema.nullable(),
    selectionIds: canvasPresenceSelectionIdsSchema
  })
  .strict();
export type CollaborationPresenceUpdateInput = z.infer<
  typeof collaborationPresenceUpdateInputSchema
>;

export type CollaborationRegistryPageInput = Partial<RegistryPageQuery>;
export type CollaborationAuthorizedCanvasesInput = CollaborationRegistryPageInput & {
  projectId: string;
};
export type CollaborationRegistryReadSnapshotInput = Pick<
  RestorePackageSnapshotRequest,
  "projectId" | "canvasId" | "snapshotId"
>;

export type CollaborationPresenceSignal =
  | {
      profileId: string;
      message: CanvasPresenceServerMessage;
    }
  | {
      profileId: string;
      reset: {
        canvasId: string;
        reason: "disconnected" | "auth_expired" | "error";
      };
    };

/** Renderer → main: submit one durable canvas command intent (no actor/path/revision override authority). */
export const collaborationCanvasCommandSubmitInputSchema = z
  .object({
    canvasId: z.string().trim().min(1).max(128),
    intent: canvasCommandIntentSchema,
    operationId: canvasCommandOperationIdSchema.optional(),
    expectedRevision: z.number().int().nonnegative().optional()
  })
  .strict();
export type CollaborationCanvasCommandSubmitInput = z.infer<
  typeof collaborationCanvasCommandSubmitInputSchema
>;

export const collaborationCanvasReconnectInputSchema = z
  .object({
    canvasId: z.string().trim().min(1).max(128),
    afterRevision: z.number().int().nonnegative().optional(),
    afterContentDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict();
export type CollaborationCanvasReconnectInput = z.infer<
  typeof collaborationCanvasReconnectInputSchema
>;

export const collaborationCanvasSessionInputSchema = z
  .object({
    canvasId: z.string().trim().min(1).max(128)
  })
  .strict();
export type CollaborationCanvasSessionInput = z.infer<typeof collaborationCanvasSessionInputSchema>;

export type CollaborationCanvasCommandSessionView = {
  canvasId: string;
  revision: number;
  contentDigest: string | null;
  lastOperationId: string | null;
  lastJournalEntryId: string | null;
  pendingOperationId: string | null;
  lastConflict: {
    expectedRevision: number;
    authoritativeRevision: number;
    authoritativeContentDigest: string;
  } | null;
  lastRejectCode: string | null;
};

export type CollaborationCanvasCommandSubmitResult = {
  outcome: CanvasCommandOutcome;
  session: CollaborationCanvasCommandSessionView | null;
};

export type CollaborationCanvasReconnectResult = {
  response: CanvasReconnectResponse;
  entriesToApply: CanvasJournalEntry[];
  snapshotRequired: boolean;
  session: CollaborationCanvasCommandSessionView | null;
};

/** Renderer input is limited to an opaque canvas id; main resolves all local paths. */
export type CollaborationContentAuthorityCanvasInput = { canvasId: string };
export type CollaborationContentAuthorityView = ContentVersionDesktopReadModel;

/** Renderer supplies a selected opaque canvas id; main derives and verifies the full active scope. */
export const collaborationCurrentCanvasAccessInputSchema = z
  .object({ canvasId: z.string().trim().min(1).max(128) })
  .strict();
export type CollaborationCurrentCanvasAccessInput = z.infer<
  typeof collaborationCurrentCanvasAccessInputSchema
>;

/** ACL mutations carry an opaque route canvas plus B-001's scope + CAS request. */
export const collaborationAccessMutationInputSchema = z
  .object({
    canvasId: z.string().trim().min(1).max(128),
    request: accessMutationRequestSchema
  })
  .strict();
export type CollaborationAccessMutationInput = z.infer<
  typeof collaborationAccessMutationInputSchema
>;
export type CollaborationCurrentCanvasAccessView = CurrentCanvasAccessView;
export type CollaborationAccessMutationResult = AccessMutationResult;

/** Opaque selection only; main resolves the local project root and manifest. */
export const collaborationCurrentSelectionInputSchema = z
  .object({
    projectId: z.string().trim().min(1).max(128),
    canvasId: z.string().trim().min(1).max(128)
  })
  .strict();
export type CollaborationCurrentSelectionInput = z.infer<typeof collaborationCurrentSelectionInputSchema>;

export const collaborationInvokeChannels = {
  getCollaborationStatus: "planweave-collaboration:getStatus",
  upsertCollaborationProfile: "planweave-collaboration:upsertProfile",
  removeCollaborationProfile: "planweave-collaboration:removeProfile",
  setActiveCollaborationProfile: "planweave-collaboration:setActiveProfile",
  clearActiveCollaborationProfile: "planweave-collaboration:clearActiveProfile",
  importDeviceCredential: "planweave-collaboration:importDeviceCredential",
  clearDeviceCredential: "planweave-collaboration:clearDeviceCredential",
  bootstrapCollaborationOwner: "planweave-collaboration:bootstrapOwner",
  consumeCollaborationInvitation: "planweave-collaboration:consumeInvitation",
  connectCollaborationSession: "planweave-collaboration:connectSession",
  disconnectCollaborationSession: "planweave-collaboration:disconnectSession",
  redeemCollaborationSetupCode: "planweave-collaboration:redeemSetupCode",
  getActiveWorkspaceConnection: "planweave-collaboration:getActiveWorkspaceConnection",
  listWorkspacePicker: "planweave-collaboration:listWorkspacePicker",
  selectWorkspaceConnection: "planweave-collaboration:selectWorkspaceConnection",
  connectWorkspaceConnection: "planweave-collaboration:connectWorkspaceConnection",
  disconnectWorkspaceConnection: "planweave-collaboration:disconnectWorkspaceConnection",
  retryWorkspaceConnection: "planweave-collaboration:retryWorkspaceConnection",
  startCollaborationPresence: "planweave-collaboration:startPresence",
  stopCollaborationPresence: "planweave-collaboration:stopPresence",
  publishCollaborationPresence: "planweave-collaboration:publishPresence",
  submitCollaborationCanvasCommand: "planweave-collaboration:submitCanvasCommand",
  reconnectCollaborationCanvas: "planweave-collaboration:reconnectCanvas",
  bindCollaborationCanvasCommandSession: "planweave-collaboration:bindCanvasCommandSession",
  getCollaborationCanvasCommandSession: "planweave-collaboration:getCanvasCommandSession",
  bindCollaborationContentAuthority: "planweave-collaboration:bindContentAuthority",
  getCollaborationContentAuthority: "planweave-collaboration:getContentAuthority",
  refreshCollaborationContentAuthority: "planweave-collaboration:refreshContentAuthority",
  publishCollaborationInitialContent: "planweave-collaboration:publishInitialContent",
  materializeCollaborationContentHead: "planweave-collaboration:materializeContentHead",
  getCurrentCanvasAccess: "planweave-collaboration:getCurrentCanvasAccess",
  mutateCurrentCanvasAccess: "planweave-collaboration:mutateCurrentCanvasAccess",
  setCollaborationCurrentSelection: "planweave-collaboration:setCurrentSelection",
  clearCollaborationCurrentSelection: "planweave-collaboration:clearCurrentSelection",
  getLocalCollaborationServerStatus: "planweave-collaboration:getLocalServerStatus",
  startLocalCollaborationServer: "planweave-collaboration:startLocalServer",
  stopLocalCollaborationServer: "planweave-collaboration:stopLocalServer",
  listLocalCollaborationTrustedScopes: "planweave-collaboration:listLocalTrustedScopes",
  registerLocalCollaborationCurrentProject: "planweave-collaboration:registerLocalCurrentProject",
  listCollaborationMembers: "planweave-collaboration:listMembers",
  listCollaborationDevices: "planweave-collaboration:listDevices",
  listCollaborationInvitations: "planweave-collaboration:listInvitations",
  createCollaborationInvitation: "planweave-collaboration:createInvitation",
  revokeCollaborationInvitation: "planweave-collaboration:revokeInvitation",
  removeCollaborationMember: "planweave-collaboration:removeMember",
  promoteCollaborationOwner: "planweave-collaboration:promoteOwner",
  demoteCollaborationOwner: "planweave-collaboration:demoteOwner",
  revokeCollaborationDevice: "planweave-collaboration:revokeDevice",
  listCollaborationAssignments: "planweave-collaboration:listAssignments",
  getCollaborationAssignment: "planweave-collaboration:getAssignment",
  listCollaborationEligibleAssignees: "planweave-collaboration:listEligibleAssignees",
  getCollaborationWorkAuthority: "planweave-collaboration:getWorkAuthority",
  updateCollaborationResponsibility: "planweave-collaboration:updateResponsibility",
  updateCollaborationReviewer: "planweave-collaboration:updateReviewer",
  updateCollaborationExecutionTarget: "planweave-collaboration:updateExecutionTarget",
  listCollaborationComments: "planweave-collaboration:listComments",
  listCollaborationActivity: "planweave-collaboration:listActivity",
  listCollaborationAuthorizedProjects: "planweave-collaboration:listAuthorizedProjects",
  listCollaborationAuthorizedCanvases: "planweave-collaboration:listAuthorizedCanvases",
  readCollaborationPackageSnapshot: "planweave-collaboration:readPackageSnapshot",
  createCollaborationPackageSnapshot: "planweave-collaboration:createPackageSnapshot",
  restoreCollaborationPackageSnapshot: "planweave-collaboration:restorePackageSnapshot",
  updateCollaborationAssignment: "planweave-collaboration:updateAssignment",
  createCollaborationComment: "planweave-collaboration:createComment",
  editCollaborationComment: "planweave-collaboration:editComment",
  tombstoneCollaborationComment: "planweave-collaboration:tombstoneComment",
  createCollaborationPendingAttachment: "planweave-collaboration:createPendingAttachment",
  uploadCollaborationPendingAttachment: "planweave-collaboration:uploadPendingAttachment",
  finalizeCollaborationPendingAttachment: "planweave-collaboration:finalizePendingAttachment",
  dispatchCollaborationRemoteOperation: "planweave-collaboration:dispatchRemoteOperation",
  observeCollaborationRemoteOperation: "planweave-collaboration:observeRemoteOperation",
  executeCollaborationRemoteOperationAction: "planweave-collaboration:executeRemoteOperationAction",
  replayCollaborationRemoteOperationEvents: "planweave-collaboration:replayRemoteOperationEvents",
  listCollaborationRemoteOperationInteractions:
    "planweave-collaboration:listRemoteOperationInteractions",
  settleCollaborationRemoteOperationInteraction:
    "planweave-collaboration:settleRemoteOperationInteraction"
} as const;

export const collaborationStatusChangedChannel = "planweave-collaboration:statusChanged";
/** Human observer invalidation/progress/catch-up signals for a single shared renderer subscription. */
export const collaborationObserverSignalChannel = "planweave-collaboration:observerSignal";
/** Sanitized ephemeral canvas presence messages from the main-process socket. */
export const collaborationPresenceSignalChannel = "planweave-collaboration:presenceSignal";

export type PlanWeaveCollaborationApi = {
  getCollaborationStatus: () => Promise<CollaborationStatus>;
  upsertCollaborationProfile: (
    input: CollaborationUpsertProfileInput
  ) => Promise<CollaborationStatus>;
  removeCollaborationProfile: (input: CollaborationProfileIdInput) => Promise<CollaborationStatus>;
  setActiveCollaborationProfile: (
    input: CollaborationProfileIdInput
  ) => Promise<CollaborationStatus>;
  clearActiveCollaborationProfile: () => Promise<CollaborationStatus>;
  importDeviceCredential: (
    input: CollaborationImportDeviceCredentialInput
  ) => Promise<CollaborationStatus>;
  clearDeviceCredential: (input: CollaborationProfileIdInput) => Promise<CollaborationStatus>;
  bootstrapCollaborationOwner: (
    input: CollaborationBootstrapInput
  ) => Promise<CollaborationAuthHandoffView>;
  consumeCollaborationInvitation: (
    input: CollaborationConsumeInvitationInput
  ) => Promise<CollaborationAuthHandoffView>;
  connectCollaborationSession: (input: CollaborationProfileIdInput) => Promise<CollaborationStatus>;
  disconnectCollaborationSession: () => Promise<CollaborationStatus>;
  /**
   * Redeem a one-time device setup code. Accepts setupCode once; never returns
   * device tokens or the submitted code.
   */
  redeemCollaborationSetupCode: (
    input: CollaborationRedeemSetupCodeInput
  ) => Promise<CollaborationStatus>;
  getActiveWorkspaceConnection: () => Promise<ActiveWorkspaceConnectionView>;
  listWorkspacePicker: (input?: CollaborationWorkspacePickerQuery) => Promise<WorkspacePickerPage>;
  selectWorkspaceConnection: (
    input: CollaborationProfileIdInput | { workspaceId: string }
  ) => Promise<CollaborationStatus>;
  connectWorkspaceConnection: () => Promise<CollaborationStatus>;
  disconnectWorkspaceConnection: () => Promise<CollaborationStatus>;
  retryWorkspaceConnection: () => Promise<CollaborationStatus>;
  startCollaborationPresence: (input: CollaborationPresenceCanvasInput) => Promise<void>;
  stopCollaborationPresence: () => Promise<void>;
  publishCollaborationPresence: (input: CollaborationPresenceUpdateInput) => Promise<void>;
  submitCollaborationCanvasCommand: (
    input: CollaborationCanvasCommandSubmitInput
  ) => Promise<CollaborationCanvasCommandSubmitResult>;
  reconnectCollaborationCanvas: (
    input: CollaborationCanvasReconnectInput
  ) => Promise<CollaborationCanvasReconnectResult>;
  bindCollaborationCanvasCommandSession: (
    input: CollaborationCanvasSessionInput
  ) => Promise<CollaborationCanvasCommandSessionView | null>;
  getCollaborationCanvasCommandSession: () => Promise<CollaborationCanvasCommandSessionView | null>;
  bindCollaborationContentAuthority: (
    input: CollaborationContentAuthorityCanvasInput
  ) => Promise<CollaborationContentAuthorityView>;
  getCollaborationContentAuthority: () => Promise<CollaborationContentAuthorityView | null>;
  refreshCollaborationContentAuthority: () => Promise<CollaborationContentAuthorityView>;
  publishCollaborationInitialContent: () => Promise<CollaborationContentAuthorityView>;
  materializeCollaborationContentHead: () => Promise<CollaborationContentAuthorityView>;
  getCurrentCanvasAccess: (
    input: CollaborationCurrentCanvasAccessInput
  ) => Promise<CollaborationCurrentCanvasAccessView>;
  mutateCurrentCanvasAccess: (
    input: CollaborationAccessMutationInput
  ) => Promise<CollaborationAccessMutationResult>;
  setCollaborationCurrentSelection: (input: CollaborationCurrentSelectionInput) => Promise<void>;
  clearCollaborationCurrentSelection: () => Promise<void>;
  getLocalCollaborationServerStatus: () => Promise<LoopbackServerStatus>;
  startLocalCollaborationServer: () => Promise<LoopbackServerStatus>;
  stopLocalCollaborationServer: () => Promise<LoopbackServerStatus>;
  listLocalCollaborationTrustedScopes: () => Promise<readonly LoopbackTrustedProjectScope[]>;
  registerLocalCollaborationCurrentProject: () => Promise<LoopbackProjectRegistrationView>;
  listCollaborationMembers: (input?: CollaborationPageQueryInput) => Promise<HumanMemberPage>;
  listCollaborationDevices: (input?: CollaborationDeviceListQueryInput) => Promise<HumanDevicePage>;
  listCollaborationInvitations: (
    input?: CollaborationInvitationListQueryInput
  ) => Promise<HumanInvitationPage>;
  createCollaborationInvitation: (
    input?: CollaborationCreateInvitationInput
  ) => Promise<CollaborationInvitationCreateView>;
  revokeCollaborationInvitation: (
    input: CollaborationInvitationIdInput
  ) => Promise<HumanInvitationView>;
  removeCollaborationMember: (input: CollaborationHumanPrincipalIdInput) => Promise<void>;
  promoteCollaborationOwner: (input: CollaborationHumanPrincipalIdInput) => Promise<void>;
  demoteCollaborationOwner: (input: CollaborationHumanPrincipalIdInput) => Promise<void>;
  revokeCollaborationDevice: (input: CollaborationDeviceCredentialIdInput) => Promise<void>;
  listCollaborationAssignments: (
    input?: CollaborationAssignmentListQueryInput
  ) => Promise<AssignmentListPage>;
  getCollaborationAssignment: (
    input: CollaborationWorkItemInput
  ) => Promise<AssignmentDisplayProjection>;
  listCollaborationEligibleAssignees: (
    input: CollaborationWorkItemInput
  ) => Promise<EligibleAssigneesResponse>;
  getCollaborationWorkAuthority: (
    input: CollaborationWorkAuthorityScopeInput
  ) => Promise<WorkAuthorityProjection>;
  updateCollaborationResponsibility: (
    input: CollaborationResponsibilityUpdateInput
  ) => Promise<ResponsibilityReadModel>;
  updateCollaborationReviewer: (
    input: CollaborationReviewerUpdateInput
  ) => Promise<ReviewAssignmentReadModel>;
  updateCollaborationExecutionTarget: (
    input: CollaborationExecutionTargetUpdateInput
  ) => Promise<ExecutionTargetReadModel>;
  listCollaborationComments: (
    input: CollaborationCommentListQueryInput
  ) => Promise<CommentListPage>;
  listCollaborationActivity: (
    input?: CollaborationActivityListQueryInput
  ) => Promise<ActivityListPage>;
  listCollaborationAuthorizedProjects: (
    input?: CollaborationRegistryPageInput
  ) => Promise<ProjectAccessPage>;
  listCollaborationAuthorizedCanvases: (
    input: CollaborationAuthorizedCanvasesInput
  ) => Promise<CanvasAccessPage>;
  readCollaborationPackageSnapshot: (
    input: CollaborationRegistryReadSnapshotInput
  ) => Promise<PackageSnapshot>;
  createCollaborationPackageSnapshot: (
    input: CreatePackageSnapshotRequest
  ) => Promise<CreatePackageSnapshotResult>;
  restoreCollaborationPackageSnapshot: (
    input: RestorePackageSnapshotRequest
  ) => Promise<RestorePackageSnapshotResult>;
  updateCollaborationAssignment: (
    input: CollaborationAssignmentUpdateInput
  ) => Promise<AssignmentDisplayProjection>;
  createCollaborationComment: (
    input: CollaborationCommentCreateInput
  ) => Promise<CommentDisplayProjection>;
  editCollaborationComment: (
    input: CollaborationCommentEditInput
  ) => Promise<CommentDisplayProjection>;
  tombstoneCollaborationComment: (
    input: CollaborationCommentTombstoneInput
  ) => Promise<CommentDisplayProjection>;
  createCollaborationPendingAttachment: (
    input: CollaborationCreatePendingAttachmentInput
  ) => Promise<PendingAttachmentView>;
  uploadCollaborationPendingAttachment: (
    input: CollaborationUploadPendingAttachmentInput
  ) => Promise<PendingAttachmentView>;
  finalizeCollaborationPendingAttachment: (
    input: CollaborationFinalizePendingAttachmentInput
  ) => Promise<FinalizePendingAttachmentResponse>;
  dispatchCollaborationRemoteOperation: (
    input: RemoteDispatchIntent | RemoteDispatchWireCommand
  ) => Promise<RemoteOperationObservation>;
  observeCollaborationRemoteOperation: (
    input: CollaborationRemoteOperationIdInput
  ) => Promise<RemoteOperationObservation>;
  executeCollaborationRemoteOperationAction: (input: {
    operationId: string;
    action: RemoteHumanExecutionActionCommand;
  }) => Promise<RemoteActionView>;
  replayCollaborationRemoteOperationEvents: (input: {
    operationId: string;
    query?: CollaborationRemoteEventQueryInput;
  }) => Promise<RemoteEventReplay>;
  listCollaborationRemoteOperationInteractions: (input: {
    operationId: string;
    query?: CollaborationRemoteInteractionPageQueryInput;
  }) => Promise<RemoteInteractionPage>;
  settleCollaborationRemoteOperationInteraction: (input: {
    operationId: string;
    settlement: RemoteInteractionResponse;
  }) => Promise<RemoteInteractionView>;
  onCollaborationStatusChanged: (callback: (status: CollaborationStatus) => void) => () => void;
  onCollaborationObserverSignal: (
    callback: (signal: CollaborationObserverSignal) => void
  ) => () => void;
  onCollaborationPresenceSignal: (
    callback: (signal: CollaborationPresenceSignal) => void
  ) => () => void;
};

export const COLLABORATION_SESSION_ONLY_WARNING =
  "Electron safeStorage is unavailable, so the collaboration device credential is held only for this PlanWeave process and will not be saved.";

export type {
  CollaborationActivityListQueryInput,
  CollaborationAssignmentListQueryInput,
  CollaborationAssignmentUpdateInput,
  CollaborationCommentCreateInput,
  CollaborationCommentEditInput,
  CollaborationCommentListQueryInput,
  CollaborationCommentTombstoneInput,
  CollaborationDeviceListQueryInput,
  CollaborationExecutionTargetUpdateInput,
  CollaborationInvitationListQueryInput,
  CollaborationObserverSignal,
  CollaborationPageQueryInput,
  CollaborationResponsibilityUpdateInput,
  CollaborationReviewerUpdateInput,
  CollaborationWorkAuthorityScopeInput,
  CollaborationWorkItemInput
} from "./collaborationReadModels.js";

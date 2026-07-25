import { z } from "zod";
import {
  COMMENT_ATTACHMENT_MAX_BYTES,
  collaborationConnectionProfileSchema,
  commentContentSha256Schema,
  createPendingAttachmentRequestSchema,
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
  type PendingAttachmentView
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
  CollaborationInvitationListQueryInput,
  CollaborationObserverSignal,
  CollaborationPageQueryInput,
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
  "existingDeviceToken"
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
  listCollaborationComments: "planweave-collaboration:listComments",
  listCollaborationActivity: "planweave-collaboration:listActivity",
  updateCollaborationAssignment: "planweave-collaboration:updateAssignment",
  createCollaborationComment: "planweave-collaboration:createComment",
  editCollaborationComment: "planweave-collaboration:editComment",
  tombstoneCollaborationComment: "planweave-collaboration:tombstoneComment",
  createCollaborationPendingAttachment: "planweave-collaboration:createPendingAttachment",
  uploadCollaborationPendingAttachment: "planweave-collaboration:uploadPendingAttachment",
  finalizeCollaborationPendingAttachment: "planweave-collaboration:finalizePendingAttachment"
} as const;

export const collaborationStatusChangedChannel = "planweave-collaboration:statusChanged";
/** Human observer invalidation/progress/catch-up signals for a single shared renderer subscription. */
export const collaborationObserverSignalChannel = "planweave-collaboration:observerSignal";

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
  connectCollaborationSession: (
    input: CollaborationProfileIdInput
  ) => Promise<CollaborationStatus>;
  disconnectCollaborationSession: () => Promise<CollaborationStatus>;
  listCollaborationMembers: (input?: CollaborationPageQueryInput) => Promise<HumanMemberPage>;
  listCollaborationDevices: (
    input?: CollaborationDeviceListQueryInput
  ) => Promise<HumanDevicePage>;
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
  listCollaborationComments: (
    input: CollaborationCommentListQueryInput
  ) => Promise<CommentListPage>;
  listCollaborationActivity: (
    input?: CollaborationActivityListQueryInput
  ) => Promise<ActivityListPage>;
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
  onCollaborationStatusChanged: (callback: (status: CollaborationStatus) => void) => () => void;
  onCollaborationObserverSignal: (
    callback: (signal: CollaborationObserverSignal) => void
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
  CollaborationInvitationListQueryInput,
  CollaborationObserverSignal,
  CollaborationPageQueryInput,
  CollaborationWorkItemInput
} from "./collaborationReadModels.js";

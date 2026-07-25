import { z } from "zod";
import {
  collaborationConnectionProfileSchema,
  humanBootstrapRequestSchema,
  humanConsumeInvitationRequestSchema,
  humanDeviceTokenSchema,
  type ActivityListPage,
  type AssignmentDisplayProjection,
  type AssignmentListPage,
  type CollaborationConnectionProfile,
  type CommentDisplayProjection,
  type CommentListPage,
  type EligibleAssigneesResponse,
  type HumanBootstrapRequest,
  type HumanConsumeInvitationRequest,
  type HumanDevicePage,
  type HumanDeviceView,
  type HumanInvitationPage,
  type HumanInvitationView,
  type HumanMemberPage,
  type HumanMembershipView,
  type HumanPrincipalView
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
  listCollaborationAssignments: "planweave-collaboration:listAssignments",
  getCollaborationAssignment: "planweave-collaboration:getAssignment",
  listCollaborationEligibleAssignees: "planweave-collaboration:listEligibleAssignees",
  listCollaborationComments: "planweave-collaboration:listComments",
  listCollaborationActivity: "planweave-collaboration:listActivity",
  updateCollaborationAssignment: "planweave-collaboration:updateAssignment",
  createCollaborationComment: "planweave-collaboration:createComment",
  editCollaborationComment: "planweave-collaboration:editComment",
  tombstoneCollaborationComment: "planweave-collaboration:tombstoneComment"
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

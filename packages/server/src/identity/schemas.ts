import { opaqueIdentifierSchema } from "@planweave-ai/distributed-protocol";
import { z } from "zod";
import {
  HUMAN_ASSIGN_REASON_MAX_LENGTH,
  HUMAN_COMMENT_BODY_MAX_LENGTH,
  HUMAN_DEVICE_LABEL_MAX_LENGTH,
  HUMAN_DEVICE_MAX_TTL_MS,
  HUMAN_DEVICE_MIN_TTL_MS,
  HUMAN_DEVICE_TOKEN_PREFIX,
  HUMAN_DISPLAY_NAME_MAX_LENGTH,
  HUMAN_DISPLAY_NAME_MIN_LENGTH,
  HUMAN_MAX_DEVICES_LISTED_PER_PAGE,
  HUMAN_MAX_DEVICES_PER_PRINCIPAL,
  HUMAN_MAX_INVITATIONS_LISTED_PER_PAGE,
  HUMAN_MAX_MEMBERS_LISTED_PER_PAGE,
  HUMAN_MAX_MEMBERS_PER_PROJECT,
  HUMAN_MAX_OPEN_INVITATIONS_PER_PROJECT,
  HUMAN_TOKEN_SECRET_CHAR_LENGTH,
  PROJECT_INVITATION_DEFAULT_TTL_MS,
  PROJECT_INVITATION_MAX_TTL_MS,
  PROJECT_INVITATION_MIN_TTL_MS,
  PROJECT_INVITATION_TOKEN_PREFIX,
  TOKEN_SHA256_HEX_LENGTH
} from "./limits.js";

const timestampSchema = z.iso.datetime();

/** Project-scoped PlanWeave project id (shared opaque form; not a Host id). */
export const humanProjectIdSchema = opaqueIdentifierSchema;
export type HumanProjectId = z.infer<typeof humanProjectIdSchema>;

export const humanPrincipalIdSchema = opaqueIdentifierSchema.brand("HumanPrincipalId");
export type HumanPrincipalId = z.infer<typeof humanPrincipalIdSchema>;

export const humanDeviceCredentialIdSchema =
  opaqueIdentifierSchema.brand("HumanDeviceCredentialId");
export type HumanDeviceCredentialId = z.infer<typeof humanDeviceCredentialIdSchema>;

export const projectMembershipIdSchema = opaqueIdentifierSchema.brand("ProjectMembershipId");
export type ProjectMembershipId = z.infer<typeof projectMembershipIdSchema>;

export const projectInvitationIdSchema = opaqueIdentifierSchema.brand("ProjectInvitationId");
export type ProjectInvitationId = z.infer<typeof projectInvitationIdSchema>;

export const humanDisplayNameSchema = z
  .string()
  .trim()
  .min(HUMAN_DISPLAY_NAME_MIN_LENGTH)
  .max(HUMAN_DISPLAY_NAME_MAX_LENGTH);

export const humanDeviceLabelSchema = z.string().trim().min(1).max(HUMAN_DEVICE_LABEL_MAX_LENGTH);

export const tokenSha256HexSchema = z
  .string()
  .length(TOKEN_SHA256_HEX_LENGTH)
  .regex(/^[a-f0-9]+$/);

/**
 * Human device bearer secret. Distinct from Host (`pw_host_`) and enrollment (`pw_enroll_`) tokens.
 * Plaintext is returned at most once from mint/consume paths; durable storage holds only digests.
 */
export const humanDeviceTokenSchema = z
  .string()
  .regex(
    new RegExp(`^${HUMAN_DEVICE_TOKEN_PREFIX}[A-Za-z0-9_-]{${HUMAN_TOKEN_SECRET_CHAR_LENGTH}}$`)
  );

/**
 * One-time project invitation bearer secret. Distinct from Host and human device tokens.
 */
export const projectInvitationTokenSchema = z
  .string()
  .regex(
    new RegExp(
      `^${PROJECT_INVITATION_TOKEN_PREFIX}[A-Za-z0-9_-]{${HUMAN_TOKEN_SECRET_CHAR_LENGTH}}$`
    )
  );

/** Roles for project membership. Invitations may only grant `member`. */
export const projectMemberRoleSchema = z.enum(["owner", "member"]);
export type ProjectMemberRole = z.infer<typeof projectMemberRoleSchema>;

export const projectInvitationRoleSchema = z.literal("member");
export type ProjectInvitationRole = z.infer<typeof projectInvitationRoleSchema>;

/**
 * Stable human principal. Authentication never treats this alone as proof of access;
 * a valid device credential plus project membership is required for project actions.
 */
export const humanPrincipalSchema = z
  .object({
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: humanDisplayNameSchema,
    createdAt: timestampSchema
  })
  .strict();
export type HumanPrincipal = z.infer<typeof humanPrincipalSchema>;

/**
 * Durable device credential metadata. Token digests only — never plaintext secrets.
 * Devices are owned by a human principal; project access is gated by membership at auth time.
 * `mintedForProjectId` records the project that minted the credential (invite/bootstrap).
 */
export const humanDeviceCredentialMetadataSchema = z
  .object({
    deviceCredentialId: humanDeviceCredentialIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    mintedForProjectId: humanProjectIdSchema,
    label: humanDeviceLabelSchema.optional(),
    tokenSha256: tokenSha256HexSchema,
    createdAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    revokedAt: timestampSchema.optional(),
    lastUsedAt: timestampSchema.optional()
  })
  .strict();
export type HumanDeviceCredentialMetadata = z.infer<typeof humanDeviceCredentialMetadataSchema>;

/**
 * Project membership row. Roles are only `owner` | `member` until a concrete need expands them.
 * Soft-revocation uses `revokedAt`; active membership requires revokedAt unset.
 */
export const projectMembershipSchema = z
  .object({
    membershipId: projectMembershipIdSchema,
    projectId: humanProjectIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    role: projectMemberRoleSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    revokedAt: timestampSchema.optional()
  })
  .strict();
export type ProjectMembership = z.infer<typeof projectMembershipSchema>;

/**
 * Invitation metadata. Secrets are hashed; plaintext returned once at create.
 * Invitations are project-scoped, single-use, expiring, and always grant `member`.
 */
export const projectInvitationMetadataSchema = z
  .object({
    invitationId: projectInvitationIdSchema,
    projectId: humanProjectIdSchema,
    role: projectInvitationRoleSchema,
    createdByHumanPrincipalId: humanPrincipalIdSchema,
    tokenSha256: tokenSha256HexSchema,
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    revokedAt: timestampSchema.optional(),
    consumedAt: timestampSchema.optional(),
    consumedByHumanPrincipalId: humanPrincipalIdSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.consumedAt !== undefined && value.consumedByHumanPrincipalId === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "consumed invitations must record consumedByHumanPrincipalId",
        path: ["consumedByHumanPrincipalId"]
      });
    }
    if (value.consumedByHumanPrincipalId !== undefined && value.consumedAt === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "consumedByHumanPrincipalId requires consumedAt",
        path: ["consumedAt"]
      });
    }
  });
export type ProjectInvitationMetadata = z.infer<typeof projectInvitationMetadataSchema>;

/**
 * Authenticated human subject for authorization. Built only after human device credential
 * verification and active membership resolution. Digests and secrets must not appear here.
 */
export const humanAuthContextSchema = z
  .object({
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: humanDisplayNameSchema,
    deviceCredentialId: humanDeviceCredentialIdSchema,
    projectId: humanProjectIdSchema,
    role: projectMemberRoleSchema,
    membershipId: projectMembershipIdSchema
  })
  .strict();
export type HumanAuthContext = z.infer<typeof humanAuthContextSchema>;

/**
 * Local administrative proof for owner bootstrap. Not a network bearer and not a Host credential.
 * Issuance and verification of the proof transport are outside this pure model; the schema
 * records only the validated command payload after a local admin boundary accepts it.
 */
export const localAdministrativeProofSchema = z
  .object({
    kind: z.literal("local_administrative_proof"),
    projectId: humanProjectIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: humanDisplayNameSchema,
    issuedAt: timestampSchema
  })
  .strict();
export type LocalAdministrativeProof = z.infer<typeof localAdministrativeProofSchema>;

/**
 * Narrow display projection for activity/assignment UI. Never used for authentication
 * or authorization decisions — those require concrete subject types.
 */
export const actorRefSchema = z
  .object({
    kind: z.enum(["human", "local_admin", "system"]),
    id: opaqueIdentifierSchema,
    displayName: humanDisplayNameSchema.optional()
  })
  .strict();
export type ActorRef = z.infer<typeof actorRefSchema>;

/**
 * Project-scoped collaboration actions authorized by the centralized policy table.
 * Route handlers must call policy with one of these names instead of ad-hoc role checks.
 */
export const projectScopedActionSchema = z.enum([
  "bootstrap_owner",
  "view_project",
  "view_members",
  "create_invitation",
  "revoke_invitation",
  "join_project",
  "list_own_devices",
  "list_project_devices",
  "revoke_own_device",
  "revoke_member_device",
  "remove_member",
  "promote_owner",
  "demote_owner",
  "assign_work",
  "comment",
  "view_activity",
  "remote_run_control"
]);
export type ProjectScopedAction = z.infer<typeof projectScopedActionSchema>;

export const humanCommentBodySchema = z.string().min(1).max(HUMAN_COMMENT_BODY_MAX_LENGTH);
export const humanAssignReasonSchema = z.string().min(1).max(HUMAN_ASSIGN_REASON_MAX_LENGTH);

export const humanPaginationLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(HUMAN_MAX_MEMBERS_LISTED_PER_PAGE);

export const humanDeviceListLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(HUMAN_MAX_DEVICES_LISTED_PER_PAGE);

export const humanInvitationListLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(HUMAN_MAX_INVITATIONS_LISTED_PER_PAGE);

/** Invitation create request bounds (TTL only; service applies defaults). */
export const projectInvitationTtlMsSchema = z
  .number()
  .int()
  .min(PROJECT_INVITATION_MIN_TTL_MS)
  .max(PROJECT_INVITATION_MAX_TTL_MS)
  .default(PROJECT_INVITATION_DEFAULT_TTL_MS);

export const humanDeviceTtlMsSchema = z
  .number()
  .int()
  .min(HUMAN_DEVICE_MIN_TTL_MS)
  .max(HUMAN_DEVICE_MAX_TTL_MS);

export const humanCountLimits = {
  maxMembersPerProject: HUMAN_MAX_MEMBERS_PER_PROJECT,
  maxOpenInvitationsPerProject: HUMAN_MAX_OPEN_INVITATIONS_PER_PROJECT,
  maxDevicesPerPrincipal: HUMAN_MAX_DEVICES_PER_PRINCIPAL
} as const;

export function actorRefFromHuman(context: HumanAuthContext): ActorRef {
  return actorRefSchema.parse({
    kind: "human",
    id: context.humanPrincipalId,
    displayName: context.displayName
  });
}

export function actorRefFromLocalAdmin(proof: LocalAdministrativeProof): ActorRef {
  return actorRefSchema.parse({
    kind: "local_admin",
    id: proof.humanPrincipalId,
    displayName: proof.displayName
  });
}

export type InvitationUsability =
  | { usable: true }
  | {
      usable: false;
      code:
        | "human_invitation_expired"
        | "human_invitation_revoked"
        | "human_invitation_consumed"
        | "human_invitation_role_forbidden"
        | "human_cross_project_forbidden";
    };

/**
 * Pure invitation usability check. Does not authenticate the bearer secret;
 * callers compare digests in constant time before invoking this helper.
 */
export function evaluateInvitationUsability(input: {
  invitation: ProjectInvitationMetadata;
  projectId: string;
  now: Date;
}): InvitationUsability {
  const { invitation, projectId, now } = input;
  if (invitation.projectId !== projectId) {
    return { usable: false, code: "human_cross_project_forbidden" };
  }
  if (invitation.role !== "member") {
    return { usable: false, code: "human_invitation_role_forbidden" };
  }
  if (invitation.revokedAt !== undefined) {
    return { usable: false, code: "human_invitation_revoked" };
  }
  if (invitation.consumedAt !== undefined) {
    return { usable: false, code: "human_invitation_consumed" };
  }
  if (Date.parse(invitation.expiresAt) <= now.getTime()) {
    return { usable: false, code: "human_invitation_expired" };
  }
  return { usable: true };
}

export type DeviceUsability =
  | { usable: true }
  | {
      usable: false;
      code: "human_device_revoked" | "human_device_expired" | "human_device_not_owner";
    };

/**
 * Pure device usability for a known principal. Digest comparison is the caller's duty.
 */
export function evaluateDeviceUsability(input: {
  device: HumanDeviceCredentialMetadata;
  humanPrincipalId: string;
  now: Date;
}): DeviceUsability {
  const { device, humanPrincipalId, now } = input;
  if (device.humanPrincipalId !== humanPrincipalId) {
    return { usable: false, code: "human_device_not_owner" };
  }
  if (device.revokedAt !== undefined) {
    return { usable: false, code: "human_device_revoked" };
  }
  if (device.expiresAt !== undefined && Date.parse(device.expiresAt) <= now.getTime()) {
    return { usable: false, code: "human_device_expired" };
  }
  return { usable: true };
}

export function isActiveMembership(membership: ProjectMembership): boolean {
  return membership.revokedAt === undefined;
}

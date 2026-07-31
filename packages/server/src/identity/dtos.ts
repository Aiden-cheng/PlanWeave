import { z } from "zod";
import {
  agentHostIdentityViewSchema,
  identityMigrationStateSchema,
  workspaceHumanPrincipalViewSchema,
  workspaceIdentityViewSchema,
  workspaceMembershipViewSchema
} from "@planweave-ai/collaboration-contracts";
export {
  humanRevokeInvitationsRequestSchema,
  humanRevokeInvitationsResponseSchema
} from "@planweave-ai/collaboration-contracts";
export type {
  HumanRevokeInvitationsRequest,
  HumanRevokeInvitationsResponse
} from "@planweave-ai/collaboration-contracts";
import {
  HUMAN_DEVICE_LABEL_MAX_LENGTH,
  HUMAN_DISPLAY_NAME_MAX_LENGTH,
  HUMAN_DISPLAY_NAME_MIN_LENGTH,
  HUMAN_MAX_DEVICES_LISTED_PER_PAGE,
  HUMAN_MAX_INVITATIONS_LISTED_PER_PAGE,
  HUMAN_MAX_MEMBERS_LISTED_PER_PAGE
} from "./limits.js";
import {
  humanDeviceCredentialIdSchema,
  humanDeviceLabelSchema,
  humanDeviceTokenSchema,
  humanDeviceTtlMsSchema,
  humanDisplayNameSchema,
  humanPrincipalIdSchema,
  humanProjectIdSchema,
  projectInvitationIdSchema,
  projectInvitationTokenSchema,
  projectInvitationTtlMsSchema,
  projectMemberRoleSchema,
  projectMembershipIdSchema,
  type HumanDeviceCredentialMetadata,
  type HumanPrincipal,
  type ProjectInvitationMetadata,
  type ProjectMembership
} from "./schemas.js";

const timestampSchema = z.iso.datetime();

/** Redacted, workspace-authoritative identity read model for trusted Server clients. */
export const workspaceIdentityReadModelSchema = z
  .object({
    schemaVersion: z.literal("workspace-identity/v1"),
    workspace: workspaceIdentityViewSchema,
    principals: z.array(workspaceHumanPrincipalViewSchema).max(1_000),
    memberships: z.array(workspaceMembershipViewSchema).max(1_000),
    hosts: z.array(agentHostIdentityViewSchema).max(1_000),
    migration: identityMigrationStateSchema
  })
  .strict();
export type WorkspaceIdentityReadModel = z.infer<typeof workspaceIdentityReadModelSchema>;

/**
 * Bounded display projections for human membership HTTP APIs.
 * Never include token digests, plaintext secrets (except one-shot mint fields),
 * Host credentials, SQL rows, or internal filesystem paths.
 */

export const humanPrincipalViewSchema = z
  .object({
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: humanDisplayNameSchema,
    createdAt: timestampSchema
  })
  .strict();
export type HumanPrincipalView = z.infer<typeof humanPrincipalViewSchema>;

export const humanMembershipViewSchema = z
  .object({
    membershipId: projectMembershipIdSchema,
    projectId: humanProjectIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: z.string().min(HUMAN_DISPLAY_NAME_MIN_LENGTH).max(HUMAN_DISPLAY_NAME_MAX_LENGTH),
    role: projectMemberRoleSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .strict();
export type HumanMembershipView = z.infer<typeof humanMembershipViewSchema>;

export const humanDeviceViewSchema = z
  .object({
    deviceCredentialId: humanDeviceCredentialIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    mintedForProjectId: humanProjectIdSchema,
    label: z.string().min(1).max(HUMAN_DEVICE_LABEL_MAX_LENGTH).optional(),
    createdAt: timestampSchema,
    expiresAt: timestampSchema.optional(),
    revokedAt: timestampSchema.optional(),
    lastUsedAt: timestampSchema.optional()
  })
  .strict();
export type HumanDeviceView = z.infer<typeof humanDeviceViewSchema>;

export const humanInvitationViewSchema = z
  .object({
    invitationId: projectInvitationIdSchema,
    projectId: humanProjectIdSchema,
    role: z.literal("member"),
    createdByHumanPrincipalId: humanPrincipalIdSchema,
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    revokedAt: timestampSchema.optional(),
    consumedAt: timestampSchema.optional()
  })
  .strict();
export type HumanInvitationView = z.infer<typeof humanInvitationViewSchema>;

export const humanMemberPageSchema = z
  .object({
    items: z.array(humanMembershipViewSchema).max(HUMAN_MAX_MEMBERS_LISTED_PER_PAGE),
    nextCursor: z.number().int().nonnegative().nullable()
  })
  .strict();

export const humanDevicePageSchema = z
  .object({
    items: z.array(humanDeviceViewSchema).max(HUMAN_MAX_DEVICES_LISTED_PER_PAGE),
    nextCursor: z.number().int().nonnegative().nullable()
  })
  .strict();

export const humanInvitationPageSchema = z
  .object({
    items: z.array(humanInvitationViewSchema).max(HUMAN_MAX_INVITATIONS_LISTED_PER_PAGE),
    nextCursor: z.number().int().nonnegative().nullable()
  })
  .strict();

/**
 * One-shot device token handoff for Desktop (and other trusted clients).
 *
 * Contract (renderer persistence intentionally not implemented here):
 * - Bootstrap / invitation-consume responses may include `deviceToken` exactly once.
 * - Desktop main process should accept the token from the HTTP JSON body and store it in
 *   OS-backed secure storage (e.g. Electron safeStorage / keychain), never in renderer
 *   localStorage, package files, or syncable plain-text config.
 * - Later requests send `Authorization: Bearer <deviceToken>` only — never cookies.
 * - Cookie-based CSRF does not apply because tokens are not cookie-bound; clients still
 *   use `Content-Type: application/json` for mutations so cross-origin form posts cannot
 *   silently drive state changes without CORS preflight.
 */
export const humanDeviceTokenHandoffSchema = z
  .object({
    deviceToken: humanDeviceTokenSchema,
    deviceCredentialId: humanDeviceCredentialIdSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    projectId: humanProjectIdSchema,
    expiresAt: timestampSchema.optional()
  })
  .strict();
export type HumanDeviceTokenHandoff = z.infer<typeof humanDeviceTokenHandoffSchema>;

export const humanBootstrapRequestSchema = z
  .object({
    displayName: humanDisplayNameSchema,
    humanPrincipalId: humanPrincipalIdSchema.optional(),
    deviceLabel: humanDeviceLabelSchema.optional(),
    deviceTtlMs: humanDeviceTtlMsSchema.optional()
  })
  .strict();

export const humanBootstrapResponseSchema = z
  .object({
    principal: humanPrincipalViewSchema,
    membership: humanMembershipViewSchema.omit({ displayName: true }).extend({
      displayName: humanDisplayNameSchema
    }),
    device: humanDeviceViewSchema,
    deviceToken: humanDeviceTokenSchema.optional(),
    created: z.boolean()
  })
  .strict();

export const humanCreateInvitationRequestSchema = z
  .object({
    ttlMs: projectInvitationTtlMsSchema.optional()
  })
  .strict();

export const humanCreateInvitationResponseSchema = z
  .object({
    invitation: humanInvitationViewSchema,
    invitationToken: projectInvitationTokenSchema
  })
  .strict();

export const humanConsumeInvitationRequestSchema = z
  .object({
    invitationToken: projectInvitationTokenSchema,
    displayName: humanDisplayNameSchema,
    deviceLabel: humanDeviceLabelSchema.optional(),
    deviceTtlMs: humanDeviceTtlMsSchema.optional(),
    existingDeviceToken: humanDeviceTokenSchema.optional()
  })
  .strict();

export const humanConsumeInvitationResponseSchema = z
  .object({
    principal: humanPrincipalViewSchema,
    membership: humanMembershipViewSchema,
    device: humanDeviceViewSchema,
    deviceToken: humanDeviceTokenSchema,
    invitation: humanInvitationViewSchema,
    principalCreated: z.boolean()
  })
  .strict();

export const humanPageQuerySchema = z
  .object({
    cursor: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50)
  })
  .strict();

export const humanInvitationListQuerySchema = z
  .object({
    cursor: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    openOnly: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .optional()
      .transform((value) => {
        if (value === undefined) return true;
        if (typeof value === "boolean") return value;
        return value !== "false";
      })
  })
  .strict();

export const humanDeviceListQuerySchema = z
  .object({
    cursor: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    scope: z.enum(["own", "project"]).default("own")
  })
  .strict();

export function toPrincipalView(principal: HumanPrincipal): HumanPrincipalView {
  return humanPrincipalViewSchema.parse({
    humanPrincipalId: principal.humanPrincipalId,
    displayName: principal.displayName,
    createdAt: principal.createdAt
  });
}

export function toMembershipView(
  membership: ProjectMembership,
  displayName: string
): HumanMembershipView {
  return humanMembershipViewSchema.parse({
    membershipId: membership.membershipId,
    projectId: membership.projectId,
    humanPrincipalId: membership.humanPrincipalId,
    displayName,
    role: membership.role,
    createdAt: membership.createdAt,
    updatedAt: membership.updatedAt
  });
}

export function toDeviceView(device: HumanDeviceCredentialMetadata): HumanDeviceView {
  return humanDeviceViewSchema.parse({
    deviceCredentialId: device.deviceCredentialId,
    humanPrincipalId: device.humanPrincipalId,
    mintedForProjectId: device.mintedForProjectId,
    label: device.label,
    createdAt: device.createdAt,
    expiresAt: device.expiresAt,
    revokedAt: device.revokedAt,
    lastUsedAt: device.lastUsedAt
  });
}

export function toInvitationView(invitation: ProjectInvitationMetadata): HumanInvitationView {
  return humanInvitationViewSchema.parse({
    invitationId: invitation.invitationId,
    projectId: invitation.projectId,
    role: invitation.role,
    createdByHumanPrincipalId: invitation.createdByHumanPrincipalId,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    revokedAt: invitation.revokedAt,
    consumedAt: invitation.consumedAt
  });
}

/** Ensures serialized HTTP bodies never leak digests from domain objects. */
export function assertHumanDisplayDtoRedacted(value: unknown): void {
  const text = JSON.stringify(value);
  if (text.includes("tokenSha256") || text.includes("token_sha256")) {
    throw new Error("human_dto_digest_leak");
  }
}

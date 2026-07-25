import { z } from "zod";
import {
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
  timestampSchema
} from "./primitives.js";

/** Public principal view — never digests or secrets. */
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
    displayName: humanDisplayNameSchema,
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
    label: z.string().min(1).max(64).optional(),
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
export type HumanMemberPage = z.infer<typeof humanMemberPageSchema>;

export const humanDevicePageSchema = z
  .object({
    items: z.array(humanDeviceViewSchema).max(HUMAN_MAX_DEVICES_LISTED_PER_PAGE),
    nextCursor: z.number().int().nonnegative().nullable()
  })
  .strict();
export type HumanDevicePage = z.infer<typeof humanDevicePageSchema>;

export const humanInvitationPageSchema = z
  .object({
    items: z.array(humanInvitationViewSchema).max(HUMAN_MAX_INVITATIONS_LISTED_PER_PAGE),
    nextCursor: z.number().int().nonnegative().nullable()
  })
  .strict();
export type HumanInvitationPage = z.infer<typeof humanInvitationPageSchema>;

export const humanBootstrapRequestSchema = z
  .object({
    displayName: humanDisplayNameSchema,
    humanPrincipalId: humanPrincipalIdSchema.optional(),
    deviceLabel: humanDeviceLabelSchema.optional(),
    deviceTtlMs: humanDeviceTtlMsSchema.optional()
  })
  .strict();
export type HumanBootstrapRequest = z.infer<typeof humanBootstrapRequestSchema>;

export const humanBootstrapResponseSchema = z
  .object({
    principal: humanPrincipalViewSchema,
    membership: humanMembershipViewSchema,
    device: humanDeviceViewSchema,
    deviceToken: humanDeviceTokenSchema.optional(),
    created: z.boolean()
  })
  .strict();
export type HumanBootstrapResponse = z.infer<typeof humanBootstrapResponseSchema>;

export const humanCreateInvitationRequestSchema = z
  .object({
    ttlMs: projectInvitationTtlMsSchema.optional()
  })
  .strict();
export type HumanCreateInvitationRequest = z.infer<typeof humanCreateInvitationRequestSchema>;

export const humanCreateInvitationResponseSchema = z
  .object({
    invitation: humanInvitationViewSchema,
    invitationToken: projectInvitationTokenSchema
  })
  .strict();
export type HumanCreateInvitationResponse = z.infer<typeof humanCreateInvitationResponseSchema>;

export const humanConsumeInvitationRequestSchema = z
  .object({
    invitationToken: projectInvitationTokenSchema,
    displayName: humanDisplayNameSchema,
    deviceLabel: humanDeviceLabelSchema.optional(),
    deviceTtlMs: humanDeviceTtlMsSchema.optional(),
    existingDeviceToken: humanDeviceTokenSchema.optional()
  })
  .strict();
export type HumanConsumeInvitationRequest = z.infer<typeof humanConsumeInvitationRequestSchema>;

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
export type HumanConsumeInvitationResponse = z.infer<typeof humanConsumeInvitationResponseSchema>;

export const humanPageQuerySchema = z
  .object({
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50)
  })
  .strict();
export type HumanPageQuery = z.infer<typeof humanPageQuerySchema>;

export const humanInvitationListQuerySchema = z
  .object({
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50),
    openOnly: z.boolean().optional()
  })
  .strict();
export type HumanInvitationListQuery = z.infer<typeof humanInvitationListQuerySchema>;

export const humanDeviceListQuerySchema = z
  .object({
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(50),
    scope: z.enum(["own", "project"]).default("own")
  })
  .strict();
export type HumanDeviceListQuery = z.infer<typeof humanDeviceListQuerySchema>;

/** Ensures serialized bodies never leak digests. */
export function assertHumanDisplayDtoRedacted(value: unknown): void {
  const text = JSON.stringify(value);
  if (text.includes("tokenSha256") || text.includes("token_sha256")) {
    throw new Error("human_dto_digest_leak");
  }
}

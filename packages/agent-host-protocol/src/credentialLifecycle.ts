import { z } from "zod";
import { hostCredentialTokenSchema } from "./agentHostCredentials.js";
import { opaqueIdentifierSchema } from "./identifiers.js";

export const HOST_CREDENTIAL_LIFETIME_DAY_OPTIONS = [30, 90, 180, 365] as const;
export const DEFAULT_HOST_CREDENTIAL_LIFETIME_DAYS = 180 as const;
export const HOST_CREDENTIAL_PREVIOUS_TOKEN_GRACE_MS = 10 * 60_000;

export const hostCredentialLifetimeDaysSchema = z.union([
  z.literal(30),
  z.literal(90),
  z.literal(180),
  z.literal(365)
]);

/** Operator-selected policy for one Host credential generation. */
export const hostCredentialPolicySchema = z
  .object({
    lifetimeDays: hostCredentialLifetimeDaysSchema,
    renewal: z.literal("automatic")
  })
  .strict();

export const hostCredentialRenewalStatusSchema = z
  .object({
    hostId: opaqueIdentifierSchema,
    credentialExpiresAt: z.string().datetime(),
    policy: hostCredentialPolicySchema,
    renewalRequestedAt: z.string().datetime().optional(),
    serverTime: z.string().datetime()
  })
  .strict();

export const hostCredentialRotationRequestSchema = z
  .object({
    rotationId: opaqueIdentifierSchema,
    nextCredentialToken: hostCredentialTokenSchema
  })
  .strict();

export const hostCredentialRotationResponseSchema = z
  .object({
    hostId: opaqueIdentifierSchema,
    rotationId: opaqueIdentifierSchema,
    credentialExpiresAt: z.string().datetime()
  })
  .strict();

export const hostCredentialRenewalErrorCodeSchema = z.enum([
  "credential_rejected",
  "credential_expired",
  "renewal_not_configured",
  "rotation_conflict",
  "insecure_transport",
  "malformed"
]);

export const hostCredentialRenewalErrorSchema = z
  .object({
    error: hostCredentialRenewalErrorCodeSchema
  })
  .strict();

export type HostCredentialLifetimeDays = z.infer<typeof hostCredentialLifetimeDaysSchema>;
export type HostCredentialPolicy = z.infer<typeof hostCredentialPolicySchema>;
export type HostCredentialRenewalStatus = z.infer<typeof hostCredentialRenewalStatusSchema>;
export type HostCredentialRotationRequest = z.infer<typeof hostCredentialRotationRequestSchema>;
export type HostCredentialRotationResponse = z.infer<typeof hostCredentialRotationResponseSchema>;
export type HostCredentialRenewalErrorCode = z.infer<typeof hostCredentialRenewalErrorCodeSchema>;

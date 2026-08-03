import {
  hostCredentialTokenSchema,
  hostEnrollmentCodeSchema,
  opaqueIdentifierSchema
} from "@planweave-ai/agent-host-protocol";
import { setupCodeTokenSchema } from "@planweave-ai/collaboration-protocol";
import { z } from "zod";

const pendingBase = {
  enrollmentAttemptId: opaqueIdentifierSchema,
  credentialToken: hostCredentialTokenSchema,
  createdAt: z.string().datetime()
} as const;

export const pendingHostEnrollmentSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...pendingBase,
      kind: z.literal("host_enrollment_code"),
      enrollmentCode: hostEnrollmentCodeSchema
    })
    .strict(),
  z
    .object({
      ...pendingBase,
      kind: z.literal("setup_code"),
      setupCode: setupCodeTokenSchema
    })
    .strict()
]);

export const activeHostCredentialSchema = z
  .object({
    hostId: opaqueIdentifierSchema,
    workspaceId: opaqueIdentifierSchema,
    credentialToken: hostCredentialTokenSchema,
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    revokedAt: z.string().datetime().optional()
  })
  .strict();

export const hostCredentialDocumentSchema = z
  .object({
    version: z.literal("agent-host-credentials/v1"),
    active: activeHostCredentialSchema.optional(),
    pending: pendingHostEnrollmentSchema.optional()
  })
  .strict()
  .refine(
    (value) => value.active !== undefined || value.pending !== undefined,
    "Credential document must contain active or pending state."
  );

export type PendingHostEnrollment = z.infer<typeof pendingHostEnrollmentSchema>;
export type ActiveHostCredential = z.infer<typeof activeHostCredentialSchema>;
export type HostCredentialDocument = z.infer<typeof hostCredentialDocumentSchema>;

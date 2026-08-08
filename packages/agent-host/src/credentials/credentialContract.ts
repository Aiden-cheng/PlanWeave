import {
  hostCredentialTokenSchema,
  hostEnrollmentCodeSchema,
  opaqueIdentifierSchema
} from "@planweave-ai/agent-host-protocol";
import { setupCodeTokenSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { z } from "zod";
import {
  activePortableHandoffProvenanceSchema,
  pendingPortableHandoffProvenanceSchema
} from "./handoffProvenance.js";

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
      enrollmentCode: hostEnrollmentCodeSchema,
      provenance: pendingPortableHandoffProvenanceSchema.optional()
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
    /** Absent for server-scoped fleet enrollment without a collaboration workspace binding. */
    workspaceId: opaqueIdentifierSchema.optional(),
    credentialToken: hostCredentialTokenSchema,
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    revokedAt: z.string().datetime().optional(),
    provenance: activePortableHandoffProvenanceSchema.optional()
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

/** Stable per-host instance key for background services and durable identity when workspace scope is absent. */
export function credentialInstanceId(
  credential: Pick<ActiveHostCredential, "hostId" | "workspaceId">
): string {
  return credential.workspaceId ?? credential.hostId;
}

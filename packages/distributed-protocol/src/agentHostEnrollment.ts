import { z } from "zod";
import { capabilitiesSchema } from "./capabilities.js";
import { hostCapacitySchema } from "./agentHostProtocol.js";
import { opaqueIdentifierSchema } from "./identifiers.js";
import { agentHostProtocolVersionSchema } from "./version.js";

export const HOST_DISPLAY_NAME_MAX_LENGTH = 128 as const;
export const hostEnrollmentCodeSchema = z.string().regex(/^pw_enroll_[A-Za-z0-9_-]{43}$/);
export const hostCredentialTokenSchema = z.string().regex(/^pw_host_[A-Za-z0-9_-]{43}$/);

const versioned = z.object({ protocolVersion: agentHostProtocolVersionSchema }).strict();

export const hostEnrollmentRequestSchema = versioned.extend({
  type: z.literal("host.enrollment.request"),
  enrollmentCode: hostEnrollmentCodeSchema,
  enrollmentAttemptId: opaqueIdentifierSchema,
  credentialToken: hostCredentialTokenSchema,
  displayName: z.string().trim().min(1).max(HOST_DISPLAY_NAME_MAX_LENGTH),
  capabilities: capabilitiesSchema,
  capacity: hostCapacitySchema
});

export const hostEnrollmentCompletedSchema = versioned.extend({
  type: z.literal("host.enrollment.completed"),
  enrollmentAttemptId: opaqueIdentifierSchema,
  hostId: opaqueIdentifierSchema,
  credentialExpiresAt: z.string().datetime()
});

export const hostEnrollmentErrorCodeSchema = z.enum([
  "invalid",
  "expired",
  "revoked",
  "conflict",
  "insecure_transport",
  "malformed"
]);

export const hostEnrollmentErrorSchema = versioned.extend({
  type: z.literal("host.enrollment.error"),
  code: hostEnrollmentErrorCodeSchema,
  message: z.string().min(1).max(256),
  retryable: z.literal(false)
});

export type HostEnrollmentRequest = z.infer<typeof hostEnrollmentRequestSchema>;
export type HostEnrollmentCompleted = z.infer<typeof hostEnrollmentCompletedSchema>;
export type HostEnrollmentError = z.infer<typeof hostEnrollmentErrorSchema>;
export type HostEnrollmentErrorCode = z.infer<typeof hostEnrollmentErrorCodeSchema>;

import { z } from "zod";
import { capabilitiesSchema } from "./capabilities.js";
import { hostEnrollmentCodeSchema } from "./agentHostEnrollment.js";
import { opaqueIdentifierSchema } from "./identifiers.js";

/** Bounded operator credential accepted by Server and held only by Desktop main. */
export const operatorTokenSchema = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);

const timestampSchema = z.iso.datetime();

/** Shared pagination contract for bounded operator collection endpoints. */
export const operatorPageQuerySchema = z
  .object({
    cursor: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50)
  })
  .strict();

export const operatorEnrollmentGrantRequestSchema = z
  .object({
    expiresAt: timestampSchema,
    credentialExpiresAt: timestampSchema
  })
  .strict();

export const operatorEnrollmentGrantResponseSchema = z
  .object({
    enrollmentCode: hostEnrollmentCodeSchema,
    expiresAt: timestampSchema
  })
  .strict();

export const operatorHostViewSchema = z
  .object({
    id: opaqueIdentifierSchema,
    displayName: z.string().min(1).max(128),
    capabilities: capabilitiesSchema,
    capacity: z.number().int().min(1).max(128),
    online: z.boolean(),
    lastSeenAt: timestampSchema.optional(),
    revokedAt: timestampSchema.optional(),
    credentialExpiresAt: timestampSchema.optional()
  })
  .strict();

export const operatorHostPageSchema = z
  .object({
    items: z.array(operatorHostViewSchema).max(100),
    nextCursor: z.number().int().positive().nullable()
  })
  .strict();

/** Revoke returns the same redacted Host projection as GET /hosts/:hostId. */
export const operatorHostRevokeResponseSchema = operatorHostViewSchema;

export type OperatorEnrollmentGrantRequest = z.infer<typeof operatorEnrollmentGrantRequestSchema>;
export type OperatorEnrollmentGrantResponse = z.infer<typeof operatorEnrollmentGrantResponseSchema>;
export type OperatorHostView = z.infer<typeof operatorHostViewSchema>;
export type OperatorHostPage = z.infer<typeof operatorHostPageSchema>;
export type OperatorPageQuery = z.infer<typeof operatorPageQuerySchema>;

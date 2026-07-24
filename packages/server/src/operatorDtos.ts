import {
  ACP_EVENT_BATCH_MAX_COUNT,
  acpEventCursorSchema,
  blockRefSchema,
  capabilitiesSchema,
  dispatchIdSchema,
  executionAttemptIdSchema,
  interactionRequestSchema,
  interactionSettlementSchema,
  leaseIdSchema,
  normalizedAcpEventSchema,
  opaqueIdentifierSchema
} from "@planweave-ai/distributed-protocol";
import { remoteBlockBindingViewSchema } from "@planweave-ai/runtime";
import { z } from "zod";
import { dispatchStatusSchema } from "./dispatches.js";
import {
  remoteExecutionActionRequestSchema,
  remoteExecutionActionStateSchema
} from "./remoteExecutionLifecycle.js";
import { remoteAttemptStatusSchema, remoteOperationStateSchema } from "./remoteOperations.js";

const timestampSchema = z.iso.datetime();

export const operatorEnrollmentGrantRequestSchema = z
  .object({ expiresAt: timestampSchema, credentialExpiresAt: timestampSchema })
  .strict();

export const operatorEnrollmentGrantResponseSchema = z
  .object({ enrollmentCode: z.string().min(1).max(256), expiresAt: timestampSchema })
  .strict();

export const operatorDispatchRequestSchema = z
  .object({
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema,
    blockRef: blockRefSchema,
    idempotencyKey: z.string().min(1).max(256),
    /** Optional exact Host request; revalidated against assignment + live capacity. */
    requestedHostId: opaqueIdentifierSchema.optional(),
    /**
     * Explicit permission to dispatch human/unassigned Blocks.
     * When omitted, the assignment gate uses its composition default (operator-compatible true).
     */
    allowHumanOverride: z.boolean().optional(),
    /** Optional assignment revision fingerprint for concurrent reassignment safety. */
    expectedAssignmentRevision: z.number().int().nonnegative().optional()
  })
  .strict();

export const operatorActionRequestSchema = remoteExecutionActionRequestSchema;
export const operatorInteractionResponseSchema = interactionSettlementSchema;

export const operatorEventQuerySchema = z
  .object({ afterCursor: z.coerce.number().int().nonnegative().default(0) })
  .strict();

export const operatorPageQuerySchema = z
  .object({
    cursor: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50)
  })
  .strict();

export const operatorHostViewSchema = z
  .object({
    id: opaqueIdentifierSchema,
    displayName: z.string().min(1).max(128),
    capabilities: capabilitiesSchema,
    capacity: z.number().int().min(1).max(128),
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

const operatorAttemptViewSchema = z
  .object({
    executionAttemptId: executionAttemptIdSchema,
    dispatchId: dispatchIdSchema,
    status: remoteAttemptStatusSchema,
    hostId: opaqueIdentifierSchema.optional(),
    leaseId: leaseIdSchema.optional(),
    leaseExpiresAt: timestampSchema.optional(),
    stateVersion: z.number().int().nonnegative()
  })
  .strict();

export const operatorOperationViewSchema = z
  .object({
    operationId: opaqueIdentifierSchema,
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema,
    blockRef: blockRefSchema,
    state: remoteOperationStateSchema,
    dispatchId: dispatchIdSchema,
    executionAttemptId: executionAttemptIdSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    terminalAt: timestampSchema.optional(),
    attempt: operatorAttemptViewSchema,
    dispatchStatus: dispatchStatusSchema.optional(),
    runtime: remoteBlockBindingViewSchema
  })
  .strict();

export const operatorActionViewSchema = z
  .object({
    request: operatorActionRequestSchema,
    state: remoteExecutionActionStateSchema,
    createdAt: timestampSchema,
    deliveredAt: timestampSchema.optional(),
    acknowledgedAt: timestampSchema.optional(),
    settledAt: timestampSchema.optional()
  })
  .strict();

export const operatorEventReplaySchema = z
  .object({
    executionAttemptId: opaqueIdentifierSchema,
    afterCursor: acpEventCursorSchema,
    cursor: acpEventCursorSchema,
    highWatermark: acpEventCursorSchema,
    hasMore: z.boolean(),
    events: z.array(normalizedAcpEventSchema).max(ACP_EVENT_BATCH_MAX_COUNT),
    diagnostics: z
      .array(
        z
          .object({
            code: z.literal("remote_acp_event_retention_gap"),
            droppedThroughCursor: z.number().int().positive()
          })
          .strict()
      )
      .max(1)
  })
  .strict();

export const operatorInteractionViewSchema = z
  .object({
    request: interactionRequestSchema,
    operationId: opaqueIdentifierSchema,
    hostId: opaqueIdentifierSchema,
    status: z.enum(["pending", "settled", "expired"]),
    createdAt: timestampSchema,
    settlement: interactionSettlementSchema.optional(),
    settledBy: opaqueIdentifierSchema.optional(),
    settledAt: timestampSchema.optional()
  })
  .strict();

export const operatorInteractionPageSchema = z
  .object({
    items: z.array(operatorInteractionViewSchema).max(100),
    nextCursor: z.number().int().positive().nullable()
  })
  .strict();

export type OperatorEnrollmentGrantRequest = z.infer<typeof operatorEnrollmentGrantRequestSchema>;
export type OperatorDispatchRequest = z.infer<typeof operatorDispatchRequestSchema>;
export type OperatorActionRequest = z.infer<typeof operatorActionRequestSchema>;
export type OperatorInteractionResponse = z.infer<typeof operatorInteractionResponseSchema>;
export type OperatorOperationView = z.infer<typeof operatorOperationViewSchema>;

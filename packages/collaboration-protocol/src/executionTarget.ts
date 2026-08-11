import { blockRefSchema, opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol/browser";
import { z } from "zod";
import { COLLABORATION_REASON_MAX_LENGTH, COLLABORATION_REVISION_MAX } from "./limits.js";
import { timestampSchema, workspaceIdSchema } from "./primitives.js";

export const executionTargetSchemaVersion = "execution-target/v1" as const;
export const executionTargetSchemaVersionSchema = z.literal(executionTargetSchemaVersion);
export type ExecutionTargetSchemaVersion = z.infer<typeof executionTargetSchemaVersionSchema>;

/** Host execution is a Block operation; Task/Project/Canvas scopes are invalid. */
export const exactBlockExecutionScopeSchema = z
  .object({
    kind: z.literal("block"),
    workspaceId: workspaceIdSchema,
    projectId: opaqueIdentifierSchema,
    canvasId: opaqueIdentifierSchema,
    blockRef: blockRefSchema
  })
  .strict();
export type ExactBlockExecutionScope = z.infer<typeof exactBlockExecutionScopeSchema>;
export const executionTargetScopeSchema = exactBlockExecutionScopeSchema;

/**
 * Legacy Host target parser retained for stored-record reads and assignment migration.
 * @deprecated New dispatch writes select an Agent Endpoint instead of a Host target.
 */
export const executionTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unassigned") }).strict(),
  z.object({ kind: z.literal("exact_host"), hostId: opaqueIdentifierSchema }).strict(),
  z.object({ kind: z.literal("automatic_host") }).strict()
]);
/** @deprecated Use only for legacy stored-record reads, migration, or rejection boundaries. */
export type ExecutionTarget = z.infer<typeof executionTargetSchema>;
/** @deprecated Use only for legacy stored-record reads, migration, or rejection boundaries. */
export const executionTargetUnionSchema = executionTargetSchema;

const targetRevisionSchema = z.number().int().nonnegative().max(COLLABORATION_REVISION_MAX);
const storedTargetRevisionSchema = targetRevisionSchema.min(1);

export const executionTargetRecordSchema = z
  .object({
    schemaVersion: executionTargetSchemaVersionSchema,
    scope: exactBlockExecutionScopeSchema,
    target: executionTargetSchema,
    revision: storedTargetRevisionSchema,
    updatedAt: timestampSchema
  })
  .strict();
export type ExecutionTargetRecord = z.infer<typeof executionTargetRecordSchema>;
export const executionTargetAssignmentSchema = executionTargetRecordSchema;

/**
 * Legacy Host-target write shape retained so Server boundaries can parse and reject it explicitly.
 * @deprecated New dispatch writes select an Agent Endpoint and must not emit this intent.
 */
export const executionTargetUpdateIntentSchema = z
  .object({
    schemaVersion: executionTargetSchemaVersionSchema,
    scope: exactBlockExecutionScopeSchema,
    target: executionTargetSchema,
    expectedRevision: targetRevisionSchema,
    reason: z.string().trim().min(1).max(COLLABORATION_REASON_MAX_LENGTH).optional()
  })
  .strict();
/** @deprecated Retained only for the legacy Host-target rejection boundary. */
export type ExecutionTargetUpdateIntent = z.infer<typeof executionTargetUpdateIntentSchema>;
/** @deprecated Retained only for the legacy Host-target rejection boundary. */
export const executionTargetUpdateWireCommandSchema = executionTargetUpdateIntentSchema;
/** @deprecated Retained only for the legacy Host-target rejection boundary. */
export type ExecutionTargetUpdateWireCommand = ExecutionTargetUpdateIntent;

export const executionTargetAvailabilityReasonSchema = z.enum([
  "unassigned",
  "automatic_pending_selection",
  "ready",
  "host_missing",
  "host_revoked",
  "host_offline",
  "host_at_capacity",
  "host_capability_mismatch",
  "host_not_authorized"
]);
export type ExecutionTargetAvailabilityReason = z.infer<
  typeof executionTargetAvailabilityReasonSchema
>;

export const executionTargetReadModelSchema = executionTargetRecordSchema
  .extend({
    revision: targetRevisionSchema,
    availability: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ready"), reason: z.literal("ready") }).strict(),
      z.object({ status: z.literal("unassigned"), reason: z.literal("unassigned") }).strict(),
      z
        .object({ status: z.literal("pending"), reason: z.literal("automatic_pending_selection") })
        .strict(),
      z
        .object({
          status: z.enum(["invalid", "unavailable"]),
          reason: executionTargetAvailabilityReasonSchema.exclude([
            "ready",
            "unassigned",
            "automatic_pending_selection"
          ])
        })
        .strict()
    ])
  })
  .strict();
export type ExecutionTargetReadModel = z.infer<typeof executionTargetReadModelSchema>;

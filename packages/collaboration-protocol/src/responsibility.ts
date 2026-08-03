import { blockRefSchema, opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { z } from "zod";
import { COLLABORATION_REASON_MAX_LENGTH, COLLABORATION_REVISION_MAX } from "./limits.js";
import { humanPrincipalIdSchema, timestampSchema, workspaceIdSchema } from "./primitives.js";

export const responsibilitySchemaVersion = "responsibility/v1" as const;
export const responsibilitySchemaVersionSchema = z.literal(responsibilitySchemaVersion);
export type ResponsibilitySchemaVersion = z.infer<typeof responsibilitySchemaVersionSchema>;

const boundedRevisionSchema = z.number().int().nonnegative().max(COLLABORATION_REVISION_MAX);
export const collaborationRevisionSchema = boundedRevisionSchema;
export type CollaborationRevision = z.infer<typeof collaborationRevisionSchema>;
const storedRevisionSchema = boundedRevisionSchema.min(1);

/** A Task or one exact Task#Block in a Workspace. */
export const collaborationWorkScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("task"),
      workspaceId: workspaceIdSchema,
      projectId: opaqueIdentifierSchema,
      canvasId: opaqueIdentifierSchema,
      taskId: opaqueIdentifierSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("block"),
      workspaceId: workspaceIdSchema,
      projectId: opaqueIdentifierSchema,
      canvasId: opaqueIdentifierSchema,
      blockRef: blockRefSchema
    })
    .strict()
]);
export type CollaborationWorkScope = z.infer<typeof collaborationWorkScopeSchema>;
export const responsibilityScopeSchema = collaborationWorkScopeSchema;
export type ResponsibilityScope = CollaborationWorkScope;

/** Only an active Workspace human member can be assigned here. */
export const workspaceMemberPrincipalSchema = z
  .object({ kind: z.literal("human"), humanPrincipalId: humanPrincipalIdSchema })
  .strict();
export type WorkspaceMemberPrincipal = z.infer<typeof workspaceMemberPrincipalSchema>;
export const responsibilityPrincipalSchema = workspaceMemberPrincipalSchema;

const responsibilityReasonSchema = z.string().trim().min(1).max(COLLABORATION_REASON_MAX_LENGTH);

export const responsibilityRecordSchema = z
  .object({
    schemaVersion: responsibilitySchemaVersionSchema,
    scope: collaborationWorkScopeSchema,
    principal: workspaceMemberPrincipalSchema.nullable(),
    revision: storedRevisionSchema,
    updatedAt: timestampSchema
  })
  .strict();
export type ResponsibilityRecord = z.infer<typeof responsibilityRecordSchema>;
export const responsibilityAssignmentSchema = responsibilityRecordSchema;
export type ResponsibilityAssignment = ResponsibilityRecord;

/** Desktop sends intent and optimistic revision only; Server injects actor/auth. */
export const responsibilityUpdateIntentSchema = z
  .object({
    schemaVersion: responsibilitySchemaVersionSchema,
    scope: collaborationWorkScopeSchema,
    principal: workspaceMemberPrincipalSchema.nullable(),
    expectedRevision: boundedRevisionSchema,
    reason: responsibilityReasonSchema.optional()
  })
  .strict();
export type ResponsibilityUpdateIntent = z.infer<typeof responsibilityUpdateIntentSchema>;
export const responsibilityUpdateWireCommandSchema = responsibilityUpdateIntentSchema;
export type ResponsibilityUpdateWireCommand = ResponsibilityUpdateIntent;

export const responsibilityReadModelSchema = responsibilityRecordSchema
  .extend({
    revision: boundedRevisionSchema,
    availability: z.enum(["active", "unassigned", "inactive_member", "missing_scope"])
  })
  .strict();
export type ResponsibilityReadModel = z.infer<typeof responsibilityReadModelSchema>;

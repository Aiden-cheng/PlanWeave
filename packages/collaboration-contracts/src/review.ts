import { z } from "zod";
import { COLLABORATION_REASON_MAX_LENGTH, COLLABORATION_REVISION_MAX } from "./limits.js";
import { collaborationWorkScopeSchema, workspaceMemberPrincipalSchema } from "./responsibility.js";
import { timestampSchema } from "./primitives.js";

export const reviewAssignmentSchemaVersion = "review-assignment/v1" as const;
export const reviewAssignmentSchemaVersionSchema = z.literal(reviewAssignmentSchemaVersion);
export type ReviewAssignmentSchemaVersion = z.infer<typeof reviewAssignmentSchemaVersionSchema>;

const reviewerRevisionSchema = z.number().int().nonnegative().max(COLLABORATION_REVISION_MAX);
const storedReviewerRevisionSchema = reviewerRevisionSchema.min(1);

/** Reviewer identity is deliberately the same human-only Workspace member type. */
export const reviewerPrincipalSchema = workspaceMemberPrincipalSchema;
export type ReviewerPrincipal = z.infer<typeof reviewerPrincipalSchema>;

export const reviewAssignmentRecordSchema = z
  .object({
    schemaVersion: reviewAssignmentSchemaVersionSchema,
    scope: collaborationWorkScopeSchema,
    principal: reviewerPrincipalSchema.nullable(),
    revision: storedReviewerRevisionSchema,
    updatedAt: timestampSchema
  })
  .strict();
export type ReviewAssignmentRecord = z.infer<typeof reviewAssignmentRecordSchema>;
export const reviewerAssignmentSchema = reviewAssignmentRecordSchema;

/** A review mutation is independent from responsibility and execution target revisions. */
export const reviewAssignmentUpdateIntentSchema = z
  .object({
    schemaVersion: reviewAssignmentSchemaVersionSchema,
    scope: collaborationWorkScopeSchema,
    principal: reviewerPrincipalSchema.nullable(),
    expectedRevision: reviewerRevisionSchema,
    reason: z.string().trim().min(1).max(COLLABORATION_REASON_MAX_LENGTH).optional()
  })
  .strict();
export type ReviewAssignmentUpdateIntent = z.infer<typeof reviewAssignmentUpdateIntentSchema>;
export const reviewAssignmentUpdateWireCommandSchema = reviewAssignmentUpdateIntentSchema;
export type ReviewAssignmentUpdateWireCommand = ReviewAssignmentUpdateIntent;

export const reviewAssignmentReadModelSchema = reviewAssignmentRecordSchema
  .extend({
    revision: reviewerRevisionSchema,
    availability: z.enum(["active", "unassigned", "inactive_member", "missing_scope"])
  })
  .strict();
export type ReviewAssignmentReadModel = z.infer<typeof reviewAssignmentReadModelSchema>;

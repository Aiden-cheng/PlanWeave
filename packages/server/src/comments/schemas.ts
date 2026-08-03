import {
  actorRefSchema,
  commentContentSha256Schema,
  commentIdSchema,
  humanPrincipalIdSchema,
  humanProjectIdSchema,
  pendingAttachmentUploadIdSchema,
  timestampSchema,
  workItemRefSchema,
  type WorkItemRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  activityListCursorSchema,
  commentAttachmentFileNameSchema,
  commentAttachmentInputSchema,
  commentAttachmentMediaTypeSchema,
  commentAttachmentSizeBytesSchema,
  commentBodyFormatSchema,
  commentBodySchema,
  commentListCursorSchema,
  commentTombstoneReasonSchema
} from "@planweave-ai/collaboration-protocol/activity/comments";
import {
  COMMENT_ATTACHMENTS_MAX_COUNT,
  COMMENT_LIST_PAGE_DEFAULT,
  COMMENT_LIST_PAGE_MAX,
  COMMENT_LIST_PAGE_MIN,
  ACTIVITY_LIST_PAGE_DEFAULT,
  ACTIVITY_LIST_PAGE_MAX,
  ACTIVITY_LIST_PAGE_MIN
} from "@planweave-ai/collaboration-protocol/core/limits";
import { z } from "zod";
import { humanAuthContextSchema } from "../identity/schemas.js";
import { COMMENT_STAGED_UPLOAD_MAX_TTL_MS, COMMENT_STAGED_UPLOAD_MIN_TTL_MS } from "./limits.js";

export {
  activityIdSchema,
  commentContentSha256Schema,
  commentIdSchema,
  pendingAttachmentUploadIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
export type {
  ActivityId,
  CommentId,
  PendingAttachmentUploadId
} from "@planweave-ai/collaboration-protocol/core/primitives";
export {
  activityListCursorSchema,
  activityListPageSchema,
  activityRecordSchema,
  activitySourceKindSchema,
  activitySourceSchema,
  activitySubjectSchema,
  activitySummarySchema,
  activityTypeSchema,
  commentAttachmentFileNameSchema,
  commentAttachmentInputSchema,
  commentAttachmentMediaTypeSchema,
  commentAttachmentProjectionSchema,
  commentAttachmentSizeBytesSchema,
  commentAuthorDisplaySchema,
  commentBodyFormatSchema,
  commentBodySchema,
  commentDisplayProjectionSchema,
  commentListCursorSchema,
  commentListPageSchema,
  commentTombstoneReasonSchema,
  commentWorkItemPresenceSchema
} from "@planweave-ai/collaboration-protocol/activity/comments";
export type {
  ActivityListCursor,
  ActivityListPage,
  ActivityRecord,
  ActivitySource,
  ActivitySourceKind,
  ActivitySubject,
  ActivitySummary,
  ActivityType,
  CommentAttachmentFileName,
  CommentAttachmentInput,
  CommentAttachmentMediaType,
  CommentAttachmentProjection,
  CommentAttachmentSizeBytes,
  CommentAuthorDisplay,
  CommentBody,
  CommentBodyFormat,
  CommentDisplayProjection,
  CommentListCursor,
  CommentListPage,
  CommentWorkItemPresence
} from "@planweave-ai/collaboration-protocol/activity/comments";

/** Finalized persistence metadata; public projections intentionally omit createdAt. */
export const commentAttachmentMetadataSchema = z
  .object({
    digestSha256: commentContentSha256Schema,
    sizeBytes: commentAttachmentSizeBytesSchema,
    mediaType: commentAttachmentMediaTypeSchema,
    fileName: commentAttachmentFileNameSchema.optional(),
    createdAt: timestampSchema
  })
  .strict();
export type CommentAttachmentMetadata = z.infer<typeof commentAttachmentMetadataSchema>;

/** Staged upload persistence state, separate from public attachment wire DTOs. */
export const pendingAttachmentUploadSchema = z
  .object({
    pendingUploadId: pendingAttachmentUploadIdSchema,
    projectId: humanProjectIdSchema,
    uploaderHumanPrincipalId: humanPrincipalIdSchema,
    expectedDigestSha256: commentContentSha256Schema.optional(),
    expectedSizeBytes: commentAttachmentSizeBytesSchema,
    mediaType: commentAttachmentMediaTypeSchema,
    fileName: commentAttachmentFileNameSchema.optional(),
    commentId: commentIdSchema.optional(),
    createdAt: timestampSchema,
    expiresAt: timestampSchema
  })
  .strict();
export type PendingAttachmentUpload = z.infer<typeof pendingAttachmentUploadSchema>;

/** Durable comment state. Tombstoned bodies remain for audit and are redacted in projections. */
export const commentRecordSchema = z
  .object({
    commentId: commentIdSchema,
    projectId: humanProjectIdSchema,
    workItem: workItemRefSchema,
    authorHumanPrincipalId: humanPrincipalIdSchema,
    body: commentBodySchema,
    bodyFormat: commentBodyFormatSchema,
    revision: z.number().int().positive(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    attachments: z.array(commentAttachmentMetadataSchema).max(COMMENT_ATTACHMENTS_MAX_COUNT),
    tombstonedAt: timestampSchema.optional(),
    tombstonedBy: actorRefSchema.optional(),
    tombstoneReason: commentTombstoneReasonSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.tombstonedAt === undefined && value.tombstonedBy !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "tombstonedBy requires tombstonedAt",
        path: ["tombstonedBy"]
      });
    }
    if (value.tombstonedAt === undefined && value.tombstoneReason !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "tombstoneReason requires tombstonedAt",
        path: ["tombstoneReason"]
      });
    }
    if (value.tombstonedAt !== undefined && value.tombstonedBy === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "tombstoned comments must record tombstonedBy",
        path: ["tombstonedBy"]
      });
    }
    if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
      ctx.addIssue({
        code: "custom",
        message: "updatedAt must be >= createdAt",
        path: ["updatedAt"]
      });
    }
  });
export type CommentRecord = z.infer<typeof commentRecordSchema>;

/** Actor-bound create command used after HTTP authentication. */
export const commentCreateCommandSchema = z
  .object({
    projectId: humanProjectIdSchema,
    workItem: workItemRefSchema,
    body: commentBodySchema,
    actor: humanAuthContextSchema,
    attachments: z
      .array(commentAttachmentInputSchema)
      .max(COMMENT_ATTACHMENTS_MAX_COUNT)
      .default([])
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.actor.projectId !== value.projectId) {
      ctx.addIssue({
        code: "custom",
        message: "Actor projectId must match comment projectId",
        path: ["actor", "projectId"]
      });
    }
  });
export type CommentCreateCommand = z.infer<typeof commentCreateCommandSchema>;

export const commentEditCommandSchema = z
  .object({
    projectId: humanProjectIdSchema,
    commentId: commentIdSchema,
    body: commentBodySchema,
    expectedRevision: z.number().int().positive(),
    actor: humanAuthContextSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.actor.projectId !== value.projectId) {
      ctx.addIssue({
        code: "custom",
        message: "Actor projectId must match comment projectId",
        path: ["actor", "projectId"]
      });
    }
  });
export type CommentEditCommand = z.infer<typeof commentEditCommandSchema>;

export const commentTombstoneCommandSchema = z
  .object({
    projectId: humanProjectIdSchema,
    commentId: commentIdSchema,
    expectedRevision: z.number().int().positive(),
    actor: humanAuthContextSchema,
    reason: commentTombstoneReasonSchema.optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.actor.projectId !== value.projectId) {
      ctx.addIssue({
        code: "custom",
        message: "Actor projectId must match comment projectId",
        path: ["actor", "projectId"]
      });
    }
  });
export type CommentTombstoneCommand = z.infer<typeof commentTombstoneCommandSchema>;

export const commentListLimitSchema = z
  .number()
  .int()
  .min(COMMENT_LIST_PAGE_MIN)
  .max(COMMENT_LIST_PAGE_MAX)
  .default(COMMENT_LIST_PAGE_DEFAULT);

export const commentListQuerySchema = z
  .object({
    projectId: humanProjectIdSchema,
    workItem: workItemRefSchema,
    limit: commentListLimitSchema,
    cursor: commentListCursorSchema.optional(),
    includeTombstoned: z.boolean().default(false),
    actor: humanAuthContextSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.actor.projectId !== value.projectId) {
      ctx.addIssue({
        code: "custom",
        message: "Actor projectId must match query projectId",
        path: ["actor", "projectId"]
      });
    }
  });
export type CommentListQuery = z.infer<typeof commentListQuerySchema>;

export const activityListLimitSchema = z
  .number()
  .int()
  .min(ACTIVITY_LIST_PAGE_MIN)
  .max(ACTIVITY_LIST_PAGE_MAX)
  .default(ACTIVITY_LIST_PAGE_DEFAULT);

export const activityListQuerySchema = z
  .object({
    projectId: humanProjectIdSchema,
    workItem: workItemRefSchema.optional(),
    limit: activityListLimitSchema,
    cursor: activityListCursorSchema.optional(),
    actor: humanAuthContextSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.actor.projectId !== value.projectId) {
      ctx.addIssue({
        code: "custom",
        message: "Actor projectId must match query projectId",
        path: ["actor", "projectId"]
      });
    }
  });
export type ActivityListQuery = z.infer<typeof activityListQuerySchema>;

export const pendingUploadTtlMsSchema = z
  .number()
  .int()
  .min(COMMENT_STAGED_UPLOAD_MIN_TTL_MS)
  .max(COMMENT_STAGED_UPLOAD_MAX_TTL_MS);

export function workItemsEqual(a: WorkItemRef, b: WorkItemRef): boolean {
  if (a.kind !== b.kind || a.canvasId !== b.canvasId) return false;
  if (a.kind === "task" && b.kind === "task") return a.taskId === b.taskId;
  if (a.kind === "block" && b.kind === "block") return a.blockRef === b.blockRef;
  return false;
}

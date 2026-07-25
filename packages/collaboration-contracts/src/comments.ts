import { z } from "zod";
import {
  ACTIVITY_HEADLINE_MAX_LENGTH,
  ACTIVITY_LIST_PAGE_DEFAULT,
  ACTIVITY_LIST_PAGE_MAX,
  ACTIVITY_LIST_PAGE_MIN,
  ACTIVITY_SUBJECTS_MAX_COUNT,
  COMMENT_ATTACHMENT_ALLOWED_MEDIA_TYPES,
  COMMENT_ATTACHMENT_FILENAME_MAX_LENGTH,
  COMMENT_ATTACHMENT_FILENAME_MIN_LENGTH,
  COMMENT_ATTACHMENT_MAX_BYTES,
  COMMENT_ATTACHMENTS_MAX_COUNT,
  COMMENT_BODY_FORMAT,
  COMMENT_LIST_PAGE_DEFAULT,
  COMMENT_LIST_PAGE_MAX,
  COMMENT_LIST_PAGE_MIN,
  COMMENT_TOMBSTONE_REASON_MAX_LENGTH
} from "./limits.js";
import {
  activityIdSchema,
  actorRefSchema,
  commentContentSha256Schema,
  commentIdSchema,
  humanCommentBodySchema,
  humanDisplayNameSchema,
  humanPrincipalIdSchema,
  humanProjectIdSchema,
  opaqueIdentifierSchema,
  pendingAttachmentUploadIdSchema,
  projectMemberRoleSchema,
  timestampSchema,
  workItemRefSchema
} from "./primitives.js";

export const commentBodyFormatSchema = z.literal(COMMENT_BODY_FORMAT);

export const commentAttachmentFileNameSchema = z
  .string()
  .min(COMMENT_ATTACHMENT_FILENAME_MIN_LENGTH)
  .max(COMMENT_ATTACHMENT_FILENAME_MAX_LENGTH)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value.includes("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !/[\u0000-\u001f\u007f]/.test(value),
    { message: "Attachment file name must not be a path or contain control characters." }
  );

export const commentAttachmentMediaTypeSchema = z.enum(COMMENT_ATTACHMENT_ALLOWED_MEDIA_TYPES);
export const commentAttachmentSizeBytesSchema = z
  .number()
  .int()
  .positive()
  .max(COMMENT_ATTACHMENT_MAX_BYTES);

export const commentAttachmentProjectionSchema = z
  .object({
    digestSha256: commentContentSha256Schema,
    sizeBytes: commentAttachmentSizeBytesSchema,
    mediaType: commentAttachmentMediaTypeSchema,
    fileName: commentAttachmentFileNameSchema.optional()
  })
  .strict();

export const commentAuthorDisplaySchema = z
  .object({
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: humanDisplayNameSchema,
    membershipActive: z.boolean()
  })
  .strict();

export const commentWorkItemPresenceSchema = z.enum(["present", "missing"]);

export const commentDisplayProjectionSchema = z
  .object({
    commentId: commentIdSchema,
    projectId: humanProjectIdSchema,
    workItem: workItemRefSchema,
    author: commentAuthorDisplaySchema,
    body: humanCommentBodySchema.nullable(),
    bodyFormat: commentBodyFormatSchema,
    revision: z.number().int().positive(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    tombstoned: z.boolean(),
    tombstonedAt: timestampSchema.optional(),
    tombstonedBy: actorRefSchema.optional(),
    attachments: z.array(commentAttachmentProjectionSchema).max(COMMENT_ATTACHMENTS_MAX_COUNT),
    workItemPresence: commentWorkItemPresenceSchema
  })
  .strict();
export type CommentDisplayProjection = z.infer<typeof commentDisplayProjectionSchema>;

export const commentListCursorSchema = z
  .object({
    createdAt: timestampSchema,
    commentId: commentIdSchema
  })
  .strict();

export const commentListPageSchema = z
  .object({
    items: z.array(commentDisplayProjectionSchema).max(COMMENT_LIST_PAGE_MAX),
    nextCursor: commentListCursorSchema.nullable()
  })
  .strict();
export type CommentListPage = z.infer<typeof commentListPageSchema>;

export const commentAttachmentInputSchema = z
  .object({
    pendingUploadId: pendingAttachmentUploadIdSchema,
    digestSha256: commentContentSha256Schema,
    sizeBytes: commentAttachmentSizeBytesSchema,
    mediaType: commentAttachmentMediaTypeSchema,
    fileName: commentAttachmentFileNameSchema.optional()
  })
  .strict();

/** Wire create — no actor field (Server binds actor from bearer). */
export const commentCreateWireCommandSchema = z
  .object({
    workItem: workItemRefSchema,
    body: humanCommentBodySchema,
    attachments: z.array(commentAttachmentInputSchema).max(COMMENT_ATTACHMENTS_MAX_COUNT).default([])
  })
  .strict();
export type CommentCreateWireCommand = z.infer<typeof commentCreateWireCommandSchema>;

export const commentEditWireCommandSchema = z
  .object({
    commentId: commentIdSchema,
    body: humanCommentBodySchema,
    expectedRevision: z.number().int().positive()
  })
  .strict();
export type CommentEditWireCommand = z.infer<typeof commentEditWireCommandSchema>;

export const commentTombstoneWireCommandSchema = z
  .object({
    commentId: commentIdSchema,
    expectedRevision: z.number().int().positive(),
    reason: z.string().min(1).max(COMMENT_TOMBSTONE_REASON_MAX_LENGTH).optional()
  })
  .strict();
export type CommentTombstoneWireCommand = z.infer<typeof commentTombstoneWireCommandSchema>;

export const commentListWireQuerySchema = z
  .object({
    workItem: workItemRefSchema,
    limit: z
      .number()
      .int()
      .min(COMMENT_LIST_PAGE_MIN)
      .max(COMMENT_LIST_PAGE_MAX)
      .default(COMMENT_LIST_PAGE_DEFAULT),
    cursor: commentListCursorSchema.optional(),
    includeTombstoned: z.boolean().default(false)
  })
  .strict();
export type CommentListWireQuery = z.infer<typeof commentListWireQuerySchema>;

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export const activityTypeSchema = z.enum([
  "member_joined",
  "member_left",
  "member_removed",
  "owner_promoted",
  "owner_demoted",
  "assignment_updated",
  "comment_created",
  "comment_edited",
  "comment_tombstoned",
  "remote_run_started",
  "remote_run_succeeded",
  "remote_run_failed",
  "remote_run_interrupted"
]);
export type ActivityType = z.infer<typeof activityTypeSchema>;

export const activitySourceKindSchema = z.enum([
  "membership",
  "assignment",
  "comment",
  "remote_run"
]);

export const activitySourceSchema = z
  .object({
    kind: activitySourceKindSchema,
    sourceId: opaqueIdentifierSchema
  })
  .strict();

export const activitySubjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("human"),
      humanPrincipalId: humanPrincipalIdSchema,
      displayName: humanDisplayNameSchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("host"),
      hostId: opaqueIdentifierSchema,
      displayName: humanDisplayNameSchema.optional()
    })
    .strict(),
  z.object({ kind: z.literal("system") }).strict(),
  z
    .object({
      kind: z.literal("local_admin"),
      humanPrincipalId: humanPrincipalIdSchema.optional(),
      displayName: humanDisplayNameSchema.optional()
    })
    .strict()
]);

export const activitySummarySchema = z
  .object({
    headline: z.string().min(1).max(ACTIVITY_HEADLINE_MAX_LENGTH),
    workItem: workItemRefSchema.optional(),
    commentId: commentIdSchema.optional(),
    humanPrincipalId: humanPrincipalIdSchema.optional(),
    membershipRole: projectMemberRoleSchema.optional(),
    assignmentRevision: z.number().int().positive().optional(),
    dispatchId: opaqueIdentifierSchema.optional(),
    hostId: opaqueIdentifierSchema.optional()
  })
  .strict();

export const activityRecordSchema = z
  .object({
    activityId: activityIdSchema,
    projectId: humanProjectIdSchema,
    type: activityTypeSchema,
    source: activitySourceSchema,
    summary: activitySummarySchema,
    subjects: z.array(activitySubjectSchema).max(ACTIVITY_SUBJECTS_MAX_COUNT),
    workItem: workItemRefSchema.optional(),
    occurredAt: timestampSchema
  })
  .strict();
export type ActivityRecord = z.infer<typeof activityRecordSchema>;

export const activityListCursorSchema = z
  .object({
    occurredAt: timestampSchema,
    activityId: activityIdSchema
  })
  .strict();

export const activityListPageSchema = z
  .object({
    items: z.array(activityRecordSchema).max(ACTIVITY_LIST_PAGE_MAX),
    nextCursor: activityListCursorSchema.nullable()
  })
  .strict();
export type ActivityListPage = z.infer<typeof activityListPageSchema>;

export const activityListWireQuerySchema = z
  .object({
    workItem: workItemRefSchema.optional(),
    limit: z
      .number()
      .int()
      .min(ACTIVITY_LIST_PAGE_MIN)
      .max(ACTIVITY_LIST_PAGE_MAX)
      .default(ACTIVITY_LIST_PAGE_DEFAULT),
    cursor: activityListCursorSchema.optional()
  })
  .strict();
export type ActivityListWireQuery = z.infer<typeof activityListWireQuerySchema>;

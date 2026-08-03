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

/** True when `value` contains ASCII C0 controls or DEL (U+0000–U+001F, U+007F). */
function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export const commentBodyFormatSchema = z.literal(COMMENT_BODY_FORMAT);
export type CommentBodyFormat = z.infer<typeof commentBodyFormatSchema>;

/** Public semantic alias for Markdown comment bodies. */
export const commentBodySchema = humanCommentBodySchema;
export type CommentBody = z.infer<typeof commentBodySchema>;

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
      !hasAsciiControlCharacter(value),
    { message: "Attachment file name must not be a path or contain control characters." }
  );
export type CommentAttachmentFileName = z.infer<typeof commentAttachmentFileNameSchema>;

export const commentAttachmentMediaTypeSchema = z.enum(COMMENT_ATTACHMENT_ALLOWED_MEDIA_TYPES);
export type CommentAttachmentMediaType = z.infer<typeof commentAttachmentMediaTypeSchema>;
export const commentAttachmentSizeBytesSchema = z
  .number()
  .int()
  .positive()
  .max(COMMENT_ATTACHMENT_MAX_BYTES);
export type CommentAttachmentSizeBytes = z.infer<typeof commentAttachmentSizeBytesSchema>;

export const commentTombstoneReasonSchema = z
  .string()
  .min(1)
  .max(COMMENT_TOMBSTONE_REASON_MAX_LENGTH);

export const commentAttachmentProjectionSchema = z
  .object({
    digestSha256: commentContentSha256Schema,
    sizeBytes: commentAttachmentSizeBytesSchema,
    mediaType: commentAttachmentMediaTypeSchema,
    fileName: commentAttachmentFileNameSchema.optional()
  })
  .strict();
export type CommentAttachmentProjection = z.infer<typeof commentAttachmentProjectionSchema>;

export const commentAuthorDisplaySchema = z
  .object({
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: humanDisplayNameSchema,
    membershipActive: z.boolean()
  })
  .strict();
export type CommentAuthorDisplay = z.infer<typeof commentAuthorDisplaySchema>;

export const commentWorkItemPresenceSchema = z.enum(["present", "missing"]);
export type CommentWorkItemPresence = z.infer<typeof commentWorkItemPresenceSchema>;

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
  .strict()
  .superRefine((value, ctx) => {
    if (value.tombstoned) {
      if (value.body !== null) {
        ctx.addIssue({
          code: "custom",
          message: "tombstoned comment projections must redact body",
          path: ["body"]
        });
      }
      if (value.tombstonedAt === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "tombstoned projection requires tombstonedAt",
          path: ["tombstonedAt"]
        });
      }
    } else if (value.body === null) {
      ctx.addIssue({
        code: "custom",
        message: "active comment projections require body",
        path: ["body"]
      });
    }
  });
export type CommentDisplayProjection = z.infer<typeof commentDisplayProjectionSchema>;

export const commentListCursorSchema = z
  .object({
    createdAt: timestampSchema,
    commentId: commentIdSchema
  })
  .strict();
export type CommentListCursor = z.infer<typeof commentListCursorSchema>;

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
export type CommentAttachmentInput = z.infer<typeof commentAttachmentInputSchema>;

/** Wire create — no actor field (Server binds actor from bearer). */
export const commentCreateWireCommandSchema = z
  .object({
    workItem: workItemRefSchema,
    body: humanCommentBodySchema,
    attachments: z
      .array(commentAttachmentInputSchema)
      .max(COMMENT_ATTACHMENTS_MAX_COUNT)
      .default([])
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
    reason: commentTombstoneReasonSchema.optional()
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
export type ActivitySourceKind = z.infer<typeof activitySourceKindSchema>;

export const activitySourceSchema = z
  .object({
    kind: activitySourceKindSchema,
    sourceId: opaqueIdentifierSchema
  })
  .strict();
export type ActivitySource = z.infer<typeof activitySourceSchema>;

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
export type ActivitySubject = z.infer<typeof activitySubjectSchema>;

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
export type ActivitySummary = z.infer<typeof activitySummarySchema>;

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
  .strict()
  .superRefine((value, ctx) => {
    const { type, source, summary, workItem } = value;
    const requireSourceKind = (kind: ActivitySourceKind, path: string) => {
      if (source.kind !== kind) {
        ctx.addIssue({
          code: "custom",
          message: `${path} requires source.kind=${kind}`,
          path: ["source", "kind"]
        });
      }
    };

    switch (type) {
      case "member_joined":
      case "member_left":
      case "member_removed":
      case "owner_promoted":
      case "owner_demoted":
        requireSourceKind("membership", type);
        if (summary.humanPrincipalId === undefined) {
          ctx.addIssue({
            code: "custom",
            message: `${type} summary requires humanPrincipalId`,
            path: ["summary", "humanPrincipalId"]
          });
        }
        break;
      case "assignment_updated":
        requireSourceKind("assignment", type);
        if (workItem === undefined && summary.workItem === undefined) {
          ctx.addIssue({
            code: "custom",
            message: "assignment_updated requires workItem scope",
            path: ["workItem"]
          });
        }
        if (summary.assignmentRevision === undefined) {
          ctx.addIssue({
            code: "custom",
            message: "assignment_updated summary requires assignmentRevision",
            path: ["summary", "assignmentRevision"]
          });
        }
        break;
      case "comment_created":
      case "comment_edited":
      case "comment_tombstoned":
        requireSourceKind("comment", type);
        if (summary.commentId === undefined) {
          ctx.addIssue({
            code: "custom",
            message: `${type} summary requires commentId`,
            path: ["summary", "commentId"]
          });
        }
        if (workItem === undefined && summary.workItem === undefined) {
          ctx.addIssue({
            code: "custom",
            message: `${type} requires workItem scope`,
            path: ["workItem"]
          });
        }
        break;
      case "remote_run_started":
      case "remote_run_succeeded":
      case "remote_run_failed":
      case "remote_run_interrupted":
        requireSourceKind("remote_run", type);
        if (summary.dispatchId === undefined) {
          ctx.addIssue({
            code: "custom",
            message: `${type} summary requires dispatchId`,
            path: ["summary", "dispatchId"]
          });
        }
        break;
      default: {
        const exhaustive: never = type;
        void exhaustive;
      }
    }
  });
export type ActivityRecord = z.infer<typeof activityRecordSchema>;

export const activityListCursorSchema = z
  .object({
    occurredAt: timestampSchema,
    activityId: activityIdSchema
  })
  .strict();
export type ActivityListCursor = z.infer<typeof activityListCursorSchema>;

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

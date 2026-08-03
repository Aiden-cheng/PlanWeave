import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { z } from "zod";
import {
  actorRefSchema,
  humanAuthContextSchema,
  humanCommentBodySchema,
  humanDisplayNameSchema,
  humanPrincipalIdSchema,
  humanProjectIdSchema,
  projectMemberRoleSchema
} from "../identity/schemas.js";
import { workItemRefSchema, type WorkItemRef } from "../work/schemas.js";
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
  COMMENT_STAGED_UPLOAD_MAX_TTL_MS,
  COMMENT_STAGED_UPLOAD_MIN_TTL_MS,
  COMMENT_TOMBSTONE_REASON_MAX_LENGTH
} from "./limits.js";

const timestampSchema = z.iso.datetime();

/** True when `value` contains ASCII C0 controls or DEL (U+0000–U+001F, U+007F). */
function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** SHA-256 digest as lowercase hex (content-addressed blob identity). */
export const commentContentSha256Schema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]+$/);

export const commentIdSchema = opaqueIdentifierSchema.brand("CommentId");
export type CommentId = z.infer<typeof commentIdSchema>;

export const activityIdSchema = opaqueIdentifierSchema.brand("ActivityId");
export type ActivityId = z.infer<typeof activityIdSchema>;

export const pendingAttachmentUploadIdSchema = opaqueIdentifierSchema.brand(
  "PendingAttachmentUploadId"
);
export type PendingAttachmentUploadId = z.infer<typeof pendingAttachmentUploadIdSchema>;

/**
 * Markdown source body. Stored and transmitted as plain text Markdown — never HTML.
 * Renderers must sanitize on display; this schema only bounds length and non-emptiness.
 */
export const commentBodySchema = humanCommentBodySchema;
export type CommentBody = z.infer<typeof commentBodySchema>;

export const commentBodyFormatSchema = z.literal(COMMENT_BODY_FORMAT);
export type CommentBodyFormat = z.infer<typeof commentBodyFormatSchema>;

/**
 * Safe attachment file name for display only — never a filesystem path.
 * Rejects separators, empty/`.`/`..`, and control characters.
 */
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

/**
 * Finalized attachment metadata referenced by a comment.
 * Content-addressed by digest; authorization is human membership + comment scope
 * (never dispatch artifact grants or bare digest knowledge alone).
 */
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

/**
 * Create-time attachment reference after a verified staged upload finalize (B-002).
 * Digest/size/media must match the staged blob; service rejects mismatches.
 */
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

/**
 * Staged upload metadata (human attachment pipeline). Not a dispatch grant.
 * Expiry and cleanup are enforced by B-002; this contract only bounds fields.
 */
export const pendingAttachmentUploadSchema = z
  .object({
    pendingUploadId: pendingAttachmentUploadIdSchema,
    projectId: humanProjectIdSchema,
    uploaderHumanPrincipalId: humanPrincipalIdSchema,
    /** Optional until the client declares expected content identity. */
    expectedDigestSha256: commentContentSha256Schema.optional(),
    expectedSizeBytes: commentAttachmentSizeBytesSchema,
    mediaType: commentAttachmentMediaTypeSchema,
    fileName: commentAttachmentFileNameSchema.optional(),
    /** Optional target comment when attaching to an existing comment in later blocks. */
    commentId: commentIdSchema.optional(),
    createdAt: timestampSchema,
    expiresAt: timestampSchema
  })
  .strict();
export type PendingAttachmentUpload = z.infer<typeof pendingAttachmentUploadSchema>;

export const commentTombstoneReasonSchema = z
  .string()
  .min(1)
  .max(COMMENT_TOMBSTONE_REASON_MAX_LENGTH);

/**
 * Durable comment record (coordination annotation only).
 * Author is always a human principal — never Host, operator token, or generic Actor.
 * Does not store Runtime claim/submit state, prompts, or dispatch grants.
 */
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
    /**
     * Who tombstoned: human author or owner moderator (ActorRef display only).
     * Hosts never appear as comment authors; they may appear here only if a future
     * explicit feature allows system moderation (currently human/local_admin/system).
     */
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

/**
 * Create command. Actor must be a concrete human auth context (authorization),
 * not a display ActorRef and not a Host credential.
 */
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

/**
 * Edit command (author only). Compare-and-set on revision.
 * Attachment set is not rewritten here — keep edit policy simple (body only).
 */
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

/**
 * Tombstone command (author or project owner). Soft-delete with audit markers.
 * Body remains in the durable record for audit; projections redact it.
 */
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

/** Package presence of the WorkItemRef at projection time (not stored on the durable row). */
export const commentWorkItemPresenceSchema = z.enum(["present", "missing"]);
export type CommentWorkItemPresence = z.infer<typeof commentWorkItemPresenceSchema>;

export const commentAuthorDisplaySchema = z
  .object({
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: humanDisplayNameSchema,
    membershipActive: z.boolean()
  })
  .strict();
export type CommentAuthorDisplay = z.infer<typeof commentAuthorDisplaySchema>;

export const commentAttachmentProjectionSchema = z
  .object({
    digestSha256: commentContentSha256Schema,
    sizeBytes: commentAttachmentSizeBytesSchema,
    mediaType: commentAttachmentMediaTypeSchema,
    fileName: commentAttachmentFileNameSchema.optional()
  })
  .strict();
export type CommentAttachmentProjection = z.infer<typeof commentAttachmentProjectionSchema>;

/**
 * Read-model projection for Task/Block views. Display-only — never used for auth.
 * Tombstoned comments redact body; durable record retains body for audit.
 */
export const commentDisplayProjectionSchema = z
  .object({
    commentId: commentIdSchema,
    projectId: humanProjectIdSchema,
    workItem: workItemRefSchema,
    author: commentAuthorDisplaySchema,
    /** Null when tombstoned (audit-safe display redaction). */
    body: commentBodySchema.nullable(),
    bodyFormat: commentBodyFormatSchema,
    revision: z.number().int().positive(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    tombstoned: z.boolean(),
    tombstonedAt: timestampSchema.optional(),
    tombstonedBy: actorRefSchema.optional(),
    attachments: z.array(commentAttachmentProjectionSchema).max(COMMENT_ATTACHMENTS_MAX_COUNT),
    /**
     * Whether the WorkItemRef still exists in the current Plan Package.
     * Removed/renamed items keep durable comments under the original ref (no silent remap).
     */
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

/**
 * Keyset cursor for comment threads.
 * Order: createdAt ASC, commentId ASC (stable chronological thread).
 */
export const commentListCursorSchema = z
  .object({
    createdAt: timestampSchema,
    commentId: commentIdSchema
  })
  .strict();
export type CommentListCursor = z.infer<typeof commentListCursorSchema>;

export const commentListLimitSchema = z
  .number()
  .int()
  .min(COMMENT_LIST_PAGE_MIN)
  .max(COMMENT_LIST_PAGE_MAX)
  .default(COMMENT_LIST_PAGE_DEFAULT);

/**
 * Bounded comment list query. Scoped to one project + one WorkItemRef (no chat rooms).
 */
export const commentListQuerySchema = z
  .object({
    projectId: humanProjectIdSchema,
    workItem: workItemRefSchema,
    limit: commentListLimitSchema,
    cursor: commentListCursorSchema.optional(),
    /** When false (default), omit tombstoned comments from the page. */
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

export const commentListPageSchema = z
  .object({
    items: z.array(commentDisplayProjectionSchema).max(COMMENT_LIST_PAGE_MAX),
    nextCursor: commentListCursorSchema.nullable()
  })
  .strict();
export type CommentListPage = z.infer<typeof commentListPageSchema>;

// ---------------------------------------------------------------------------
// Activity (append-only read projection)
// ---------------------------------------------------------------------------

/**
 * Stable activity types for meaningful collaboration actions only.
 * Non-goals: ACP token/tool noise, delivery ACKs, chat, proposals, consensus, workflow transitions.
 */
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

/**
 * Idempotent source identity for projection inserts.
 * Duplicate (projectId, source.kind, source.sourceId) must not create a second activity row.
 */
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

/**
 * Typed subjects in activity summaries. Hosts/system may appear here for remote-run
 * and assignment context — never as comment authors.
 */
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

/**
 * Bounded structured summary for UI. Never embeds prompts, secrets, or ACP streams.
 * Optional fields are type-relevant navigation hints only.
 */
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

/**
 * Append-only activity record (read projection, not a command bus).
 * source provides idempotency; type is the stable action vocabulary.
 */
export const activityRecordSchema = z
  .object({
    activityId: activityIdSchema,
    projectId: humanProjectIdSchema,
    type: activityTypeSchema,
    source: activitySourceSchema,
    summary: activitySummarySchema,
    subjects: z.array(activitySubjectSchema).max(ACTIVITY_SUBJECTS_MAX_COUNT),
    /** Optional work-item scope when the action is Task/Block-local. */
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
        const _exhaustive: never = type;
        void _exhaustive;
      }
    }
  });
export type ActivityRecord = z.infer<typeof activityRecordSchema>;

/**
 * Keyset cursor for activity feeds.
 * Order: occurredAt DESC, activityId DESC (newest meaningful actions first).
 */
export const activityListCursorSchema = z
  .object({
    occurredAt: timestampSchema,
    activityId: activityIdSchema
  })
  .strict();
export type ActivityListCursor = z.infer<typeof activityListCursorSchema>;

export const activityListLimitSchema = z
  .number()
  .int()
  .min(ACTIVITY_LIST_PAGE_MIN)
  .max(ACTIVITY_LIST_PAGE_MAX)
  .default(ACTIVITY_LIST_PAGE_DEFAULT);

/**
 * Bounded activity list query. Project-scoped; optional WorkItemRef filter.
 * Not a chat history, channel, or proposal stream.
 */
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

export const activityListPageSchema = z
  .object({
    items: z.array(activityRecordSchema).max(ACTIVITY_LIST_PAGE_MAX),
    nextCursor: activityListCursorSchema.nullable()
  })
  .strict();
export type ActivityListPage = z.infer<typeof activityListPageSchema>;

export const pendingUploadTtlMsSchema = z
  .number()
  .int()
  .min(COMMENT_STAGED_UPLOAD_MIN_TTL_MS)
  .max(COMMENT_STAGED_UPLOAD_MAX_TTL_MS);

/** Compare two WorkItemRefs for exact scope equality (no rename aliasing). */
export function workItemsEqual(a: WorkItemRef, b: WorkItemRef): boolean {
  if (a.kind !== b.kind || a.canvasId !== b.canvasId) return false;
  if (a.kind === "task" && b.kind === "task") return a.taskId === b.taskId;
  if (a.kind === "block" && b.kind === "block") return a.blockRef === b.blockRef;
  return false;
}

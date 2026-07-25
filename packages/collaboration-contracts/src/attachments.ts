import { z } from "zod";
import {
  commentAttachmentFileNameSchema,
  commentAttachmentMediaTypeSchema,
  commentAttachmentSizeBytesSchema
} from "./comments.js";
import {
  commentContentSha256Schema,
  commentIdSchema,
  humanProjectIdSchema,
  pendingAttachmentUploadIdSchema,
  timestampSchema
} from "./primitives.js";

export const createPendingAttachmentRequestSchema = z
  .object({
    expectedSizeBytes: commentAttachmentSizeBytesSchema,
    mediaType: commentAttachmentMediaTypeSchema,
    fileName: commentAttachmentFileNameSchema.optional(),
    expectedDigestSha256: commentContentSha256Schema.optional(),
    commentId: commentIdSchema.optional()
  })
  .strict();
export type CreatePendingAttachmentRequest = z.infer<typeof createPendingAttachmentRequestSchema>;

export const pendingAttachmentViewSchema = z
  .object({
    pendingUploadId: pendingAttachmentUploadIdSchema,
    projectId: humanProjectIdSchema,
    expectedSizeBytes: commentAttachmentSizeBytesSchema,
    mediaType: commentAttachmentMediaTypeSchema,
    fileName: commentAttachmentFileNameSchema.optional(),
    expectedDigestSha256: commentContentSha256Schema.optional(),
    commentId: commentIdSchema.optional(),
    status: z.enum(["pending", "uploaded", "finalized", "expired", "aborted"]),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    digestSha256: commentContentSha256Schema.optional(),
    uploadedAt: timestampSchema.optional()
  })
  .strict();
export type PendingAttachmentView = z.infer<typeof pendingAttachmentViewSchema>;

export const finalizePendingAttachmentRequestSchema = z
  .object({
    expectedDigestSha256: commentContentSha256Schema.optional()
  })
  .strict()
  .default({});

export const finalizePendingAttachmentResponseSchema = z
  .object({
    pendingUploadId: pendingAttachmentUploadIdSchema,
    status: z.literal("finalized"),
    digestSha256: commentContentSha256Schema,
    sizeBytes: commentAttachmentSizeBytesSchema,
    mediaType: commentAttachmentMediaTypeSchema,
    fileName: commentAttachmentFileNameSchema.optional()
  })
  .strict();
export type FinalizePendingAttachmentResponse = z.infer<
  typeof finalizePendingAttachmentResponseSchema
>;

export const uploadPendingAttachmentResponseSchema = z
  .object({
    pendingUploadId: pendingAttachmentUploadIdSchema,
    status: z.enum(["uploaded", "finalized"]),
    digestSha256: commentContentSha256Schema.optional(),
    sizeBytes: commentAttachmentSizeBytesSchema.optional(),
    mediaType: commentAttachmentMediaTypeSchema,
    uploadedAt: timestampSchema.optional()
  })
  .strict();

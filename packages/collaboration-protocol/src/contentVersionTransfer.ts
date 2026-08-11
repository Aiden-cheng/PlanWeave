import { z } from "zod";
import {
  CONTENT_VERSION_MAX_MEMBERS,
  CONTENT_VERSION_MAX_TOTAL_BYTES,
  CONTENT_VERSION_TRANSFER_MAX_FRAME_BYTES,
  CONTENT_VERSION_TRANSFER_MAX_WIRE_BYTES
} from "./limits.js";
import { actorRefSchema, canvasScopeRefSchema, timestampSchema } from "./primitives.js";
import {
  completedContentVersionRefSchema,
  contentVersionMemberSchema,
  contentVersionSchemaVersionSchema
} from "./contentVersion.js";
import { packageSnapshotDigestSchema } from "./packageSnapshot.js";

/** Immutable content uses a dedicated NDJSON stream; it is never a generic collaboration JSON DTO. */
export const contentVersionTransferMediaType =
  "application/x-planweave-content-version-ndjson" as const;
export const contentVersionTransferTotalBytesSchema = z
  .number()
  .int()
  .positive()
  .max(CONTENT_VERSION_MAX_TOTAL_BYTES);
export const contentVersionTransferMemberCountSchema = z
  .number()
  .int()
  .min(2)
  .max(CONTENT_VERSION_MAX_MEMBERS);

export const contentVersionTransferHeaderFrameSchema = z
  .object({
    type: z.literal("header"),
    schemaVersion: contentVersionSchemaVersionSchema,
    scope: canvasScopeRefSchema,
    completed: completedContentVersionRefSchema,
    canonicalDigest: packageSnapshotDigestSchema,
    totalBytes: contentVersionTransferTotalBytesSchema,
    memberCount: contentVersionTransferMemberCountSchema,
    createdAt: timestampSchema,
    createdBy: actorRefSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.completed.canonicalDigest !== value.canonicalDigest) {
      context.addIssue({ code: "custom", message: "content_transfer_header_digest_mismatch" });
    }
  });
export type ContentVersionTransferHeaderFrame = z.infer<
  typeof contentVersionTransferHeaderFrameSchema
>;

export const contentVersionTransferMemberFrameSchema = z
  .object({
    type: z.literal("member"),
    index: z.number().int().nonnegative(),
    member: contentVersionMemberSchema
  })
  .strict();
export type ContentVersionTransferMemberFrame = z.infer<
  typeof contentVersionTransferMemberFrameSchema
>;

export const contentVersionTransferCompleteFrameSchema = z
  .object({
    type: z.literal("complete"),
    canonicalDigest: packageSnapshotDigestSchema,
    totalBytes: contentVersionTransferTotalBytesSchema,
    memberCount: contentVersionTransferMemberCountSchema
  })
  .strict();
export type ContentVersionTransferCompleteFrame = z.infer<
  typeof contentVersionTransferCompleteFrameSchema
>;

export const contentVersionTransferFrameSchema = z.discriminatedUnion("type", [
  contentVersionTransferHeaderFrameSchema,
  contentVersionTransferMemberFrameSchema,
  contentVersionTransferCompleteFrameSchema
]);
export type ContentVersionTransferFrame = z.infer<typeof contentVersionTransferFrameSchema>;

export const contentVersionTransferLimits = {
  maxFrameBytes: CONTENT_VERSION_TRANSFER_MAX_FRAME_BYTES,
  maxWireBytes: CONTENT_VERSION_TRANSFER_MAX_WIRE_BYTES
} as const;

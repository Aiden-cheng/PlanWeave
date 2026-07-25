import { blockRefSchema, opaqueIdentifierSchema } from "@planweave-ai/distributed-protocol";
import { z } from "zod";
import {
  HUMAN_ASSIGN_REASON_MAX_LENGTH,
  HUMAN_COMMENT_BODY_MAX_LENGTH,
  HUMAN_COMMENT_BODY_MIN_LENGTH,
  HUMAN_DEVICE_LABEL_MAX_LENGTH,
  HUMAN_DEVICE_MAX_TTL_MS,
  HUMAN_DEVICE_MIN_TTL_MS,
  HUMAN_DEVICE_TOKEN_PREFIX,
  HUMAN_DISPLAY_NAME_MAX_LENGTH,
  HUMAN_DISPLAY_NAME_MIN_LENGTH,
  HUMAN_TOKEN_SECRET_CHAR_LENGTH,
  PROJECT_INVITATION_MAX_TTL_MS,
  PROJECT_INVITATION_MIN_TTL_MS,
  PROJECT_INVITATION_TOKEN_PREFIX
} from "./limits.js";

export const timestampSchema = z.iso.datetime();

export const humanProjectIdSchema = opaqueIdentifierSchema;
export type HumanProjectId = z.infer<typeof humanProjectIdSchema>;

export const humanPrincipalIdSchema = opaqueIdentifierSchema.brand("HumanPrincipalId");
export type HumanPrincipalId = z.infer<typeof humanPrincipalIdSchema>;

export const humanDeviceCredentialIdSchema =
  opaqueIdentifierSchema.brand("HumanDeviceCredentialId");
export type HumanDeviceCredentialId = z.infer<typeof humanDeviceCredentialIdSchema>;

export const projectMembershipIdSchema = opaqueIdentifierSchema.brand("ProjectMembershipId");
export type ProjectMembershipId = z.infer<typeof projectMembershipIdSchema>;

export const projectInvitationIdSchema = opaqueIdentifierSchema.brand("ProjectInvitationId");
export type ProjectInvitationId = z.infer<typeof projectInvitationIdSchema>;

export const commentIdSchema = opaqueIdentifierSchema.brand("CommentId");
export type CommentId = z.infer<typeof commentIdSchema>;

export const activityIdSchema = opaqueIdentifierSchema.brand("ActivityId");
export type ActivityId = z.infer<typeof activityIdSchema>;

export const pendingAttachmentUploadIdSchema = opaqueIdentifierSchema.brand(
  "PendingAttachmentUploadId"
);
export type PendingAttachmentUploadId = z.infer<typeof pendingAttachmentUploadIdSchema>;

export const humanDisplayNameSchema = z
  .string()
  .trim()
  .min(HUMAN_DISPLAY_NAME_MIN_LENGTH)
  .max(HUMAN_DISPLAY_NAME_MAX_LENGTH);

export const humanDeviceLabelSchema = z.string().trim().min(1).max(HUMAN_DEVICE_LABEL_MAX_LENGTH);

export const humanCommentBodySchema = z
  .string()
  .min(HUMAN_COMMENT_BODY_MIN_LENGTH)
  .max(HUMAN_COMMENT_BODY_MAX_LENGTH);

export const humanAssignReasonSchema = z.string().min(1).max(HUMAN_ASSIGN_REASON_MAX_LENGTH);

export const humanDeviceTokenSchema = z
  .string()
  .regex(
    new RegExp(`^${HUMAN_DEVICE_TOKEN_PREFIX}[A-Za-z0-9_-]{${HUMAN_TOKEN_SECRET_CHAR_LENGTH}}$`)
  );

export const projectInvitationTokenSchema = z
  .string()
  .regex(
    new RegExp(
      `^${PROJECT_INVITATION_TOKEN_PREFIX}[A-Za-z0-9_-]{${HUMAN_TOKEN_SECRET_CHAR_LENGTH}}$`
    )
  );

export const projectMemberRoleSchema = z.enum(["owner", "member"]);
export type ProjectMemberRole = z.infer<typeof projectMemberRoleSchema>;

export const projectInvitationRoleSchema = z.literal("member");

export const projectInvitationTtlMsSchema = z
  .number()
  .int()
  .min(PROJECT_INVITATION_MIN_TTL_MS)
  .max(PROJECT_INVITATION_MAX_TTL_MS);

export const humanDeviceTtlMsSchema = z
  .number()
  .int()
  .min(HUMAN_DEVICE_MIN_TTL_MS)
  .max(HUMAN_DEVICE_MAX_TTL_MS);

export const actorRefSchema = z
  .object({
    kind: z.enum(["human", "local_admin", "system"]),
    id: opaqueIdentifierSchema,
    displayName: humanDisplayNameSchema.optional()
  })
  .strict();
export type ActorRef = z.infer<typeof actorRefSchema>;

export const workItemRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("task"),
      canvasId: opaqueIdentifierSchema,
      taskId: opaqueIdentifierSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("block"),
      canvasId: opaqueIdentifierSchema,
      blockRef: blockRefSchema
    })
    .strict()
]);
export type WorkItemRef = z.infer<typeof workItemRefSchema>;

export const commentContentSha256Schema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]+$/);

export { opaqueIdentifierSchema, blockRefSchema };

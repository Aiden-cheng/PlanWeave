import { z } from "zod";

/**
 * Stable error codes for comment/activity contracts and pure policy decisions.
 * Application layers map these to HTTP/status without leaking secrets or package paths.
 */
export const commentActivityErrorCodeSchema = z.enum([
  "comment_auth_unauthenticated",
  "comment_auth_forbidden",
  "comment_auth_project_mismatch",
  "comment_role_insufficient",
  "comment_input_invalid",
  "comment_not_found",
  "comment_work_item_not_found",
  "comment_author_required",
  "comment_not_author",
  "comment_already_tombstoned",
  "comment_revision_conflict",
  "comment_attachment_limit",
  "comment_attachment_size",
  "comment_attachment_media_type",
  "comment_cross_project_forbidden",
  "activity_input_invalid",
  "activity_source_duplicate",
  "activity_auth_forbidden"
]);

export type CommentActivityErrorCode = z.infer<typeof commentActivityErrorCodeSchema>;

export type CommentActivityDenial = {
  allowed: false;
  code: CommentActivityErrorCode;
  message: string;
};

export type CommentActivityAllowance = {
  allowed: true;
};

export type CommentActivityAuthDecision = CommentActivityAllowance | CommentActivityDenial;

export function denyCommentActivity(
  code: CommentActivityErrorCode,
  message: string
): CommentActivityDenial {
  return { allowed: false, code, message };
}

export function allowCommentActivity(): CommentActivityAllowance {
  return { allowed: true };
}

/** Safe messages; never include tokens, digests, filesystem paths, or package dumps. */
export const COMMENT_ACTIVITY_ERROR_MESSAGES: Readonly<
  Record<CommentActivityErrorCode, string>
> = {
  comment_auth_unauthenticated: "Authentication required for comment or activity actions.",
  comment_auth_forbidden: "Comment or activity action is not permitted.",
  comment_auth_project_mismatch:
    "Authenticated project scope does not match the comment or activity project.",
  comment_role_insufficient: "Project role is insufficient for this comment action.",
  comment_input_invalid: "Comment or activity input failed validation.",
  comment_not_found: "Comment was not found in this project.",
  comment_work_item_not_found: "Work item was not found in the current Plan Package.",
  comment_author_required: "Comments require a human author; Hosts cannot author comments.",
  comment_not_author: "Only the comment author may edit this comment body.",
  comment_already_tombstoned: "Comment is already tombstoned.",
  comment_revision_conflict: "Comment revision does not match the expected revision.",
  comment_attachment_limit: "Comment attachment count exceeds the allowed maximum.",
  comment_attachment_size: "Comment attachment size exceeds the allowed maximum.",
  comment_attachment_media_type: "Comment attachment media type is not allowed.",
  comment_cross_project_forbidden: "Cross-project comment or activity access is not permitted.",
  activity_input_invalid: "Activity input failed validation.",
  activity_source_duplicate: "Activity source action was already projected (idempotent skip).",
  activity_auth_forbidden: "Activity listing is not permitted for this subject."
};

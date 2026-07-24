export {
  ATTACHMENT_ERROR_MESSAGES,
  allowAttachment,
  attachmentErrorCodeSchema,
  denyAttachment,
  type AttachmentAllowance,
  type AttachmentAuthDecision,
  type AttachmentDenial,
  type AttachmentErrorCode
} from "./errors.js";

export {
  authorizeAttachmentProjectAccess,
  authorizeCommentAttachmentRead,
  authorizeDigestScopedRead,
  authorizePendingUploadMutation,
  authorizePendingUploadRead,
  evaluateAttachmentMediaAndSize,
  evaluatePendingUploadTtlMs,
  humanSubject,
  resolvePendingUploadTtlMs,
  type CommentAttachmentBinding,
  type PendingUploadRecord,
  type PendingUploadStatus
} from "./policy.js";

export {
  CommentAttachmentBlobStore,
  type CommentAttachmentBlobMetadata
} from "./blobStore.js";

export {
  AttachmentRepositoryError,
  CommentAttachmentRepository
} from "./repository.js";

export {
  CommentAttachmentService,
  CommentAttachmentServiceError,
  type CommentAttachmentServiceOptions
} from "./service.js";

export {
  handleCommentAttachmentHttpRequest,
  type AttachmentHttpOptions
} from "./http.js";

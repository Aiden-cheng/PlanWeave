/**
 * Public wire budgets for human collaboration DTOs.
 * Aligned with Server HC domain limits; contracts package is the Desktop wire authority.
 */

export const HUMAN_DISPLAY_NAME_MIN_LENGTH = 1 as const;
export const HUMAN_DISPLAY_NAME_MAX_LENGTH = 128 as const;
export const HUMAN_DEVICE_LABEL_MAX_LENGTH = 64 as const;

export const HUMAN_COMMENT_BODY_MAX_LENGTH = 16_384 as const;
export const HUMAN_COMMENT_BODY_MIN_LENGTH = 1 as const;
export const HUMAN_ASSIGN_REASON_MAX_LENGTH = 512 as const;

export const HUMAN_DEVICE_TOKEN_PREFIX = "pw_hdev_" as const;
export const PROJECT_INVITATION_TOKEN_PREFIX = "pw_inv_" as const;
export const HUMAN_TOKEN_SECRET_CHAR_LENGTH = 43 as const;

export const PROJECT_INVITATION_MIN_TTL_MS = 60_000 as const;
export const PROJECT_INVITATION_MAX_TTL_MS = 604_800_000 as const;
export const PROJECT_INVITATION_DEFAULT_TTL_MS = 86_400_000 as const;

export const HUMAN_DEVICE_MIN_TTL_MS = 60_000 as const;
export const HUMAN_DEVICE_MAX_TTL_MS = 31_536_000_000 as const;

export const HUMAN_MAX_DEVICES_LISTED_PER_PAGE = 100 as const;
export const HUMAN_MAX_MEMBERS_LISTED_PER_PAGE = 100 as const;
export const HUMAN_MAX_INVITATIONS_LISTED_PER_PAGE = 100 as const;

export const WORK_HOST_DISPLAY_NAME_MIN_LENGTH = 1 as const;
export const WORK_HOST_DISPLAY_NAME_MAX_LENGTH = 128 as const;
export const WORK_ASSIGNMENT_BATCH_MAX = 100 as const;

export const COMMENT_BODY_FORMAT = "markdown" as const;
export const COMMENT_ATTACHMENTS_MAX_COUNT = 8 as const;
export const COMMENT_ATTACHMENT_MAX_BYTES = 8_388_608 as const;
export const COMMENT_ATTACHMENT_FILENAME_MIN_LENGTH = 1 as const;
export const COMMENT_ATTACHMENT_FILENAME_MAX_LENGTH = 255 as const;
export const COMMENT_ATTACHMENT_ALLOWED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown"
] as const;

export const COMMENT_LIST_PAGE_MIN = 1 as const;
export const COMMENT_LIST_PAGE_MAX = 50 as const;
export const COMMENT_LIST_PAGE_DEFAULT = 20 as const;
export const ACTIVITY_LIST_PAGE_MIN = 1 as const;
export const ACTIVITY_LIST_PAGE_MAX = 50 as const;
export const ACTIVITY_LIST_PAGE_DEFAULT = 20 as const;
export const ACTIVITY_HEADLINE_MAX_LENGTH = 256 as const;
export const ACTIVITY_SUBJECTS_MAX_COUNT = 8 as const;
export const COMMENT_TOMBSTONE_REASON_MAX_LENGTH = 512 as const;

/** Default JSON body admission limit for human collaboration HTTP. */
export const COLLABORATION_JSON_BODY_MAX_BYTES = 16_384 as const;

/** Default max WebSocket frame size for the human observer channel. */
export const HUMAN_OBSERVER_MAX_PAYLOAD_BYTES = 262_144 as const;

/** Human observer protocol version (distinct from Agent Host protocol). */
export const HUMAN_OBSERVER_PROTOCOL_VERSION = 1 as const;

/** Default HTTPS request timeout. */
export const COLLABORATION_REQUEST_TIMEOUT_MS = 30_000 as const;

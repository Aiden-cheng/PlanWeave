/**
 * Bounds for human identity, membership, invitations, and device credentials.
 * String budgets are UTF-16 code units unless noted. Secrets are never stored;
 * only digests appear in durable metadata schemas.
 */

/** Opaque id max length (aligned with agent-host-protocol wire identifiers). */
export const HUMAN_OPAQUE_ID_MAX_LENGTH = 128 as const;

/** Human principal / device label display name budget. */
export const HUMAN_DISPLAY_NAME_MIN_LENGTH = 1 as const;
export const HUMAN_DISPLAY_NAME_MAX_LENGTH = 128 as const;
export const HUMAN_DEVICE_LABEL_MAX_LENGTH = 64 as const;

/** Comment/assign free-text bodies used by later HC blocks; validated here as shared bounds. */
export const HUMAN_COMMENT_BODY_MAX_LENGTH = 16_384 as const;
export const HUMAN_ASSIGN_REASON_MAX_LENGTH = 512 as const;

/** Invitation and device token wire shape: prefix + 43 base64url chars (~256 bits). */
export const HUMAN_DEVICE_TOKEN_PREFIX = "pw_hdev_" as const;
export const PROJECT_INVITATION_TOKEN_PREFIX = "pw_inv_" as const;
export const HUMAN_TOKEN_SECRET_CHAR_LENGTH = 43 as const;

/** SHA-256 digest as lowercase hex (token secrets never appear in metadata). */
export const TOKEN_SHA256_HEX_LENGTH = 64 as const;

/** Invitation time-to-live bounds. */
export const PROJECT_INVITATION_MIN_TTL_MS = 60_000 as const;
export const PROJECT_INVITATION_MAX_TTL_MS = 604_800_000 as const; // 7 days
export const PROJECT_INVITATION_DEFAULT_TTL_MS = 86_400_000 as const; // 24 hours
/** Successful invitation-create replays retain plaintext only in process for five minutes. */
export const PROJECT_INVITATION_IDEMPOTENCY_CACHE_TTL_MS = 300_000 as const;
/** Bounds plaintext-bearing invitation-create replay entries retained by one Server process. */
export const PROJECT_INVITATION_IDEMPOTENCY_CACHE_MAX_ENTRIES = 1_000 as const;

/** Optional device credential lifetime (omit expiry for non-expiring until revoke). */
export const HUMAN_DEVICE_MIN_TTL_MS = 60_000 as const;
export const HUMAN_DEVICE_MAX_TTL_MS = 31_536_000_000 as const; // 365 days

/** Count caps for a single project / principal. */
export const HUMAN_MAX_MEMBERS_PER_PROJECT = 256 as const;
export const HUMAN_MAX_OPEN_INVITATIONS_PER_PROJECT = 64 as const;
export const HUMAN_MAX_DEVICES_PER_PRINCIPAL = 32 as const;
export const HUMAN_MAX_DEVICES_LISTED_PER_PAGE = 100 as const;
export const HUMAN_MAX_MEMBERS_LISTED_PER_PAGE = 100 as const;
export const HUMAN_MAX_INVITATIONS_LISTED_PER_PAGE = 100 as const;

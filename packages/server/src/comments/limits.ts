/**
 * Bounds for scoped Task/Block comments, attachment metadata, and activity projections.
 * Comments annotate authoritative work; they never drive Runtime claim/submit/review state.
 */

/** Reuse identity comment body budget (UTF-16 code units). */
export {
  HUMAN_COMMENT_BODY_MAX_LENGTH as COMMENT_BODY_MAX_LENGTH
} from "../identity/limits.js";

export const COMMENT_BODY_MIN_LENGTH = 1 as const;

/** Body is Markdown source only — never HTML, never rendered markup. */
export const COMMENT_BODY_FORMAT = "markdown" as const;

/** Maximum finalized attachments referenced by one comment. */
export const COMMENT_ATTACHMENTS_MAX_COUNT = 8 as const;

/**
 * Per-attachment byte budget for human comment blobs.
 * Separate from dispatch artifact grants; authorization is human membership + comment scope.
 */
export const COMMENT_ATTACHMENT_MAX_BYTES = 8_388_608 as const; // 8 MiB

export const COMMENT_ATTACHMENT_FILENAME_MIN_LENGTH = 1 as const;
export const COMMENT_ATTACHMENT_FILENAME_MAX_LENGTH = 255 as const;

/** Staged (pending) upload lifetime before cleanup (B-002 enforces). */
export const COMMENT_STAGED_UPLOAD_TTL_MS = 3_600_000 as const; // 1 hour
export const COMMENT_STAGED_UPLOAD_MIN_TTL_MS = 60_000 as const;
export const COMMENT_STAGED_UPLOAD_MAX_TTL_MS = 86_400_000 as const; // 24h

/**
 * Allowlisted media types for comment attachments.
 * Broader artifact media types may exist for dispatch; comments stay narrowly human-readable.
 */
export const COMMENT_ATTACHMENT_ALLOWED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown"
] as const;

/** List page bounds. */
export const COMMENT_LIST_PAGE_MIN = 1 as const;
export const COMMENT_LIST_PAGE_MAX = 50 as const;
export const COMMENT_LIST_PAGE_DEFAULT = 20 as const;

export const ACTIVITY_LIST_PAGE_MIN = 1 as const;
export const ACTIVITY_LIST_PAGE_MAX = 50 as const;
export const ACTIVITY_LIST_PAGE_DEFAULT = 20 as const;

/** Bounded activity headline for UI; never prompts, tokens, or ACP streams. */
export const ACTIVITY_HEADLINE_MAX_LENGTH = 256 as const;
export const ACTIVITY_SUBJECTS_MAX_COUNT = 8 as const;

/**
 * Soft retention guidance for operators (storage enforcement is B-003).
 * Activity is append-only; tombstoned comments remain for audit.
 */
export const ACTIVITY_RETENTION_MAX_AGE_MS = 31_536_000_000 as const; // 365d
export const COMMENT_TOMBSTONE_RETENTION_INDEFINITE = true as const;

/**
 * First durable comment write uses revision 1.
 * Edits and tombstones compare-and-set against the current positive revision.
 */
export const COMMENT_INITIAL_REVISION = 1 as const;

/** Optional free-text reason budgets for tombstone moderation notes. */
export const COMMENT_TOMBSTONE_REASON_MAX_LENGTH = 512 as const;

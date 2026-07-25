import { z } from "zod";

/**
 * Stable public error body from human collaboration HTTP surfaces.
 * Message text is optional and must never contain tokens or digests.
 */
export const collaborationErrorBodySchema = z
  .object({
    error: z.string().min(1).max(128),
    message: z.string().min(1).max(512).optional()
  })
  .strict();
export type CollaborationErrorBody = z.infer<typeof collaborationErrorBodySchema>;

/**
 * Typed boundary error kinds for the Desktop CollaborationClient.
 * Maps HTTP/protocol/auth/rate/conflict/offline failures without leaking secrets.
 */
export const collaborationBoundaryErrorKindSchema = z.enum([
  "auth",
  "forbidden",
  "conflict",
  "rate_limited",
  "offline",
  "protocol",
  "validation",
  "timeout",
  "aborted",
  "payload_too_large",
  "not_found",
  "insecure_transport",
  "unknown"
]);
export type CollaborationBoundaryErrorKind = z.infer<typeof collaborationBoundaryErrorKindSchema>;

export const collaborationBoundaryErrorSchema = z
  .object({
    kind: collaborationBoundaryErrorKindSchema,
    code: z.string().min(1).max(128),
    httpStatus: z.number().int().positive().max(599).optional(),
    retryable: z.boolean()
  })
  .strict();
export type CollaborationBoundaryErrorShape = z.infer<typeof collaborationBoundaryErrorSchema>;

export function mapHttpStatusToBoundaryKind(
  status: number,
  code?: string
): CollaborationBoundaryErrorKind {
  if (status === 401 || code?.includes("unauthenticated") || code?.includes("auth_expired")) {
    return "auth";
  }
  if (status === 403 || code?.includes("forbidden") || code?.includes("role_insufficient")) {
    return "forbidden";
  }
  if (status === 404) return "not_found";
  if (status === 409 || code?.includes("conflict") || code?.includes("revision_conflict")) {
    return "conflict";
  }
  if (status === 413 || code?.includes("too_large") || code?.includes("body_too_large")) {
    return "payload_too_large";
  }
  if (status === 426 || code?.includes("insecure_transport")) return "insecure_transport";
  if (status === 429 || code?.includes("rate_limited")) return "rate_limited";
  if (status === 400 || code?.includes("input_invalid") || code?.includes("validation")) {
    return "validation";
  }
  if (status >= 500) return "offline";
  return "unknown";
}

export function isRetryableBoundaryKind(kind: CollaborationBoundaryErrorKind): boolean {
  return kind === "offline" || kind === "rate_limited" || kind === "timeout";
}

import {
  collaborationErrorBodySchema,
  isRetryableBoundaryKind,
  mapHttpStatusToBoundaryKind,
  type CollaborationBoundaryErrorKind
} from "@planweave-ai/collaboration-protocol/errors";
import { redactCollaborationText } from "./redaction.js";

export class CollaborationClientError extends Error {
  readonly kind: CollaborationBoundaryErrorKind;
  readonly code: string;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;

  constructor(input: {
    kind: CollaborationBoundaryErrorKind;
    code: string;
    message?: string;
    httpStatus?: number;
    retryAfterMs?: number;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(input.message ?? input.code);
    this.name = "CollaborationClientError";
    this.kind = input.kind;
    this.code = input.code;
    this.httpStatus = input.httpStatus;
    this.retryAfterMs = input.retryAfterMs;
    this.retryable = input.retryable ?? isRetryableBoundaryKind(input.kind);
    if (input.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = input.cause;
    }
  }
}

export function collaborationErrorFromHttp(
  status: number,
  bodyText: string,
  retryAfterHeader?: string | null
): CollaborationClientError {
  let code = `http_${status}`;
  let message: string | undefined;
  try {
    const parsed = collaborationErrorBodySchema.safeParse(JSON.parse(bodyText));
    if (parsed.success) {
      code = parsed.data.error;
      message = parsed.data.message;
    }
  } catch {
    // Non-JSON error bodies are common for proxies; keep generic code.
  }
  const kind = mapHttpStatusToBoundaryKind(status, code);
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  return new CollaborationClientError({
    kind,
    code,
    message,
    httpStatus: status,
    retryAfterMs,
    retryable: isRetryableBoundaryKind(kind)
  });
}

function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds * 1_000);
  }
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return undefined;
  const remaining = retryAt - Date.now();
  return remaining > 0 ? remaining : undefined;
}

export function collaborationErrorFromUnknown(error: unknown): CollaborationClientError {
  if (error instanceof CollaborationClientError) {
    const redacted = redactCollaborationText(error.message);
    if (redacted === error.message) return error;
    return new CollaborationClientError({
      kind: error.kind,
      code: error.code,
      message: redacted,
      httpStatus: error.httpStatus,
      retryAfterMs: error.retryAfterMs,
      retryable: error.retryable,
      cause: error
    });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new CollaborationClientError({
      kind: "aborted",
      code: "collaboration_aborted",
      message: "Request was aborted.",
      retryable: false,
      cause: error
    });
  }
  if (error instanceof Error && /timeout|Timeout/i.test(error.message)) {
    return new CollaborationClientError({
      kind: "timeout",
      code: "collaboration_timeout",
      message: "Request timed out.",
      retryable: true,
      cause: error
    });
  }
  if (error instanceof TypeError) {
    return new CollaborationClientError({
      kind: "offline",
      code: "collaboration_offline",
      message: "Network request failed.",
      retryable: true,
      cause: error
    });
  }
  return new CollaborationClientError({
    kind: "unknown",
    code: "collaboration_unknown",
    message: redactCollaborationText(
      error instanceof Error ? error.message : "Unknown collaboration error."
    ),
    retryable: false,
    cause: error
  });
}

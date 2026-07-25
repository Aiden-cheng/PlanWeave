import {
  collaborationErrorBodySchema,
  isRetryableBoundaryKind,
  mapHttpStatusToBoundaryKind,
  type CollaborationBoundaryErrorKind
} from "@planweave-ai/collaboration-contracts";
import { redactCollaborationText } from "./redaction.js";

export class CollaborationClientError extends Error {
  readonly kind: CollaborationBoundaryErrorKind;
  readonly code: string;
  readonly httpStatus?: number;
  readonly retryable: boolean;

  constructor(input: {
    kind: CollaborationBoundaryErrorKind;
    code: string;
    message?: string;
    httpStatus?: number;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(input.message ?? input.code);
    this.name = "CollaborationClientError";
    this.kind = input.kind;
    this.code = input.code;
    this.httpStatus = input.httpStatus;
    this.retryable = input.retryable ?? isRetryableBoundaryKind(input.kind);
    if (input.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = input.cause;
    }
  }
}

export function collaborationErrorFromHttp(
  status: number,
  bodyText: string
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
  return new CollaborationClientError({
    kind,
    code,
    message,
    httpStatus: status,
    retryable: isRetryableBoundaryKind(kind)
  });
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

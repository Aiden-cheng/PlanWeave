import {
  collaborationErrorBodySchema,
  isRetryableBoundaryKind,
  mapHttpStatusToBoundaryKind,
  type CollaborationBoundaryErrorKind
} from "@planweave-ai/collaboration-protocol/errors";
import type { DeploymentTopology } from "@planweave-ai/collaboration-protocol/connection";
import { redactCollaborationText } from "./redaction.js";

export const COLLABORATION_CONNECTION_ERROR_CODES = {
  serverUnreachable: "SERVER_UNREACHABLE",
  tailnetUnreachable: "TAILNET_UNREACHABLE",
  workspaceForbidden: "WORKSPACE_FORBIDDEN",
  workspaceUnauthorized: "WORKSPACE_UNAUTHORIZED"
} as const;

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

/**
 * Converts transport/auth failures into the stable connection semantics shown during onboarding.
 * The topology comes from the validated handoff/profile; hostnames are never guessed as Tailscale.
 */
export function collaborationConnectionErrorFromUnknown(
  error: unknown,
  topology?: DeploymentTopology
): CollaborationClientError {
  const mapped = collaborationErrorFromUnknown(error);
  if ((mapped.kind === "offline" || mapped.kind === "timeout") && mapped.httpStatus === undefined) {
    const tailnet = topology === "tailscale_https";
    return new CollaborationClientError({
      kind: mapped.kind,
      code: tailnet
        ? COLLABORATION_CONNECTION_ERROR_CODES.tailnetUnreachable
        : COLLABORATION_CONNECTION_ERROR_CODES.serverUnreachable,
      message: tailnet
        ? "The Server could not be reached through the configured tailnet endpoint."
        : "The configured Server could not be reached.",
      httpStatus: mapped.httpStatus,
      retryAfterMs: mapped.retryAfterMs,
      retryable: true,
      cause: mapped
    });
  }
  if (mapped.kind === "forbidden" && mapped.httpStatus === 403) {
    return new CollaborationClientError({
      kind: mapped.kind,
      code: COLLABORATION_CONNECTION_ERROR_CODES.workspaceForbidden,
      message: "The Server is reachable, but this identity cannot access the Workspace.",
      httpStatus: mapped.httpStatus,
      retryAfterMs: mapped.retryAfterMs,
      retryable: false,
      cause: mapped
    });
  }
  if (mapped.kind === "auth" && mapped.httpStatus === 401) {
    return new CollaborationClientError({
      kind: mapped.kind,
      code: COLLABORATION_CONNECTION_ERROR_CODES.workspaceUnauthorized,
      message: "The Server is reachable, but Workspace authentication was not accepted.",
      httpStatus: mapped.httpStatus,
      retryAfterMs: mapped.retryAfterMs,
      retryable: false,
      cause: mapped
    });
  }
  return mapped;
}

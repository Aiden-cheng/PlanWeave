import type {
  CollaborationBoundaryErrorView,
  CollaborationSyncPhase
} from "../../shared/collaborationReadModels.js";

export function collaborationBoundaryErrorFromUnknown(
  error: unknown
): CollaborationBoundaryErrorView {
  if (
    error &&
    typeof error === "object" &&
    "kind" in error &&
    "code" in error &&
    typeof (error as { kind: unknown }).kind === "string" &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    const typed = error as {
      kind: string;
      code: string;
      message?: string;
      httpStatus?: number;
      retryAfterMs?: number;
      retryable?: boolean;
    };
    return {
      kind: typed.kind,
      code: typed.code,
      message: typed.message ?? typed.code,
      httpStatus: typed.httpStatus,
      retryAfterMs: typed.retryAfterMs,
      retryable: typed.retryable ?? false
    };
  }
  return {
    kind: "unknown",
    code: "collaboration_unknown",
    message: error instanceof Error ? error.message : String(error),
    retryable: false
  };
}

export function syncPhaseAfterCollaborationBoundaryError(
  current: CollaborationSyncPhase,
  error: CollaborationBoundaryErrorView
): CollaborationSyncPhase {
  if (error.kind === "auth") return "auth_expired";
  if (error.kind === "forbidden") return "forbidden";
  if (error.kind === "conflict") return "stale_conflict";
  if (error.kind === "offline" || error.kind === "timeout") {
    if (current === "ready" || current === "degraded") return "degraded";
    return current === "loading" ? "disconnected" : current;
  }
  return current === "loading" || current === "ready" ? "degraded" : current;
}

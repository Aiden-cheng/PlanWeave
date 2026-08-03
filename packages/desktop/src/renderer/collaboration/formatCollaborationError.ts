import type { CollaborationBoundaryErrorView } from "../../shared/collaborationReadModels.js";
import type { createTranslator } from "../i18n";
import {
  formatCollaborationBoundaryError,
  formatUnknownCollaborationError
} from "./peopleViewModels.js";

export function collaborationErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

export function collaborationErrorMessage(
  error: CollaborationBoundaryErrorView | unknown | null | undefined
): string {
  if (error == null) {
    return "collaboration_error";
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    "kind" in error &&
    "retryable" in error
  ) {
    return (
      formatCollaborationBoundaryError(error as CollaborationBoundaryErrorView) ??
      "collaboration_error"
    );
  }
  return formatUnknownCollaborationError(error);
}

export function isCollaborationConnectionUnavailable(error: unknown): boolean {
  const code = collaborationErrorCode(error);
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const kind = typeof record?.kind === "string" ? record.kind : null;
  const message =
    error instanceof Error
      ? error.message
      : typeof record?.message === "string"
        ? record.message
        : null;
  return (
    kind === "offline" ||
    kind === "network" ||
    kind === "timeout" ||
    code === "collaboration_offline" ||
    code === "collaboration_timeout" ||
    code === "network_unreachable" ||
    code === "canvas_replica_session_disconnected" ||
    (message !== null &&
      /fetch failed|network request failed|network unreachable|timed?\s*out|canvas_replica_session_disconnected/i.test(
        message
      ))
  );
}

export function collaborationConnectionErrorMessage(
  t: ReturnType<typeof createTranslator>,
  error: unknown
): string {
  if (isCollaborationConnectionUnavailable(error)) {
    return t("peopleServerUnreachable");
  }
  return collaborationErrorMessage(error);
}

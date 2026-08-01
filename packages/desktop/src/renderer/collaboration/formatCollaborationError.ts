import type { CollaborationBoundaryErrorView } from "../../shared/collaborationReadModels.js";
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

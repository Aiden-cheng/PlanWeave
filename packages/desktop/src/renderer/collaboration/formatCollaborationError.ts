import type { CollaborationBoundaryErrorView } from "../../shared/collaborationReadModels.js";
import {
  formatCollaborationBoundaryError,
  formatUnknownCollaborationError
} from "./peopleViewModels.js";

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

import type { CollaborationSessionPhase } from "../../shared/collaboration.js";

type CollaborationSessionStatus = {
  session: { phase: CollaborationSessionPhase };
};

/** Live collaboration APIs are available only after the client session is connected. */
export function isCollaborationSessionConnected(
  status: CollaborationSessionStatus | null | undefined
): boolean {
  return status?.session.phase === "connected";
}

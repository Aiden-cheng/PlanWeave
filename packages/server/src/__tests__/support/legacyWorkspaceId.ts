import { createHash } from "node:crypto";

export function legacyWorkspaceIdForProject(projectId: string): string {
  return `workspace-legacy-${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}`;
}

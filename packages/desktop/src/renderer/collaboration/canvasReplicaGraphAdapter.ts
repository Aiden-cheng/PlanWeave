import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import type { CollaborationCanvasReplicaProjection } from "../../shared/canvasReplicaIpc.js";

/**
 * Explicitly adapts replica-owned content to the renderer graph surface. Runtime execution
 * configuration is unavailable from a durable content replica, so it is deliberately empty.
 */
export function canvasReplicaProjectionToDesktopGraph(
  projection: CollaborationCanvasReplicaProjection
): DesktopGraphViewModel {
  return {
    projectId: projection.localProjectId,
    projectTitle: projection.content.projectTitle,
    graphVersion: projection.content.graphVersion,
    packageFingerprint: projection.content.packageFingerprint,
    executorOptions: [],
    packageExecutorNames: [],
    autoRunPreflightExecutorHint: null,
    tasks: projection.content.tasks,
    edges: projection.content.edges,
    sharedResourceGroups: projection.content.sharedResourceGroups,
    diagnostics: projection.content.diagnostics,
    dirtyPromptRefs: []
  };
}

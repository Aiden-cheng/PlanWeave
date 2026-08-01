import {
  canvasRuntimeStatusProjectionSchema,
  type CanvasRuntimeStatusProjection
} from "@planweave-ai/collaboration-contracts";
import { loadPlanGraphPackage } from "../plangraph/index.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import { loadDesktopGraphViewModelContext } from "./graph/readModel.js";

export type ReadAuthorizedCanvasRuntimeStatusInput = {
  projectRoot: string;
  canvasId: string;
  expectedPackageDir: string;
  scope: CanvasRuntimeStatusProjection["scope"];
  capturedAt?: string;
};

/**
 * Projects the owner Runtime state into the small, path-free status surface that
 * collaborators may read. Run identifiers, feedback bodies, ownership leases,
 * device paths, and executor state never cross this boundary.
 */
export async function readAuthorizedCanvasRuntimeStatus(
  input: ReadAuthorizedCanvasRuntimeStatusInput
): Promise<CanvasRuntimeStatusProjection> {
  const workspace = await resolveTaskCanvasWorkspace(input.projectRoot, input.canvasId);
  if (workspace.packageDir !== input.expectedPackageDir) {
    throw new Error("runtime_package_location_mismatch");
  }
  const context = await loadDesktopGraphViewModelContext(workspace);
  const planGraphPackage = await loadPlanGraphPackage(workspace);
  return canvasRuntimeStatusProjectionSchema.parse({
    schemaVersion: "canvas-runtime-status/v1",
    scope: input.scope,
    packageFingerprint: planGraphPackage.graph.packageFingerprint,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    tasks: context.status.tasks.map((task) => ({
      taskId: task.taskId,
      status: task.status,
      openFeedbackCount: task.openFeedbackCount
    })),
    blocks: context.status.blocks.map((block) => {
      const state = context.state.blocks[block.ref];
      if (!state) throw new Error(`runtime_block_state_missing:${block.ref}`);
      return {
        ref: block.ref,
        status: block.status,
        completionReason: state.completionReason ?? null,
        blockedReason: state.blockedReason ?? null,
        divergenceReason: state.divergenceReason ?? null
      };
    })
  });
}

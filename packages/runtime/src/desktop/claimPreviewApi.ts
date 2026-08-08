import { loadPackage } from "../package/loadPackage.js";
import { claimNext } from "../taskManager/claimScheduler.js";
import type { ClaimResult } from "../types.js";
import { resolveTaskCanvasWorkspace } from "./canvasApi.js";
import { claimScope } from "./runStepState.js";
import type { DesktopAutoRunScope } from "./types.js";

/**
 * Dry-run the next claim unit for Desktop (no state mutation).
 * Parallel decision mirrors startAutoRun / runAutoRunStep:
 * use package parallel default when options.parallel is omitted;
 * if parallel dryRun yields none/no_parallel_blocks, retry sequential.
 */
export async function previewClaimNext(
  projectRoot: string,
  canvasId: string | null | undefined,
  scope: DesktopAutoRunScope = { kind: "project" },
  options?: { parallel?: boolean }
): Promise<ClaimResult> {
  const workspace = await resolveTaskCanvasWorkspace(projectRoot, canvasId);
  let parallel = options?.parallel;
  if (parallel === undefined) {
    const { manifest } = await loadPackage(workspace);
    parallel = manifest.execution.parallel.enabled;
  }

  let claim = await claimNext({
    projectRoot: workspace,
    scope: claimScope(scope),
    dryRun: true,
    parallel
  });

  if (parallel && claim.kind === "none" && claim.reason === "no_parallel_blocks") {
    claim = await claimNext({
      projectRoot: workspace,
      scope: claimScope(scope),
      dryRun: true
    });
  }

  return claim;
}

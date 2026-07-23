import type { PackageWorkspaceRef } from "../types.js";
import { commandCanvasIdForWorkspace } from "./canvasCommandScope.js";
import { projectBlockerReason } from "./claimReadinessRules.js";
import { createProjectGraphClaimGuard } from "./projectGraphClaimGuard.js";
import {
  remoteBlockDispatchCandidateSchema,
  RemoteBlockRuntimeError,
  type RemoteBlockDispatchCandidate
} from "./remoteBlockRuntimeContracts.js";
import { sameRemoteBlockSource } from "./remoteBlockSource.js";
import {
  assertRemoteBlockSnapshotDependencies,
  remoteBlockSourceSnapshot
} from "./remoteBlockSourceSnapshot.js";
import { loadRuntimeReadonly, type RuntimeContext } from "./runtimeContext.js";
import {
  canDispatchImplementationBlock,
  effectiveBlockExecutor,
  validateClaimScope
} from "./selectors.js";

export function assertRemoteBlockImplementation(context: RuntimeContext, ref: string): void {
  const invalidScope = validateClaimScope({ kind: "block", blockRef: ref }, context.graph);
  if (invalidScope) {
    const reason = "reason" in invalidScope ? invalidScope.reason : undefined;
    throw new RemoteBlockRuntimeError(
      "remote_block_not_found",
      reason ?? `Block '${ref}' does not exist.`
    );
  }
  if (context.graph.blocksByRef.get(ref)?.type !== "implementation") {
    throw new RemoteBlockRuntimeError(
      "remote_block_not_implementation",
      `Remote dispatch supports implementation blocks only; '${ref}' is not dispatchable.`
    );
  }
}

export async function assertRemoteBlockDispatchable(
  context: RuntimeContext,
  ref: string
): Promise<void> {
  assertRemoteBlockImplementation(context, ref);
  const taskId = context.graph.blockTaskByRef.get(ref);
  const blocker = projectBlockerReason(await createProjectGraphClaimGuard(context), taskId);
  if (blocker) {
    throw new RemoteBlockRuntimeError("remote_block_not_dispatchable", blocker);
  }
  if (
    !canDispatchImplementationBlock(context.graph, context.state, ref, {
      maxConcurrent: context.manifest.execution.parallel.maxConcurrent
    })
  ) {
    throw new RemoteBlockRuntimeError(
      "remote_block_not_dispatchable",
      `Block '${ref}' is not dispatchable right now.`
    );
  }
}

export async function inspectRemoteBlockCandidate(
  projectRoot: PackageWorkspaceRef,
  ref: string
): Promise<RemoteBlockDispatchCandidate> {
  const context = await loadRuntimeReadonly({ projectRoot });
  await assertRemoteBlockDispatchable(context, ref);
  const sourceBefore = await remoteBlockSourceSnapshot(context, ref);
  assertRemoteBlockSnapshotDependencies(sourceBefore, ref);
  const afterContext = await loadRuntimeReadonly({ projectRoot: context.workspace });
  const sourceAfter = await remoteBlockSourceSnapshot(afterContext, ref);
  if (!sameRemoteBlockSource(sourceBefore, sourceAfter)) {
    throw new RemoteBlockRuntimeError(
      "remote_block_source_changed",
      `Remote source changed while inspecting '${ref}'; inspect again.`
    );
  }
  const taskId = context.graph.blockTaskByRef.get(ref)!;
  const task = context.graph.tasksById.get(taskId)!;
  const effectiveExecutor = effectiveBlockExecutor(
    context.graph,
    ref,
    context.manifest.execution.defaultExecutor
  );
  const { executorRunnerEvidenceForManifest } = await import("../autoRun/executors.js");
  const runner = executorRunnerEvidenceForManifest(context.manifest, effectiveExecutor);
  if (runner.runnerKind !== "acp" || !runner.agentId) {
    throw new RemoteBlockRuntimeError(
      "remote_block_executor_not_acp",
      `Executor '${effectiveExecutor}' for '${ref}' is not an ACP agent profile.`
    );
  }
  return remoteBlockDispatchCandidateSchema.parse({
    projectId: context.workspace.id,
    canvasId: (await commandCanvasIdForWorkspace(context.workspace)) ?? "default",
    taskId,
    blockRef: ref,
    blockType: "implementation",
    sourceRevision: sourceBefore.sourceRevision,
    graphFingerprint: sourceBefore.graphFingerprint,
    renderedPrompt: sourceBefore.renderedPrompt,
    acceptance: task.acceptance,
    dependencySummaries: sourceBefore.dependencySummaries,
    inputArtifacts: sourceBefore.inputArtifacts,
    workspaceId: context.workspace.id,
    effectiveExecutor,
    agentId: runner.agentId,
    agentProfileId: effectiveExecutor,
    session: {},
    requiredCapabilities: context.graph.requiredCapabilitiesByBlockRef.get(ref) ?? []
  });
}

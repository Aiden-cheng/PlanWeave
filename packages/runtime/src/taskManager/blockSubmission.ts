import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OUTPUT_MAX_ARTIFACT_BYTES } from "@planweave-ai/agent-host-protocol";
import {
  materializeArtifactBytes,
  readVerifiedArtifactReference,
  type ArtifactMaterializationHooks
} from "../autoRun/artifactReferenceContract.js";
import type { ArtifactReference } from "../autoRun/runnerContractSchemas.js";
import { allocateRunId } from "../autoRun/executorShared.js";
import { upsertBlockRunInIndex } from "../autoRun/blockRunIndex.js";
import { optionalReaddir } from "../fs/optionalFile.js";
import { withCanvasLock } from "../fs/withCanvasLock.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { writeJsonFile } from "../json.js";
import { loadPackage } from "../package/loadPackage.js";
import { writeState } from "../state.js";
import type {
  ExecutionGraphSession,
  PackageWorkspaceRef,
  ProjectWorkspace,
  SubmitResult
} from "../types.js";
import {
  readImplementationRunMetadataFile,
  type ImplementationRunMetadata
} from "./implementationRunMetadata.js";
import { exists, loadRuntime, refreshDerivedState } from "./runtimeContext.js";
import { getBlock } from "./selectors.js";
import { incrementTaskIndexCount, readTaskIndex, updateTaskIndex } from "./resultIndex.js";
import { withoutRemoteBlockOwnership } from "./remoteOwnershipTransitions.js";
import {
  assertActiveRemoteBlockOwnership,
  completeRemoteBlockOwnership,
  matchesRemoteOperationReceipt,
  markRemoteBlockOwnershipSourceDrift,
  type ActiveRemoteOperationIdentity
} from "./remoteOwnershipTransitions.js";
import {
  remoteBlockCompletionInputSchema,
  RemoteBlockRuntimeError,
  type RemoteBlockCompletionInput
} from "./remoteBlockRuntimeContracts.js";
import { remoteBlockSourceEvidence } from "./remoteBlockSource.js";

type BlockSubmissionArtifact =
  | { mode: "legacy"; bytes: Buffer }
  | { mode: "verified"; reference: ArtifactReference; bytes: Buffer };

type SubmissionAuthority =
  | { kind: "local" }
  | { kind: "remote"; identity: ActiveRemoteOperationIdentity };

async function runHasSubmittedResult(
  runDir: string,
  ref: string,
  runId: string,
  artifact: BlockSubmissionArtifact
): Promise<boolean> {
  const metadataPath = join(runDir, "metadata.json");
  const reportPath = join(runDir, "report.md");
  if (!((await exists(metadataPath)) && (await exists(reportPath)))) {
    return false;
  }
  const metadata = await readImplementationRunMetadataFile(metadataPath);
  if (metadata.ref !== ref || metadata.runId !== runId) {
    return false;
  }
  const reportHash = createHash("sha256").update(artifact.bytes).digest("hex");
  if (metadata.reportHash !== reportHash) {
    return false;
  }
  let persistedBytes: Buffer;
  if (artifact.mode === "verified") {
    const persisted = await readVerifiedArtifactReference({
      rootDir: runDir,
      value: metadata.artifactReference
    });
    if (
      persisted.reference.version !== artifact.reference.version ||
      persisted.reference.kind !== artifact.reference.kind ||
      persisted.reference.relativePath !== artifact.reference.relativePath ||
      persisted.reference.sha256 !== artifact.reference.sha256 ||
      persisted.reference.sizeBytes !== artifact.reference.sizeBytes ||
      persisted.reference.mediaType !== artifact.reference.mediaType
    ) {
      throw new Error(`Persisted artifact reference for run '${runId}' does not match submission.`);
    }
    persistedBytes = persisted.bytes;
  } else {
    persistedBytes = await readFile(reportPath);
  }
  if (!persistedBytes.equals(artifact.bytes)) {
    throw new Error(`Persisted report for run '${runId}' does not match its submitted hash.`);
  }
  return true;
}

async function findPersistedRun(
  workspace: ProjectWorkspace,
  taskId: string,
  blockId: string,
  ref: string,
  artifact: BlockSubmissionArtifact
): Promise<string | null> {
  const runRoot = join(workspace.resultsDir, taskId, "blocks", blockId, "runs");
  const index = await readTaskIndex(workspace, taskId);
  const indexedRunId = index.latestRunByBlock?.[ref];
  if (
    indexedRunId &&
    (await runHasSubmittedResult(join(runRoot, indexedRunId), ref, indexedRunId, artifact))
  ) {
    return indexedRunId;
  }
  const entries = await optionalReaddir(runRoot, { withFileTypes: true });
  if (!entries) {
    return null;
  }
  const runIds = entries
    .filter((entry) => entry.isDirectory() && /^RUN-\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const runId of runIds) {
    if (await runHasSubmittedResult(join(runRoot, runId), ref, runId, artifact)) {
      return runId;
    }
  }
  return null;
}

export async function submitBlockResult(options: {
  projectRoot: PackageWorkspaceRef;
  ref: string;
  reportPath: string;
  runId?: string;
  session?: ExecutionGraphSession;
}): Promise<SubmitResult> {
  return submitBlockResultFromBytes(options, await readFile(options.reportPath));
}

export async function submitBlockResultFromBytes(
  options: {
    projectRoot: PackageWorkspaceRef;
    ref: string;
    reportPath: string;
    runId?: string;
    session?: ExecutionGraphSession;
  },
  reportBytes: Buffer
): Promise<SubmitResult> {
  return submitBlockResultArtifact(options, { mode: "legacy", bytes: reportBytes });
}

export async function submitVerifiedBlockResult(
  options: {
    projectRoot: PackageWorkspaceRef;
    ref: string;
    reportPath: string;
    runId?: string;
    session?: ExecutionGraphSession;
  },
  artifact: { reference: ArtifactReference; bytes: Buffer },
  hooks: ArtifactMaterializationHooks = {}
): Promise<SubmitResult> {
  return submitBlockResultArtifact(
    options,
    { mode: "verified", reference: artifact.reference, bytes: artifact.bytes },
    hooks,
    { kind: "local" }
  );
}

export async function submitRemoteBlockResult(
  options: { projectRoot: PackageWorkspaceRef } & RemoteBlockCompletionInput,
  hooks: ArtifactMaterializationHooks = {}
): Promise<SubmitResult> {
  const { projectRoot: _projectRoot, ...portableInput } = options;
  const input = remoteBlockCompletionInputSchema.parse(portableInput);
  const bytes = Buffer.from(input.reportBytes);
  if (bytes.byteLength > OUTPUT_MAX_ARTIFACT_BYTES) {
    throw new RemoteBlockRuntimeError(
      "remote_block_result_conflict",
      `Remote report exceeds the ${OUTPUT_MAX_ARTIFACT_BYTES}-byte output limit.`
    );
  }
  const sha256 = input.reportArtifactRef.slice("artifact:sha256:".length);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== actualSha256) {
    throw new RemoteBlockRuntimeError(
      "remote_block_result_conflict",
      "Remote report artifact reference does not match the supplied bytes."
    );
  }
  return submitBlockResultArtifact(
    {
      projectRoot: options.projectRoot,
      ref: input.ref
    },
    {
      mode: "verified",
      reference: {
        version: "planweave.runner/v1",
        kind: "implementation",
        relativePath: "report.md",
        sha256,
        sizeBytes: bytes.byteLength,
        mediaType: "text/markdown"
      },
      bytes
    },
    hooks,
    {
      kind: "remote",
      identity: {
        operationId: input.operationId,
        sourceRevision: input.sourceRevision,
        graphFingerprint: input.graphFingerprint,
        dispatchId: input.dispatchId,
        executionAttemptId: input.executionAttemptId
      }
    }
  );
}

async function submitBlockResultArtifact(
  options: {
    projectRoot: PackageWorkspaceRef;
    ref: string;
    reportPath?: string;
    runId?: string;
    session?: ExecutionGraphSession;
  },
  artifact: BlockSubmissionArtifact,
  hooks: ArtifactMaterializationHooks = {},
  authority: SubmissionAuthority = { kind: "local" }
): Promise<SubmitResult> {
  const reportHash = createHash("sha256").update(artifact.bytes).digest("hex");
  if (
    artifact.mode === "verified" &&
    (artifact.reference.kind !== "implementation" ||
      artifact.reference.relativePath !== "report.md" ||
      artifact.reference.sha256 !== reportHash ||
      artifact.reference.sizeBytes !== artifact.bytes.byteLength)
  ) {
    throw new Error("Verified implementation artifact reference does not match its bytes.");
  }
  const { workspace: lockWorkspace } = await loadPackage(options.projectRoot);
  return withCanvasLock(dirname(lockWorkspace.stateFile), async () => {
    const context = await loadRuntime(options);
    const { workspace, manifest, graph } = context;
    let { state } = context;
    const { taskId, blockId } = parseBlockRef(options.ref);
    const block = getBlock(graph, options.ref);
    if (block.type === "review") {
      throw new Error("submit-result only accepts implementation blocks.");
    }
    const blockState = state.blocks[options.ref];
    if (authority.kind === "local" && blockState?.remoteOwnership) {
      throw new Error(
        `Remote-owned block '${options.ref}' must be completed through the remote operation port.`
      );
    }
    if (authority.kind === "local" && blockState?.remoteOperationReceipt) {
      throw new Error(
        `Remote-completed block '${options.ref}' cannot be replayed through local submit-result.`
      );
    }
    if (authority.kind === "remote" && blockState?.remoteOperationReceipt) {
      if (
        blockState.remoteOperationReceipt.outcome !== "completed" ||
        !matchesRemoteOperationReceipt(blockState.remoteOperationReceipt, authority.identity)
      ) {
        throw new RemoteBlockRuntimeError(
          "remote_block_result_conflict",
          `Remote completion for '${options.ref}' conflicts with its terminal operation receipt.`
        );
      }
      const receiptRunId = blockState.remoteOperationReceipt.runId;
      const receiptRunDir = join(
        workspace.resultsDir,
        taskId,
        "blocks",
        blockId,
        "runs",
        receiptRunId
      );
      if (!(await runHasSubmittedResult(receiptRunDir, options.ref, receiptRunId, artifact))) {
        throw new RemoteBlockRuntimeError(
          "remote_block_result_conflict",
          `Remote completion receipt for '${options.ref}' does not match the submitted report.`
        );
      }
      return { ref: options.ref, runId: receiptRunId, status: "completed" };
    }
    if (authority.kind === "remote") {
      assertActiveRemoteBlockOwnership({
        blockType: block.type,
        blockState,
        ownership: authority.identity
      });
      const remoteCanSubmit =
        blockState?.status === "in_progress" ||
        (blockState?.status === "diverged" && blockState.remoteInterruption?.resumable === true);
      if (!remoteCanSubmit) {
        throw new Error(`Block '${options.ref}' must be in_progress before submit-result.`);
      }
      const currentSource = await remoteBlockSourceEvidence(context, options.ref);
      if (
        currentSource.sourceRevision !== authority.identity.sourceRevision ||
        currentSource.graphFingerprint !== authority.identity.graphFingerprint
      ) {
        state.blocks[options.ref] = markRemoteBlockOwnershipSourceDrift({
          blockType: block.type,
          blockState,
          ...currentSource,
          reason: `Remote source changed before completion of '${options.ref}'.`
        });
        state = refreshDerivedState(manifest, state);
        await writeState(workspace.stateFile, state);
        throw new RemoteBlockRuntimeError(
          "remote_block_source_changed",
          `Remote source changed before completion of '${options.ref}'.`
        );
      }
    }
    const persistedRunId = await findPersistedRun(
      workspace,
      taskId,
      blockId,
      options.ref,
      artifact
    );
    if (persistedRunId) {
      const persistedRunRoot = join(workspace.resultsDir, taskId, "blocks", blockId, "runs");
      await upsertBlockRunInIndex(persistedRunRoot, persistedRunId, true);
      await updateTaskIndex(workspace, taskId, (index) => ({
        ...index,
        latestRunByBlock: {
          ...(index.latestRunByBlock ?? {}),
          [options.ref]: persistedRunId
        }
      }));
      state.blocks[options.ref] =
        authority.kind === "remote"
          ? completeRemoteBlockOwnership({
              blockType: block.type,
              blockState: state.blocks[options.ref],
              ownership: authority.identity,
              runId: persistedRunId
            })
          : {
              ...withoutRemoteBlockOwnership(state.blocks[options.ref], "completed"),
              lastRunId: persistedRunId
            };
      state.currentRefs = state.currentRefs.filter((ref) => ref !== options.ref);
      state = refreshDerivedState(manifest, state);
      await writeState(workspace.stateFile, state);
      return { ref: options.ref, runId: persistedRunId, status: "completed" };
    }
    if (authority.kind === "local" && blockState?.status !== "in_progress") {
      throw new Error(`Block '${options.ref}' must be in_progress before submit-result.`);
    }
    const runRoot = join(workspace.resultsDir, taskId, "blocks", blockId, "runs");
    let runId: string;
    if (options.runId) {
      runId = options.runId;
      await mkdir(join(runRoot, runId), { recursive: true });
    } else {
      runId = await allocateRunId(runRoot);
    }
    const runDir = join(runRoot, runId);
    const reportDestination = join(runDir, "report.md");
    const metadataPath = join(runDir, "metadata.json");
    const artifactReference =
      artifact.mode === "verified"
        ? await materializeArtifactBytes(
            {
              rootDir: runDir,
              relativePath: "report.md",
              kind: "implementation",
              content: artifact.bytes
            },
            hooks
          )
        : null;
    if (artifact.mode === "legacy") {
      await writeFile(reportDestination, artifact.bytes);
    }
    const previousMetadata: ImplementationRunMetadata = (await exists(metadataPath))
      ? await readImplementationRunMetadataFile(metadataPath)
      : {};
    await writeJsonFile(metadataPath, {
      ...previousMetadata,
      ref: options.ref,
      taskId,
      blockId,
      runId,
      submittedAt: new Date().toISOString(),
      reportHash,
      ...(artifactReference ? { artifactReference } : {}),
      ...(options.reportPath ? { sourceReportPath: options.reportPath } : {})
    });
    await upsertBlockRunInIndex(runRoot, runId, true);
    await updateTaskIndex(workspace, taskId, (index) => ({
      ...index,
      latestRunByBlock: {
        ...(index.latestRunByBlock ?? {}),
        [options.ref]: runId
      },
      counts: incrementTaskIndexCount(index, "runs")
    }));
    state.blocks[options.ref] =
      authority.kind === "remote"
        ? completeRemoteBlockOwnership({
            blockType: block.type,
            blockState: state.blocks[options.ref],
            ownership: authority.identity,
            runId
          })
        : {
            ...withoutRemoteBlockOwnership(state.blocks[options.ref], "completed"),
            lastRunId: runId
          };
    state.currentRefs = state.currentRefs.filter((ref) => ref !== options.ref);
    state = refreshDerivedState(manifest, state);
    await writeState(workspace.stateFile, state);
    return { ref: options.ref, runId, status: "completed" };
  });
}

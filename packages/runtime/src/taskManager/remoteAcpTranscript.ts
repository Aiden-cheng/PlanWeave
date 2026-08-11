import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { NormalizedFailure } from "@planweave-ai/agent-host-protocol";
import { materializeArtifactBytes } from "../autoRun/artifactReferenceContract.js";
import { AcpEventStore } from "../autoRun/acpEventStore.js";
import { upsertBlockRunInIndex } from "../autoRun/blockRunIndex.js";
import { allocateRunId } from "../autoRun/executorShared.js";
import { remoteAcpEventBody } from "../autoRun/remoteAcpEventProjection.js";
import {
  acpCorrelationSchema,
  runnerIdentitySchema,
  runnerRunIdentitySchema,
  type ArtifactReference
} from "../autoRun/runnerContractSchemas.js";
import { optionalReaddir } from "../fs/optionalFile.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import { writeJsonFile } from "../json.js";
import type { ProjectWorkspace } from "../types.js";
import { readImplementationRunMetadataFile } from "./implementationRunMetadata.js";
import { incrementTaskIndexCount, updateTaskIndex } from "./resultIndex.js";
import type { ActiveRemoteOperationIdentity } from "./remoteOwnershipTransitions.js";
import type { RemoteBlockCompletionInput } from "./remoteBlockRuntimeContracts.js";

type RemoteAcpTranscript = NonNullable<RemoteBlockCompletionInput["transcript"]>;

async function findRunIdByExecutionAttempt(
  runRoot: string,
  executionAttemptId: string
): Promise<string | null> {
  const entries = await optionalReaddir(runRoot, { withFileTypes: true });
  if (!entries) {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^RUN-\d+$/.test(entry.name)) {
      continue;
    }
    try {
      const metadata = await readImplementationRunMetadataFile(
        join(runRoot, entry.name, "metadata.json")
      );
      if (metadata.executionAttemptId === executionAttemptId) {
        return entry.name;
      }
    } catch (error) {
      if (error instanceof Error && /is (invalid|malformed JSON):/.test(error.message)) {
        throw error;
      }
    }
  }
  return null;
}

/**
 * Persist a successful remote review as a Task Workspace ACP run so conversation
 * survives after the live remote row disappears (receipt runId stays REV-*).
 */
export async function ensureRemoteReviewAcpConversationRun(options: {
  workspace: ProjectWorkspace;
  ref: string;
  transcript: RemoteAcpTranscript;
  reportBytes: Uint8Array;
  identity: ActiveRemoteOperationIdentity;
  reviewAttemptId: string;
}): Promise<string> {
  const { taskId, blockId } = parseBlockRef(options.ref);
  const runRoot = join(options.workspace.resultsDir, taskId, "blocks", blockId, "runs");
  const existing = await findRunIdByExecutionAttempt(runRoot, options.identity.executionAttemptId);
  if (existing) {
    return existing;
  }

  const runId = await allocateRunId(runRoot);
  const runDir = join(runRoot, runId);
  await mkdir(runDir, { recursive: true });
  const reportBytes = Buffer.from(options.reportBytes);
  const artifactReference = await materializeArtifactBytes({
    rootDir: runDir,
    relativePath: "review-result.json",
    kind: "review",
    content: reportBytes
  });
  const remoteTiming = await materializeRemoteAcpTranscript({
    workspace: options.workspace,
    ref: options.ref,
    runId,
    runDir,
    transcript: options.transcript,
    artifact: artifactReference
  });
  await writeJsonFile(join(runDir, "metadata.json"), {
    ref: options.ref,
    taskId,
    blockId,
    runId,
    submittedAt: new Date().toISOString(),
    reportHash: createHash("sha256").update(reportBytes).digest("hex"),
    artifactReference,
    reviewAttemptId: options.reviewAttemptId,
    claimRef: options.ref,
    projectId: options.workspace.id,
    canvasId: basename(dirname(options.workspace.packageDir)),
    executor: options.transcript.executor,
    adapter: "agent",
    agentId: options.transcript.agentId,
    runnerKind: "acp",
    executorRunId: runId,
    runSessionId: null,
    desktopRunId: null,
    sessionId: options.transcript.sessionId,
    agentSessionId: options.transcript.sessionId,
    status: "completed",
    startedAt: remoteTiming.startedAt,
    finishedAt: remoteTiming.finishedAt,
    exitCode: 0,
    operationId: options.identity.operationId,
    dispatchId: options.identity.dispatchId,
    executionAttemptId: options.identity.executionAttemptId
  });
  await upsertBlockRunInIndex(runRoot, runId, true);
  await updateTaskIndex(options.workspace, taskId, (index) => ({
    ...index,
    latestRunByBlock: {
      ...(index.latestRunByBlock ?? {}),
      [options.ref]: runId
    },
    counts: incrementTaskIndexCount(index, "runs")
  }));
  return runId;
}

export async function materializeRemoteAcpTranscript(options: {
  workspace: ProjectWorkspace;
  ref: string;
  runId: string;
  runDir: string;
  transcript: RemoteAcpTranscript;
  artifact: ArtifactReference;
}): Promise<{ startedAt: string; finishedAt: string }> {
  const { taskId, blockId } = parseBlockRef(options.ref);
  const firstTimestamp = options.transcript.events[0]?.timestamp ?? new Date().toISOString();
  const finishedAt = new Date().toISOString();
  const correlation = acpCorrelationSchema.parse({ sessionId: options.transcript.sessionId });
  const store = new AcpEventStore({
    runDir: options.runDir,
    identity: runnerRunIdentitySchema.parse({
      projectId: options.workspace.id,
      canvasId: basename(dirname(options.workspace.packageDir)),
      taskId,
      blockId,
      claimRef: options.ref,
      runId: options.runId,
      runOwner: "executor",
      runSessionId: null,
      desktopRunId: null,
      executorRunId: options.runId
    }),
    runner: runnerIdentitySchema.parse({
      version: "planweave.runner/v1",
      runnerKind: "acp",
      agentId: options.transcript.agentId
    })
  });
  await store.open();
  await store.appendObserved(
    { kind: "lifecycle", state: "running", message: "Remote ACP run observed." },
    correlation,
    firstTimestamp
  );
  const seenToolCalls = new Set<string>();
  for (const item of options.transcript.events) {
    await store.appendObserved(
      remoteAcpEventBody(item.event, seenToolCalls),
      correlation,
      item.timestamp
    );
  }
  await store.appendObserved(
    { kind: "artifact", artifact: options.artifact },
    correlation,
    finishedAt
  );
  await store.appendObserved(
    {
      kind: "terminal",
      outcome: {
        version: "planweave.runner/v1",
        state: "succeeded",
        reason: "completed",
        cleanup: { status: "succeeded" },
        exitCode: 0,
        finishedAt,
        diagnostic: null,
        artifactValidated: true,
        nextActions: { version: "planweave.runner-next-actions/v1", actions: [] }
      }
    },
    correlation,
    finishedAt
  );
  await store.drain();
  return { startedAt: firstTimestamp, finishedAt };
}

/**
 * Persist a failed remote attempt as a normal Task Workspace run so the left timeline and
 * conversation no longer stick to an older local Auto Run record after remote failure.
 */
export async function materializeRemoteAcpFailure(options: {
  workspace: ProjectWorkspace;
  ref: string;
  runId: string;
  runDir: string;
  failure: NormalizedFailure;
  identity: ActiveRemoteOperationIdentity;
  agentId?: string;
}): Promise<{ startedAt: string; finishedAt: string }> {
  const { taskId, blockId } = parseBlockRef(options.ref);
  const finishedAt = new Date().toISOString();
  const startedAt = finishedAt;
  const correlation = acpCorrelationSchema.parse({
    sessionId: `remote-failed:${options.identity.executionAttemptId}`
  });
  // Prefer the Server-provided endpoint agent; only fall back when callers omit it (legacy tests).
  const agentId = options.agentId ?? "codex";
  const store = new AcpEventStore({
    runDir: options.runDir,
    identity: runnerRunIdentitySchema.parse({
      projectId: options.workspace.id,
      canvasId: basename(dirname(options.workspace.packageDir)),
      taskId,
      blockId,
      claimRef: options.ref,
      runId: options.runId,
      runOwner: "executor",
      runSessionId: null,
      desktopRunId: null,
      executorRunId: options.runId
    }),
    runner: runnerIdentitySchema.parse({
      version: "planweave.runner/v1",
      runnerKind: "acp",
      agentId
    })
  });
  await store.open();
  await store.appendObserved(
    { kind: "lifecycle", state: "running", message: "Remote ACP run observed." },
    correlation,
    startedAt
  );
  await store.appendObserved(
    remoteAcpEventBody(
      {
        cursor: 1,
        kind: "diagnostic",
        severity: "error",
        message: `[${options.failure.code}] ${options.failure.message}`
      },
      new Set()
    ),
    correlation,
    finishedAt
  );
  await store.appendObserved(
    {
      kind: "terminal",
      outcome: {
        version: "planweave.runner/v1",
        state: "failed",
        reason: "failed",
        cleanup: { status: "succeeded" },
        exitCode: 1,
        finishedAt,
        diagnostic: `[${options.failure.code}] ${options.failure.message}`,
        artifactValidated: false,
        nextActions: { version: "planweave.runner-next-actions/v1", actions: [] }
      }
    },
    correlation,
    finishedAt
  );
  await store.drain();
  await writeJsonFile(`${options.runDir}/metadata.json`, {
    ref: options.ref,
    taskId,
    blockId,
    runId: options.runId,
    submittedAt: finishedAt,
    claimRef: options.ref,
    projectId: options.workspace.id,
    canvasId: basename(dirname(options.workspace.packageDir)),
    executor: agentId,
    adapter: "agent",
    agentId,
    runnerKind: "acp",
    executorRunId: options.runId,
    runSessionId: null,
    desktopRunId: null,
    sessionId: correlation.sessionId,
    agentSessionId: correlation.sessionId,
    status: "failed",
    startedAt,
    finishedAt,
    exitCode: 1,
    failureCode: options.failure.code,
    failureMessage: options.failure.message,
    operationId: options.identity.operationId,
    dispatchId: options.identity.dispatchId,
    executionAttemptId: options.identity.executionAttemptId
  });
  return { startedAt, finishedAt };
}

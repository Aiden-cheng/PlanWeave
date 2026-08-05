import { basename, dirname } from "node:path";
import { AcpEventStore } from "../autoRun/acpEventStore.js";
import { remoteAcpEventBody } from "../autoRun/remoteAcpEventProjection.js";
import {
  acpCorrelationSchema,
  runnerIdentitySchema,
  runnerRunIdentitySchema,
  type ArtifactReference
} from "../autoRun/runnerContractSchemas.js";
import { parseBlockRef } from "../graph/compileTaskGraph.js";
import type { ProjectWorkspace } from "../types.js";
import type { RemoteBlockCompletionInput } from "./remoteBlockRuntimeContracts.js";

type RemoteAcpTranscript = NonNullable<RemoteBlockCompletionInput["transcript"]>;

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

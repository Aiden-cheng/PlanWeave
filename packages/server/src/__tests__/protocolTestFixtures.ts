import {
  exampleExecutionEnvelopeInput,
  executionEnvelopeSchema,
  type ExecutionEnvelope
} from "@planweave-ai/distributed-protocol";

export function executionEnvelopeFor(
  blockRef: string,
  requiredCapabilities: readonly string[],
  projectId = "project-a"
): ExecutionEnvelope {
  const taskId = blockRef.slice(0, blockRef.indexOf("#"));
  const identitySuffix = blockRef.replaceAll(/[^A-Za-z0-9]/g, "-").toLowerCase();
  return executionEnvelopeSchema.parse({
    ...exampleExecutionEnvelopeInput,
    execution: {
      dispatchId: `dispatch-${identitySuffix}`,
      attemptId: `attempt-${identitySuffix}`
    },
    projectId,
    taskId,
    blockRef,
    inputArtifacts: [],
    requiredCapabilities
  });
}

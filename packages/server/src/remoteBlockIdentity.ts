import { remoteBlockRefIdentitySchema } from "@planweave-ai/runtime";
import type { RemoteOperation } from "./remoteOperations.js";

export function remoteBlockIdentity(operation: RemoteOperation) {
  return remoteBlockRefIdentitySchema.parse({
    ref: operation.blockRef,
    operationId: operation.id,
    controlPlane: operation.endpointSelection?.authority.controlPlane ?? "collaboration",
    sourceRevision: operation.ownershipGeneration,
    graphFingerprint: operation.sourceFingerprint,
    dispatchId: operation.dispatchId,
    executionAttemptId: operation.executionAttemptId
  });
}

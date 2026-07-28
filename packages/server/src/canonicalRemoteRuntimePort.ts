import type {
  RemoteBlockClaimInput,
  RemoteBlockCompletionInput,
  RemoteBlockFailureInput,
  RemoteBlockInterruptionInput,
  RemoteBlockOperationQuery,
  RemoteBlockRefIdentity,
  RemoteBlockRetryAttemptInput,
  RemoteBlockRuntimePort
} from "@planweave-ai/runtime";

/**
 * The Server owns collaboration workspace identity. Runtime's local workspace
 * identifier remains the legacy project identity, so only dispatch candidates
 * crossing this boundary are rewritten to the canonical Server workspace.
 */
export function canonicalRemoteRuntimePort(
  runtime: RemoteBlockRuntimePort,
  workspaceId: string
): RemoteBlockRuntimePort {
  return {
    async inspect(input) {
      const candidate = await runtime.inspect(input);
      return { ...candidate, workspaceId };
    },
    claim(input: RemoteBlockClaimInput) {
      return runtime.claim(input);
    },
    activate(input: RemoteBlockRefIdentity) {
      return runtime.activate(input);
    },
    query(input: RemoteBlockOperationQuery) {
      return runtime.query(input);
    },
    reconcile(input: RemoteBlockOperationQuery) {
      return runtime.reconcile(input);
    },
    markInterrupted(input: RemoteBlockInterruptionInput) {
      return runtime.markInterrupted(input);
    },
    resumeAttempt(input: RemoteBlockRefIdentity) {
      return runtime.resumeAttempt(input);
    },
    retryAttempt(input: RemoteBlockRetryAttemptInput) {
      return runtime.retryAttempt(input);
    },
    complete(input: RemoteBlockCompletionInput) {
      return runtime.complete(input);
    },
    fail(input: RemoteBlockFailureInput) {
      return runtime.fail(input);
    }
  };
}

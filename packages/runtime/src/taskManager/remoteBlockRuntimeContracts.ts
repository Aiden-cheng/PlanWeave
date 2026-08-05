import {
  artifactRefSchema,
  blockRefSchema,
  dispatchIdSchema,
  executionAttemptIdSchema,
  executionEnvelopeSchema,
  normalizedFailureSchema,
  normalizedAcpEventSchema,
  opaqueIdentifierSchema,
  OUTPUT_MAX_ARTIFACT_BYTES
} from "@planweave-ai/agent-host-protocol";
import { z } from "zod";
import {
  activeRemoteBlockOwnershipSchema,
  remoteBlockOwnershipSchema,
  remoteInterruptionSchema,
  remoteOperationReceiptSchema
} from "../schema/remoteOwnership.js";
import { blockStatuses } from "../types/state.js";

const envelopeShape = executionEnvelopeSchema.shape;

const publicRemoteFailureCodes = [
  "acp_incomplete_response",
  "acp_operation_timeout",
  "acp_process_error",
  "acp_protocol_error",
  "acp_capability_missing",
  "authentication_failed",
  "execution_cancelled",
  "executor_failed",
  "lease_expired",
  "persistence_failed",
  "protocol_error",
  "remote_execution_failed",
  "transport_failed"
] as const;

const publicRemoteFailureCodeSchema = z.enum(publicRemoteFailureCodes);
type PublicRemoteFailureCode = z.infer<typeof publicRemoteFailureCodeSchema>;

const publicFailureMessagesByCode: Readonly<Record<PublicRemoteFailureCode, string>> = {
  acp_incomplete_response: "Remote ACP execution ended without a complete response.",
  acp_operation_timeout: "Remote ACP execution timed out.",
  acp_process_error: "Remote ACP process failed.",
  acp_protocol_error: "Remote ACP protocol failed.",
  acp_capability_missing: "Remote ACP capability is missing.",
  authentication_failed: "Remote authentication failed.",
  execution_cancelled: "Remote execution was cancelled.",
  executor_failed: "Remote executor failed.",
  lease_expired: "Remote execution lease expired.",
  persistence_failed: "Remote persistence failed.",
  protocol_error: "Remote protocol failed.",
  remote_execution_failed: "Remote execution failed.",
  transport_failed: "Remote transport failed."
};

/** Runtime-safe terminal failure: identity is preserved while Host diagnostics are discarded. */
export const publicRemoteFailureSchema = normalizedFailureSchema.transform((failure) => {
  const parsedCode = publicRemoteFailureCodeSchema.safeParse(failure.code);
  const code: PublicRemoteFailureCode = parsedCode.success
    ? parsedCode.data
    : "remote_execution_failed";
  return {
    code,
    message: publicFailureMessagesByCode[code],
    retryable: failure.retryable
  };
});

/** Runtime-owned, portable fields used by Server to assemble one Execution Envelope. */
export const remoteBlockDispatchCandidateSchema = z
  .object({
    projectId: envelopeShape.projectId,
    canvasId: envelopeShape.canvasId,
    taskId: envelopeShape.taskId,
    blockRef: envelopeShape.blockRef,
    blockType: envelopeShape.blockType,
    sourceRevision: envelopeShape.sourceRevision,
    graphFingerprint: envelopeShape.graphFingerprint.unwrap(),
    renderedPrompt: envelopeShape.renderedPrompt,
    acceptance: envelopeShape.acceptance,
    dependencySummaries: envelopeShape.dependencySummaries,
    inputArtifacts: envelopeShape.inputArtifacts,
    workspaceId: envelopeShape.workspaceId,
    effectiveExecutor: opaqueIdentifierSchema,
    agentId: envelopeShape.agentId,
    agentProfileId: envelopeShape.agentProfileId,
    session: envelopeShape.session,
    requiredCapabilities: envelopeShape.requiredCapabilities
  })
  .strict();

export const remoteBlockClaimInputSchema = z
  .object({
    ref: blockRefSchema,
    operationId: opaqueIdentifierSchema,
    sourceRevision: envelopeShape.sourceRevision,
    graphFingerprint: envelopeShape.graphFingerprint.unwrap()
  })
  .strict();

export const remoteBlockInspectInputSchema = z.object({ ref: blockRefSchema }).strict();

export const remoteBlockOperationQuerySchema = z
  .object({ ref: blockRefSchema, operationId: opaqueIdentifierSchema })
  .strict();

export const remoteBlockActiveIdentitySchema = activeRemoteBlockOwnershipSchema.omit({
  phase: true
});

export const remoteBlockRefIdentitySchema = remoteBlockActiveIdentitySchema.extend({
  ref: blockRefSchema
});

export const remoteBlockCompletionInputSchema = remoteBlockRefIdentitySchema.extend({
  reportArtifactRef: artifactRefSchema,
  reportBytes: z
    .instanceof(Uint8Array)
    .refine((bytes) => bytes.byteLength > 0, "report bytes must not be empty")
    .refine(
      (bytes) => bytes.byteLength <= OUTPUT_MAX_ARTIFACT_BYTES,
      `report bytes must not exceed ${OUTPUT_MAX_ARTIFACT_BYTES} bytes`
    ),
  transcript: z
    .object({
      sessionId: z.string().min(1).max(256),
      executor: opaqueIdentifierSchema,
      agentId: envelopeShape.agentId,
      events: z
        .array(
          z
            .object({
              timestamp: z.string().datetime(),
              event: normalizedAcpEventSchema
            })
            .strict()
        )
        .max(100_000)
    })
    .strict()
    .optional()
});

export const remoteBlockFailureInputSchema = remoteBlockRefIdentitySchema.extend({
  failure: publicRemoteFailureSchema
});

export const remoteBlockInterruptionInputSchema = remoteBlockRefIdentitySchema.extend({
  interruption: remoteInterruptionSchema
});

export const remoteBlockRetryAttemptInputSchema = remoteBlockRefIdentitySchema
  .extend({
    newDispatchId: dispatchIdSchema,
    newExecutionAttemptId: executionAttemptIdSchema
  })
  .refine((input) => input.executionAttemptId !== input.newExecutionAttemptId, {
    message: "A remote retry requires a new execution attempt identity.",
    path: ["newExecutionAttemptId"]
  });

export const remoteBlockBindingViewSchema = z
  .object({
    ref: blockRefSchema,
    status: z.enum(blockStatuses),
    ownership: remoteBlockOwnershipSchema.optional(),
    interruption: remoteInterruptionSchema.optional(),
    terminalReceipt: remoteOperationReceiptSchema.optional(),
    blockedReason: z.string().nullable().optional(),
    divergenceReason: z.string().nullable().optional()
  })
  .strict();

export const remoteBlockRetryDecisionSchema = z.enum([
  "resume_exact_attempt",
  "manual_retry_required",
  "not_retryable"
]);

export const remoteBlockMutationResultSchema = z
  .object({
    binding: remoteBlockBindingViewSchema,
    retryDecision: remoteBlockRetryDecisionSchema
  })
  .strict();

export const remoteBlockCompletionResultSchema = z
  .object({
    ref: blockRefSchema,
    runId: opaqueIdentifierSchema,
    status: z.literal("completed")
  })
  .strict();

export type RemoteBlockDispatchCandidate = z.infer<typeof remoteBlockDispatchCandidateSchema>;
export type RemoteBlockClaimInput = z.infer<typeof remoteBlockClaimInputSchema>;
export type RemoteBlockInspectInput = z.infer<typeof remoteBlockInspectInputSchema>;
export type RemoteBlockOperationQuery = z.infer<typeof remoteBlockOperationQuerySchema>;
export type RemoteBlockActiveIdentity = z.infer<typeof remoteBlockActiveIdentitySchema>;
export type RemoteBlockRefIdentity = z.infer<typeof remoteBlockRefIdentitySchema>;
export type RemoteBlockCompletionInput = z.infer<typeof remoteBlockCompletionInputSchema>;
export type RemoteBlockFailureInput = z.infer<typeof remoteBlockFailureInputSchema>;
export type RemoteBlockInterruptionInput = z.infer<typeof remoteBlockInterruptionInputSchema>;
export type RemoteBlockRetryAttemptInput = z.infer<typeof remoteBlockRetryAttemptInputSchema>;
export type RemoteBlockBindingView = z.infer<typeof remoteBlockBindingViewSchema>;
export type RemoteBlockRetryDecision = z.infer<typeof remoteBlockRetryDecisionSchema>;
export type RemoteBlockMutationResult = z.infer<typeof remoteBlockMutationResultSchema>;
export type RemoteBlockCompletionResult = z.infer<typeof remoteBlockCompletionResultSchema>;

export type RemoteBlockRuntimeErrorCode =
  | "remote_block_not_found"
  | "remote_block_not_implementation"
  | "remote_block_not_dispatchable"
  | "remote_block_executor_not_acp"
  | "remote_block_source_changed"
  | "remote_block_result_conflict";

export class RemoteBlockRuntimeError extends Error {
  readonly code: RemoteBlockRuntimeErrorCode;

  constructor(code: RemoteBlockRuntimeErrorCode, message: string) {
    super(message);
    this.name = "RemoteBlockRuntimeError";
    this.code = code;
  }
}

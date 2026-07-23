import {
  dispatchIdSchema,
  executionAttemptIdSchema,
  interruptionReasonSchema,
  normalizedFailureSchema,
  opaqueIdentifierSchema
} from "@planweave-ai/distributed-protocol";
import { z } from "zod";

const remoteOwnershipSourceShape = {
  operationId: opaqueIdentifierSchema,
  sourceRevision: opaqueIdentifierSchema,
  graphFingerprint: opaqueIdentifierSchema
};

/** Durable ownership recorded before a Coordinator dispatch exists. */
export const preparingRemoteBlockOwnershipSchema = z
  .object({
    phase: z.literal("preparing"),
    ...remoteOwnershipSourceShape
  })
  .strict();

/** Exact dispatch and execution-attempt binding activated for the same operation. */
export const activeRemoteBlockOwnershipSchema = z
  .object({
    phase: z.literal("active"),
    ...remoteOwnershipSourceShape,
    dispatchId: dispatchIdSchema,
    executionAttemptId: executionAttemptIdSchema
  })
  .strict();

export const remoteBlockOwnershipSchema = z.discriminatedUnion("phase", [
  preparingRemoteBlockOwnershipSchema,
  activeRemoteBlockOwnershipSchema
]);

const activeRemoteOperationIdentityShape = {
  operationId: opaqueIdentifierSchema,
  sourceRevision: opaqueIdentifierSchema,
  graphFingerprint: opaqueIdentifierSchema,
  dispatchId: dispatchIdSchema,
  executionAttemptId: executionAttemptIdSchema
};

export const remoteOperationReceiptSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("completed"),
      ...activeRemoteOperationIdentityShape,
      runId: opaqueIdentifierSchema
    })
    .strict(),
  z
    .object({
      outcome: z.literal("failed"),
      ...activeRemoteOperationIdentityShape,
      failure: normalizedFailureSchema
    })
    .strict()
]);

export const remoteInterruptionSchema = z
  .object({
    reason: interruptionReasonSchema,
    resumable: z.boolean()
  })
  .strict();

export type PreparingRemoteBlockOwnership = z.infer<typeof preparingRemoteBlockOwnershipSchema>;
export type PreparingRemoteBlockOwnershipInput = z.input<
  typeof preparingRemoteBlockOwnershipSchema
>;
export type ActiveRemoteBlockOwnership = z.infer<typeof activeRemoteBlockOwnershipSchema>;
export type ActiveRemoteBlockOwnershipInput = z.input<typeof activeRemoteBlockOwnershipSchema>;
export type RemoteBlockOwnership = z.infer<typeof remoteBlockOwnershipSchema>;
export type RemoteOperationReceipt = z.infer<typeof remoteOperationReceiptSchema>;
export type RemoteInterruption = z.infer<typeof remoteInterruptionSchema>;

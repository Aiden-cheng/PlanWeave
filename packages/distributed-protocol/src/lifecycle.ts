import { z } from "zod";
import { artifactRefSchema } from "./artifacts.js";
import { dispatchIdSchema, executionAttemptIdSchema } from "./executionIdentity.js";
import { normalizedFailureSchema } from "./failure.js";
import { leaseIdSchema } from "./leaseIdentity.js";

export const PROGRESS_MESSAGE_MAX_LENGTH = 4_096 as const;
export const RESULT_SUMMARY_MAX_LENGTH = 16_384 as const;
export const RESULT_ARTIFACT_MAX_COUNT = 256 as const;

export const dispatchLifecycleIdentitySchema = z
  .object({
    dispatchId: dispatchIdSchema,
    leaseId: leaseIdSchema,
    executionAttemptId: executionAttemptIdSchema
  })
  .strict();

export const acpRecoveryIdentitySchema = z
  .object({
    acpSessionId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    recoveryId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  })
  .strict();

export const dispatchResultSchema = z
  .object({
    summary: z.string().max(RESULT_SUMMARY_MAX_LENGTH),
    reportArtifactRef: artifactRefSchema,
    artifactRefs: z.array(artifactRefSchema).max(RESULT_ARTIFACT_MAX_COUNT)
  })
  .strict();

export const interruptionReasonSchema = z.enum([
  "host_restart",
  "transport_lost",
  "acp_session_lost",
  "lease_lost"
]);

export const executionInterruptedSchema = dispatchLifecycleIdentitySchema
  .extend({
    type: z.literal("dispatch.interrupted"),
    reason: interruptionReasonSchema,
    resumable: z.boolean(),
    recovery: acpRecoveryIdentitySchema.optional()
  })
  .superRefine((event, context) => {
    if (event.resumable !== (event.recovery !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "A resumable interruption requires an ACP recovery identity.",
        path: ["recovery"]
      });
    }
  });

export const executionCompletedSchema = dispatchLifecycleIdentitySchema.extend({
  type: z.literal("dispatch.completed"),
  result: dispatchResultSchema
});

export const executionFailedSchema = dispatchLifecycleIdentitySchema.extend({
  type: z.literal("dispatch.failed"),
  failure: normalizedFailureSchema
});

export const executionOutcomeSchema = z.discriminatedUnion("type", [
  executionInterruptedSchema,
  executionCompletedSchema,
  executionFailedSchema
]);

export type DispatchLifecycleIdentity = z.infer<typeof dispatchLifecycleIdentitySchema>;
export type AcpRecoveryIdentity = z.infer<typeof acpRecoveryIdentitySchema>;
export type DispatchResult = z.infer<typeof dispatchResultSchema>;
export type InterruptionReason = z.infer<typeof interruptionReasonSchema>;
export type ExecutionOutcome = z.infer<typeof executionOutcomeSchema>;

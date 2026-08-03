import { z } from "zod";
import { opaqueIdentifierSchema } from "./identifiers.js";

/** Stable identity of one Coordinator dispatch of a Block. */
export const dispatchIdSchema = opaqueIdentifierSchema.brand("DispatchId");

export type DispatchId = z.infer<typeof dispatchIdSchema>;

/** Stable identity of one execution attempt under a dispatch. */
export const executionAttemptIdSchema = opaqueIdentifierSchema.brand("ExecutionAttemptId");

export type ExecutionAttemptId = z.infer<typeof executionAttemptIdSchema>;

/**
 * Dispatch-scoped execution identity.
 * Attempt identity is required so retries never reuse the prior attempt key.
 */
export const executionIdentitySchema = z
  .object({
    dispatchId: dispatchIdSchema,
    attemptId: executionAttemptIdSchema
  })
  .strict();

export type ExecutionIdentity = z.infer<typeof executionIdentitySchema>;

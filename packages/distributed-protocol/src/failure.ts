import { z } from "zod";
import { opaqueIdentifierSchema } from "./identifiers.js";

/** Maximum UTF-16 code units allowed in a normalized failure message. */
export const NORMALIZED_FAILURE_MESSAGE_MAX_LENGTH = 16384 as const;

/**
 * Portable terminal failure for a dispatch attempt.
 * Free of local paths, credentials, and Host-private process details.
 */
export const normalizedFailureSchema = z
  .object({
    code: opaqueIdentifierSchema,
    message: z.string().min(1).max(NORMALIZED_FAILURE_MESSAGE_MAX_LENGTH),
    retryable: z.boolean()
  })
  .strict();

export type NormalizedFailure = z.infer<typeof normalizedFailureSchema>;

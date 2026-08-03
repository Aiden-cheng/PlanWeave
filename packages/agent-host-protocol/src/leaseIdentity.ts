import { z } from "zod";
import { dispatchIdSchema } from "./executionIdentity.js";
import { opaqueIdentifierSchema } from "./identifiers.js";

/** Stable identity of one Host lease covering a dispatch attempt. */
export const leaseIdSchema = opaqueIdentifierSchema.brand("LeaseId");

export type LeaseId = z.infer<typeof leaseIdSchema>;

/**
 * Lease identity scoped to a dispatch.
 * A valid Host token alone is never sufficient for write access.
 */
export const leaseIdentitySchema = z
  .object({
    dispatchId: dispatchIdSchema,
    leaseId: leaseIdSchema
  })
  .strict();

export type LeaseIdentity = z.infer<typeof leaseIdentitySchema>;

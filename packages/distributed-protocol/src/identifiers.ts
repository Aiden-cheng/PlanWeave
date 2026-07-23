import { z } from "zod";

/** Maximum UTF-16 code units allowed in an opaque wire identifier. */
export const OPAQUE_IDENTIFIER_MAX_LENGTH = 128 as const;

/**
 * Opaque Coordinator/Host wire identifier.
 * Not a filesystem path, executable, token, or free-form label.
 */
export const opaqueIdentifierSchema = z
  .string()
  .min(1)
  .max(OPAQUE_IDENTIFIER_MAX_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export type OpaqueIdentifier = z.infer<typeof opaqueIdentifierSchema>;

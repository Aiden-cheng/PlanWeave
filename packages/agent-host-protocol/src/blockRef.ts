import { z } from "zod";
import { opaqueIdentifierSchema } from "./identifiers.js";
import { BLOCK_REF_MAX_LENGTH } from "./limits.js";

/**
 * Portable Block reference: taskId#blockId.
 * Never a filesystem path; both sides use the shared portable identifier grammar.
 */
export const blockRefSchema = z
  .string()
  .min(3)
  .max(BLOCK_REF_MAX_LENGTH)
  .refine((value) => {
    const parts = value.split("#");
    return (
      parts.length === 2 &&
      opaqueIdentifierSchema.safeParse(parts[0]).success &&
      opaqueIdentifierSchema.safeParse(parts[1]).success
    );
  }, "Block ref must be taskId#blockId using portable identifiers.");

export type BlockRef = z.infer<typeof blockRefSchema>;

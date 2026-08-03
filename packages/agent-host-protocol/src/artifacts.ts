import { z } from "zod";

/**
 * Content-addressed artifact reference.
 * SHA-256 digest only; never a Coordinator absolute path or local file URL.
 */
export const artifactRefSchema = z.string().regex(/^artifact:sha256:[a-f0-9]{64}$/);

export type ArtifactRef = z.infer<typeof artifactRefSchema>;

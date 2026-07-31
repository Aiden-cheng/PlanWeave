import { z } from "zod";
import {
  collaborationServerOriginSchema,
  refineCollaborationTransportPolicy
} from "./connection.js";
import { setupCodeTokenSchema } from "./primitives.js";

export const collaborationSetupHandoffV1Prefix = "planweave-server-setup/v1:" as const;

/** Portable, one-time Server setup details copied directly between trusted devices. */
export const collaborationSetupHandoffV1Schema = z
  .object({
    serverBaseUrl: collaborationServerOriginSchema,
    setupCode: setupCodeTokenSchema,
    allowInsecureTransport: z.boolean()
  })
  .strict()
  .superRefine(refineCollaborationTransportPolicy);
export type CollaborationSetupHandoffV1 = z.infer<typeof collaborationSetupHandoffV1Schema>;

export function serializeCollaborationSetupHandoffV1(input: CollaborationSetupHandoffV1): string {
  const handoff = collaborationSetupHandoffV1Schema.parse(input);
  return `${collaborationSetupHandoffV1Prefix}${JSON.stringify({
    serverBaseUrl: handoff.serverBaseUrl,
    setupCode: handoff.setupCode,
    allowInsecureTransport: handoff.allowInsecureTransport
  })}`;
}

export function parseCollaborationSetupHandoffV1(
  value: string
): CollaborationSetupHandoffV1 | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(collaborationSetupHandoffV1Prefix)) return null;

  try {
    const candidate: unknown = JSON.parse(trimmed.slice(collaborationSetupHandoffV1Prefix.length));
    const parsed = collaborationSetupHandoffV1Schema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

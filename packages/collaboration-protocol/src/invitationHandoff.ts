import { z } from "zod";
import {
  collaborationServerOriginSchema,
  refineCollaborationTransportPolicy
} from "./connection.js";
import { humanProjectIdSchema, projectInvitationTokenSchema } from "./primitives.js";

export const collaborationInvitationHandoffV1Prefix =
  "planweave-collaboration-invitation/v1:" as const;

/**
 * Portable, one-time project invitation details. This contains a bearer secret
 * and must only be copied directly to the recipient, never persisted.
 */
export const collaborationInvitationHandoffV1Schema = z
  .object({
    serverBaseUrl: collaborationServerOriginSchema,
    projectId: humanProjectIdSchema,
    invitationToken: projectInvitationTokenSchema,
    allowInsecureTransport: z.boolean()
  })
  .strict()
  .superRefine(refineCollaborationTransportPolicy);
export type CollaborationInvitationHandoffV1 = z.infer<
  typeof collaborationInvitationHandoffV1Schema
>;

export function parseCollaborationInvitationHandoffPayload(
  value: unknown
): CollaborationInvitationHandoffV1 | null {
  const parsed = collaborationInvitationHandoffV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Produces a stable, locale-independent invitation envelope for the clipboard. */
export function serializeCollaborationInvitationHandoffV1(
  input: CollaborationInvitationHandoffV1
): string {
  const handoff = collaborationInvitationHandoffV1Schema.parse(input);
  return `${collaborationInvitationHandoffV1Prefix}${JSON.stringify({
    serverBaseUrl: handoff.serverBaseUrl,
    projectId: handoff.projectId,
    invitationToken: handoff.invitationToken,
    allowInsecureTransport: handoff.allowInsecureTransport
  })}`;
}

/** Parses only the versioned clipboard envelope; legacy text belongs to Desktop. */
export function parseCollaborationInvitationHandoffV1(
  value: string
): CollaborationInvitationHandoffV1 | null {
  if (!value.startsWith(collaborationInvitationHandoffV1Prefix)) return null;

  try {
    const candidate: unknown = JSON.parse(
      value.slice(collaborationInvitationHandoffV1Prefix.length)
    );
    return parseCollaborationInvitationHandoffPayload(candidate);
  } catch {
    return null;
  }
}

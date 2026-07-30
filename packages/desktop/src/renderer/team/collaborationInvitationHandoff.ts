import {
  collaborationInvitationHandoffV1Prefix,
  parseCollaborationInvitationHandoffPayload,
  parseCollaborationInvitationHandoffV1,
  serializeCollaborationInvitationHandoffV1,
  type CollaborationInvitationHandoffV1
} from "@planweave-ai/collaboration-contracts";

export { collaborationInvitationHandoffV1Prefix };
export type CollaborationInvitationHandoff = CollaborationInvitationHandoffV1;
export const serializeCollaborationInvitationHandoff = serializeCollaborationInvitationHandoffV1;

const invitationTokenPattern = /\bpw_inv_[A-Za-z0-9_-]{43}\b/;

function legacyProjectId(value: string): string | undefined {
  const match = value.match(/(?:^|\n)\s*(?:Project ID|projectId|项目 ID)\s*[:=]\s*([^\n\r]+)/i);
  return match?.[1]?.trim();
}

/**
 * Parses the V1 envelope first. The legacy branch intentionally extracts only
 * the URL and invitation token that are unambiguous in older copied text. A
 * project ID is still required, because a join cannot continue without it.
 */
export function parseCollaborationInvitationHandoff(
  value: string
): CollaborationInvitationHandoff | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith(collaborationInvitationHandoffV1Prefix)) {
    return parseCollaborationInvitationHandoffV1(trimmed);
  }

  const token = trimmed.match(invitationTokenPattern)?.[0];
  const urlText = trimmed.match(/https?:\/\/[^\s]+/i)?.[0]?.replace(/[),.;]+$/, "");
  if (!token || !urlText) return null;

  const allowInsecureTransport = /^http:\/\//i.test(urlText);
  const projectId = legacyProjectId(trimmed);
  return parseCollaborationInvitationHandoffPayload({
    serverBaseUrl: urlText,
    projectId,
    invitationToken: token,
    allowInsecureTransport
  });
}

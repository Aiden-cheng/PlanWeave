import {
  HUMAN_DEVICE_TOKEN_PREFIX,
  PROJECT_INVITATION_TOKEN_PREFIX
} from "@planweave-ai/collaboration-contracts";

const TOKEN_LIKE =
  /(pw_hdev_[A-Za-z0-9_-]+|pw_inv_[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._~+/-]+=*)/gi;

/**
 * Redact human device / invitation tokens and Authorization headers from log text.
 * Never throw; returns a safe string for diagnostics only.
 */
export function redactCollaborationText(value: string): string {
  return value
    .replace(TOKEN_LIKE, (match) => {
      if (match.toLowerCase().startsWith("bearer ")) return "Bearer [REDACTED]";
      if (match.startsWith(HUMAN_DEVICE_TOKEN_PREFIX)) return `${HUMAN_DEVICE_TOKEN_PREFIX}[REDACTED]`;
      if (match.startsWith(PROJECT_INVITATION_TOKEN_PREFIX)) {
        return `${PROJECT_INVITATION_TOKEN_PREFIX}[REDACTED]`;
      }
      return "[REDACTED]";
    })
    .replace(/"deviceToken"\s*:\s*"[^"]*"/g, '"deviceToken":"[REDACTED]"')
    .replace(/"invitationToken"\s*:\s*"[^"]*"/g, '"invitationToken":"[REDACTED]"')
    .replace(/"existingDeviceToken"\s*:\s*"[^"]*"/g, '"existingDeviceToken":"[REDACTED]"');
}

export function redactCollaborationValue(value: unknown): unknown {
  if (typeof value === "string") return redactCollaborationText(value);
  try {
    return JSON.parse(redactCollaborationText(JSON.stringify(value)));
  } catch {
    return "[unserializable]";
  }
}

import {
  humanAuthContextSchema,
  humanDeviceTokenSchema,
  type HumanAuthContext
} from "./schemas.js";
import type { HumanIdentityRepository } from "./repository.js";

/**
 * Human-specific authentication adapter.
 *
 * Parses only `pw_hdev_` device bearer credentials. Host (`pw_host_`), enrollment,
 * operator, and invitation tokens must not authenticate as humans here.
 * Invalid / expired / revoked / unknown tokens all resolve to unauthenticated without
 * revealing which failure mode applied for unknown external tokens.
 */

function bearerToken(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value) || value === undefined) return undefined;
  const match = /^Bearer (.+)$/.exec(value);
  if (!match) return undefined;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

/**
 * Extract a human device bearer from the Authorization header.
 * Returns undefined when missing, malformed, or not a human device token shape.
 */
export function parseHumanDeviceBearer(
  authorization: string | string[] | undefined
): string | undefined {
  const token = bearerToken(authorization);
  if (!token) return undefined;
  const parsed = humanDeviceTokenSchema.safeParse(token);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Authenticate a human device credential and resolve active project membership.
 * Returns undefined for any authentication or membership failure (uniform unauthenticated).
 */
export function authenticateHumanForProject(
  repository: HumanIdentityRepository,
  authorization: string | string[] | undefined,
  projectId: string
): HumanAuthContext | undefined {
  const token = parseHumanDeviceBearer(authorization);
  if (!token) return undefined;

  const authenticated = repository.authenticateDevice(token, projectId);
  if (!authenticated?.membership) return undefined;

  return humanAuthContextSchema.parse({
    humanPrincipalId: authenticated.principal.humanPrincipalId,
    displayName: authenticated.principal.displayName,
    deviceCredentialId: authenticated.device.deviceCredentialId,
    projectId: authenticated.membership.projectId,
    role: authenticated.membership.role,
    membershipId: authenticated.membership.membershipId
  });
}

/**
 * Authenticate a device without project membership resolution (device-only operations).
 * Prefer `authenticateHumanForProject` for project-scoped APIs.
 */
export function authenticateHumanDevice(
  repository: HumanIdentityRepository,
  authorization: string | string[] | undefined
):
  | {
      humanPrincipalId: string;
      displayName: string;
      deviceCredentialId: string;
    }
  | undefined {
  const token = parseHumanDeviceBearer(authorization);
  if (!token) return undefined;
  const authenticated = repository.authenticateDevice(token);
  if (!authenticated) return undefined;
  return {
    humanPrincipalId: authenticated.principal.humanPrincipalId,
    displayName: authenticated.principal.displayName,
    deviceCredentialId: authenticated.device.deviceCredentialId
  };
}

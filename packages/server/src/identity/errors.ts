import { z } from "zod";

/**
 * Stable error codes for human identity and authorization.
 * Application layers map these to HTTP/status without leaking secrets or digests.
 */
export const humanAuthErrorCodeSchema = z.enum([
  "human_auth_unauthenticated",
  "human_auth_forbidden",
  "human_auth_project_mismatch",
  "human_membership_required",
  "human_role_insufficient",
  "human_last_owner_protected",
  "human_self_target_forbidden",
  "human_bootstrap_requires_local_admin",
  "human_bootstrap_conflict",
  "human_invitation_invalid",
  "human_invitation_expired",
  "human_invitation_revoked",
  "human_invitation_consumed",
  "human_invitation_role_forbidden",
  "human_device_revoked",
  "human_device_expired",
  "human_device_not_owner",
  "human_credential_kind_mismatch",
  "human_cross_project_forbidden",
  "human_identity_workspace_mismatch",
  "human_input_invalid",
  "human_limit_exceeded"
]);

export type HumanAuthErrorCode = z.infer<typeof humanAuthErrorCodeSchema>;

export type HumanAuthDenial = {
  allowed: false;
  code: HumanAuthErrorCode;
  message: string;
};

export type HumanAuthAllowance = {
  allowed: true;
};

export type HumanAuthDecision = HumanAuthAllowance | HumanAuthDenial;

export function denyHumanAuth(code: HumanAuthErrorCode, message: string): HumanAuthDenial {
  return { allowed: false, code, message };
}

export function allowHumanAuth(): HumanAuthAllowance {
  return { allowed: true };
}

/** Safe messages; never include tokens, digests, or membership enumeration hints. */
export const HUMAN_AUTH_ERROR_MESSAGES: Readonly<Record<HumanAuthErrorCode, string>> = {
  human_auth_unauthenticated: "Authentication required.",
  human_auth_forbidden: "Action is not permitted.",
  human_auth_project_mismatch: "Authenticated project scope does not match the target project.",
  human_membership_required: "Active project membership is required.",
  human_role_insufficient: "Project role is insufficient for this action.",
  human_last_owner_protected: "The last project owner cannot be removed or demoted.",
  human_self_target_forbidden: "This action cannot target the acting principal in that way.",
  human_bootstrap_requires_local_admin:
    "Owner bootstrap requires a local administrative proof or command.",
  human_bootstrap_conflict: "Project already has a different owner bootstrap.",
  human_invitation_invalid: "Invitation is not valid.",
  human_invitation_expired: "Invitation has expired.",
  human_invitation_revoked: "Invitation has been revoked.",
  human_invitation_consumed: "Invitation has already been consumed.",
  human_invitation_role_forbidden: "Invitations may only grant the member role.",
  human_device_revoked: "Device credential has been revoked.",
  human_device_expired: "Device credential has expired.",
  human_device_not_owner: "Device credential is not owned by the acting principal.",
  human_credential_kind_mismatch: "Credential kind is not valid for human authentication.",
  human_cross_project_forbidden: "Cross-project access is not permitted.",
  human_identity_workspace_mismatch: "Human identity is bound to a different workspace.",
  human_input_invalid: "Request input failed validation.",
  human_limit_exceeded: "A project or principal limit would be exceeded."
};

export class HumanIdentityError extends Error {
  constructor(
    readonly code: HumanAuthErrorCode,
    message: string = HUMAN_AUTH_ERROR_MESSAGES[code]
  ) {
    super(message);
    this.name = "HumanIdentityError";
  }
}

export function isHumanIdentityUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

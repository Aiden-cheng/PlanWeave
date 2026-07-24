import {
  allowHumanAuth,
  denyHumanAuth,
  HUMAN_AUTH_ERROR_MESSAGES,
  type HumanAuthDecision,
  type HumanAuthErrorCode
} from "./errors.js";
import {
  evaluateInvitationUsability,
  type HumanAuthContext,
  type LocalAdministrativeProof,
  type ProjectInvitationMetadata,
  type ProjectMemberRole,
  type ProjectScopedAction
} from "./schemas.js";

/**
 * Authorization subject kinds are intentionally separate.
 * Do not collapse Host, operator, human device, invitation bearer, and local admin
 * into one principal union for auth decisions — credential-specific rules would be erased.
 */
export type HumanPolicySubject =
  | { kind: "unauthenticated" }
  | { kind: "local_administrative_proof"; proof: LocalAdministrativeProof }
  | {
      kind: "invitation_bearer";
      invitation: ProjectInvitationMetadata;
      projectId: string;
      now: Date;
    }
  | { kind: "human"; context: HumanAuthContext };

export type HumanPolicyFacts = {
  /** Target project for the action; required for project-scoped operations. */
  targetProjectId?: string;
  /** Principal being created/bootstrapped or targeted by membership/device actions. */
  targetHumanPrincipalId?: string;
  /** Device targeted by revoke/list-other actions. */
  targetDeviceCredentialId?: string;
  /** Owner of the target device (for own-vs-other checks). */
  targetDeviceOwnerPrincipalId?: string;
  /** Active owner count for the target project (last-owner protection). */
  activeOwnerCount?: number;
  /** Role of the membership being removed/demoted/promoted. */
  targetMembershipRole?: ProjectMemberRole;
  /**
   * When bootstrapping: existing active owner principal id if any.
   * Same as target → idempotent allow; different → conflict; absent → allow create.
   */
  existingOwnerPrincipalId?: string;
};

export type AuthorizeHumanActionInput = {
  action: ProjectScopedAction;
  subject: HumanPolicySubject;
  facts?: HumanPolicyFacts;
};

function denial(code: HumanAuthErrorCode): HumanAuthDecision {
  return denyHumanAuth(code, HUMAN_AUTH_ERROR_MESSAGES[code]);
}

function requireTargetProject(
  facts: HumanPolicyFacts | undefined
): { ok: true; projectId: string } | { ok: false; decision: HumanAuthDecision } {
  const projectId = facts?.targetProjectId;
  if (!projectId) {
    return { ok: false, decision: denial("human_input_invalid") };
  }
  return { ok: true, projectId };
}

function humanOnProject(
  subject: HumanPolicySubject,
  projectId: string
): { ok: true; context: HumanAuthContext } | { ok: false; decision: HumanAuthDecision } {
  if (subject.kind === "unauthenticated") {
    return { ok: false, decision: denial("human_auth_unauthenticated") };
  }
  if (subject.kind !== "human") {
    return { ok: false, decision: denial("human_auth_forbidden") };
  }
  if (subject.context.projectId !== projectId) {
    return { ok: false, decision: denial("human_auth_project_mismatch") };
  }
  return { ok: true, context: subject.context };
}

function requireOwner(context: HumanAuthContext): HumanAuthDecision | undefined {
  if (context.role !== "owner") {
    return denial("human_role_insufficient");
  }
  return undefined;
}

function requireMemberOrOwner(context: HumanAuthContext): HumanAuthDecision | undefined {
  if (context.role !== "owner" && context.role !== "member") {
    return denial("human_role_insufficient");
  }
  return undefined;
}

function isSelf(context: HumanAuthContext, targetHumanPrincipalId: string | undefined): boolean {
  return (
    targetHumanPrincipalId !== undefined && context.humanPrincipalId === targetHumanPrincipalId
  );
}

function protectLastOwner(facts: HumanPolicyFacts | undefined): HumanAuthDecision | undefined {
  const owners = facts?.activeOwnerCount;
  if (owners === undefined) {
    return denial("human_input_invalid");
  }
  if (owners <= 1 && facts?.targetMembershipRole === "owner") {
    return denial("human_last_owner_protected");
  }
  return undefined;
}

/**
 * Central authorization table for human collaboration.
 *
 * Permission matrix (active membership required unless noted):
 *
 * | Action                 | Unauth | Invite bearer | Member | Owner | Local admin |
 * |------------------------|--------|---------------|--------|-------|-------------|
 * | bootstrap_owner        | deny   | deny          | deny   | deny* | allow†      |
 * | view_project           | deny   | deny          | allow  | allow | deny        |
 * | view_members           | deny   | deny          | allow  | allow | deny        |
 * | create_invitation      | deny   | deny          | deny   | allow | deny        |
 * | revoke_invitation      | deny   | deny          | deny   | allow | deny        |
 * | join_project           | deny   | allow‡        | deny§  | deny§ | deny        |
 * | list_own_devices       | deny   | deny          | allow  | allow | deny        |
 * | list_project_devices   | deny   | deny          | deny   | allow | deny        |
 * | revoke_own_device      | deny   | deny          | allow  | allow | deny        |
 * | revoke_member_device   | deny   | deny          | deny   | allow | deny        |
 * | remove_member          | deny   | deny          | self‖  | yes‖  | deny        |
 * | promote_owner          | deny   | deny          | deny   | allow | deny        |
 * | demote_owner           | deny   | deny          | deny   | yes‖  | deny        |
 * | assign_work            | deny   | deny          | allow  | allow | deny        |
 * | comment                | deny   | deny          | allow  | allow | deny        |
 * | view_activity          | deny   | deny          | allow  | allow | deny        |
 * | remote_run_control     | deny   | deny          | allow  | allow | deny        |
 *
 * \* Network-authenticated humans cannot bootstrap ownership.
 * † Requires local administrative proof; idempotent when same principal is already sole/known owner.
 * ‡ Invitation grants `member` only; never owner. Unauthenticated first network join is never owner.
 * § Join is invitation-bearer only; already-authenticated humans consume invites via invitation_bearer
 *   after digest match (linking is an application concern, still not owner elevation).
 * ‖ Last-owner cannot be removed or demoted; owner may self-leave only when another owner remains.
 *   Member may self-leave. Only owners may remove other members.
 */
export function authorizeHumanAction(input: AuthorizeHumanActionInput): HumanAuthDecision {
  const { action, subject, facts } = input;

  switch (action) {
    case "bootstrap_owner":
      return authorizeBootstrap(subject, facts);
    case "join_project":
      return authorizeJoin(subject, facts);
    case "view_project":
    case "view_members":
    case "assign_work":
    case "comment":
    case "view_activity":
    case "remote_run_control":
      return authorizeMemberAction(subject, facts);
    case "create_invitation":
    case "revoke_invitation":
    case "list_project_devices":
    case "promote_owner":
      return authorizeOwnerAction(subject, facts);
    case "list_own_devices":
    case "revoke_own_device":
      return authorizeOwnDeviceAction(subject, facts, action);
    case "revoke_member_device":
      return authorizeRevokeMemberDevice(subject, facts);
    case "remove_member":
      return authorizeRemoveMember(subject, facts);
    case "demote_owner":
      return authorizeDemoteOwner(subject, facts);
    default: {
      const _exhaustive: never = action;
      return denial("human_auth_forbidden");
    }
  }
}

function authorizeBootstrap(
  subject: HumanPolicySubject,
  facts: HumanPolicyFacts | undefined
): HumanAuthDecision {
  if (subject.kind === "unauthenticated") {
    return denial("human_bootstrap_requires_local_admin");
  }
  if (subject.kind === "invitation_bearer") {
    return denial("human_bootstrap_requires_local_admin");
  }
  if (subject.kind === "human") {
    // Authenticated network humans never become first owner via network join paths.
    return denial("human_bootstrap_requires_local_admin");
  }
  if (subject.kind !== "local_administrative_proof") {
    return denial("human_bootstrap_requires_local_admin");
  }

  const project = requireTargetProject(facts);
  if (!project.ok) return project.decision;
  if (subject.proof.projectId !== project.projectId) {
    return denial("human_auth_project_mismatch");
  }

  const targetHumanPrincipalId =
    facts?.targetHumanPrincipalId ?? subject.proof.humanPrincipalId;
  if (subject.proof.humanPrincipalId !== targetHumanPrincipalId) {
    return denial("human_input_invalid");
  }

  const existing = facts?.existingOwnerPrincipalId;
  if (existing !== undefined && existing !== targetHumanPrincipalId) {
    return denial("human_bootstrap_conflict");
  }
  // existing === target or absent: idempotent allow
  return allowHumanAuth();
}

function authorizeJoin(
  subject: HumanPolicySubject,
  facts: HumanPolicyFacts | undefined
): HumanAuthDecision {
  const project = requireTargetProject(facts);
  if (!project.ok) return project.decision;

  if (subject.kind !== "invitation_bearer") {
    // Network join without a usable invitation is never owner and is not join.
    if (subject.kind === "unauthenticated") {
      return denial("human_auth_unauthenticated");
    }
    return denial("human_auth_forbidden");
  }

  if (subject.projectId !== project.projectId) {
    return denial("human_cross_project_forbidden");
  }

  const usability = evaluateInvitationUsability({
    invitation: subject.invitation,
    projectId: project.projectId,
    now: subject.now
  });
  if (!usability.usable) {
    return denial(usability.code);
  }
  // Invitation role is constrained to member by schema + usability; never elevates to owner.
  return allowHumanAuth();
}

function authorizeMemberAction(
  subject: HumanPolicySubject,
  facts: HumanPolicyFacts | undefined
): HumanAuthDecision {
  const project = requireTargetProject(facts);
  if (!project.ok) return project.decision;
  const human = humanOnProject(subject, project.projectId);
  if (!human.ok) return human.decision;
  const roleDenial = requireMemberOrOwner(human.context);
  if (roleDenial) return roleDenial;
  return allowHumanAuth();
}

function authorizeOwnerAction(
  subject: HumanPolicySubject,
  facts: HumanPolicyFacts | undefined
): HumanAuthDecision {
  const project = requireTargetProject(facts);
  if (!project.ok) return project.decision;
  const human = humanOnProject(subject, project.projectId);
  if (!human.ok) return human.decision;
  const roleDenial = requireOwner(human.context);
  if (roleDenial) return roleDenial;
  return allowHumanAuth();
}

function authorizeOwnDeviceAction(
  subject: HumanPolicySubject,
  facts: HumanPolicyFacts | undefined,
  action: "list_own_devices" | "revoke_own_device"
): HumanAuthDecision {
  const project = requireTargetProject(facts);
  if (!project.ok) return project.decision;
  const human = humanOnProject(subject, project.projectId);
  if (!human.ok) return human.decision;
  const roleDenial = requireMemberOrOwner(human.context);
  if (roleDenial) return roleDenial;

  if (action === "revoke_own_device") {
    const ownerId = facts?.targetDeviceOwnerPrincipalId;
    if (ownerId === undefined) {
      return denial("human_input_invalid");
    }
    if (ownerId !== human.context.humanPrincipalId) {
      return denial("human_device_not_owner");
    }
  }
  return allowHumanAuth();
}

function authorizeRevokeMemberDevice(
  subject: HumanPolicySubject,
  facts: HumanPolicyFacts | undefined
): HumanAuthDecision {
  const project = requireTargetProject(facts);
  if (!project.ok) return project.decision;
  const human = humanOnProject(subject, project.projectId);
  if (!human.ok) return human.decision;
  const roleDenial = requireOwner(human.context);
  if (roleDenial) return roleDenial;

  const ownerId = facts?.targetDeviceOwnerPrincipalId;
  if (ownerId === undefined) {
    return denial("human_input_invalid");
  }
  // Owners may revoke any project-relevant device, including their own, via this action.
  // Prefer revoke_own_device for self-service; both are allowed for owners.
  return allowHumanAuth();
}

function authorizeRemoveMember(
  subject: HumanPolicySubject,
  facts: HumanPolicyFacts | undefined
): HumanAuthDecision {
  const project = requireTargetProject(facts);
  if (!project.ok) return project.decision;
  const human = humanOnProject(subject, project.projectId);
  if (!human.ok) return human.decision;
  const roleDenial = requireMemberOrOwner(human.context);
  if (roleDenial) return roleDenial;

  const targetId = facts?.targetHumanPrincipalId;
  if (targetId === undefined || facts?.targetMembershipRole === undefined) {
    return denial("human_input_invalid");
  }

  const self = isSelf(human.context, targetId);
  if (!self && human.context.role !== "owner") {
    // Members may only self-leave; only owners remove others.
    return denial("human_role_insufficient");
  }

  const lastOwner = protectLastOwner(facts);
  if (lastOwner) return lastOwner;

  return allowHumanAuth();
}

function authorizeDemoteOwner(
  subject: HumanPolicySubject,
  facts: HumanPolicyFacts | undefined
): HumanAuthDecision {
  const project = requireTargetProject(facts);
  if (!project.ok) return project.decision;
  const human = humanOnProject(subject, project.projectId);
  if (!human.ok) return human.decision;
  const roleDenial = requireOwner(human.context);
  if (roleDenial) return roleDenial;

  if (facts?.targetHumanPrincipalId === undefined) {
    return denial("human_input_invalid");
  }
  if (facts.targetMembershipRole !== "owner") {
    return denial("human_input_invalid");
  }

  const lastOwner = protectLastOwner({
    ...facts,
    targetMembershipRole: "owner"
  });
  if (lastOwner) return lastOwner;

  return allowHumanAuth();
}

/**
 * Helper for persistence layers: active membership facts for policy.
 * Pure — does not touch storage.
 */
export function membershipRoleForPolicy(
  membership: {
    projectId: string;
    humanPrincipalId: string;
    role: ProjectMemberRole;
    revokedAt?: string;
  },
  projectId: string
): ProjectMemberRole | undefined {
  if (membership.projectId !== projectId) return undefined;
  if (membership.revokedAt !== undefined) return undefined;
  return membership.role;
}

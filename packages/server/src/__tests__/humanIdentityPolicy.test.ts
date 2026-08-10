import { describe, expect, it } from "vitest";
import { authorizeHumanAction, type HumanPolicySubject } from "../identity/policy.js";
import {
  humanAuthContextSchema,
  localAdministrativeProofSchema,
  projectInvitationMetadataSchema,
  type HumanAuthContext,
  type ProjectScopedAction
} from "../identity/schemas.js";

const now = new Date("2026-07-24T12:00:00.000Z");
const digest = "c".repeat(64);

function humanContext(
  overrides: Partial<{
    humanPrincipalId: string;
    projectId: string;
    role: "owner" | "member";
  }> = {}
): HumanAuthContext {
  return humanAuthContextSchema.parse({
    humanPrincipalId: overrides.humanPrincipalId ?? "human-1",
    displayName: "Ada",
    deviceCredentialId: "device-1",
    projectId: overrides.projectId ?? "project-a",
    role: overrides.role ?? "member",
    membershipId: "membership-1"
  });
}

function humanSubject(overrides?: Parameters<typeof humanContext>[0]): HumanPolicySubject {
  return { kind: "human", context: humanContext(overrides) };
}

function invitation(projectId = "project-a") {
  return projectInvitationMetadataSchema.parse({
    invitationId: "invite-1",
    projectId,
    role: "member",
    createdByHumanPrincipalId: "human-owner",
    tokenSha256: digest,
    createdAt: "2026-07-24T10:00:00.000Z",
    expiresAt: "2026-07-25T10:00:00.000Z"
  });
}

function localAdmin(projectId = "project-a", humanPrincipalId = "human-1") {
  return localAdministrativeProofSchema.parse({
    kind: "local_administrative_proof",
    projectId,
    humanPrincipalId,
    displayName: "Ada",
    issuedAt: "2026-07-24T10:00:00.000Z"
  });
}

function decide(
  action: ProjectScopedAction,
  subject: HumanPolicySubject,
  facts: Parameters<typeof authorizeHumanAction>[0]["facts"]
) {
  return authorizeHumanAction({ action, subject, facts });
}

describe("authorizeHumanAction policy table", () => {
  it("allows local-admin owner bootstrap and is idempotent for the same principal", () => {
    const subject: HumanPolicySubject = {
      kind: "local_administrative_proof",
      proof: localAdmin()
    };
    expect(
      decide("bootstrap_owner", subject, {
        targetProjectId: "project-a",
        targetHumanPrincipalId: "human-1"
      })
    ).toEqual({ allowed: true });

    expect(
      decide("bootstrap_owner", subject, {
        targetProjectId: "project-a",
        targetHumanPrincipalId: "human-1",
        existingOwnerPrincipalId: "human-1"
      })
    ).toEqual({ allowed: true });

    expect(
      decide("bootstrap_owner", subject, {
        targetProjectId: "project-a",
        targetHumanPrincipalId: "human-1",
        existingOwnerPrincipalId: "human-other"
      })
    ).toMatchObject({ allowed: false, code: "human_bootstrap_conflict" });
  });

  it("never allows network human or unauthenticated bootstrap / first join as owner", () => {
    expect(
      decide("bootstrap_owner", { kind: "unauthenticated" }, { targetProjectId: "project-a" })
    ).toMatchObject({ allowed: false, code: "human_bootstrap_requires_local_admin" });

    expect(
      decide("bootstrap_owner", humanSubject({ role: "member" }), {
        targetProjectId: "project-a",
        targetHumanPrincipalId: "human-1"
      })
    ).toMatchObject({ allowed: false, code: "human_bootstrap_requires_local_admin" });

    expect(
      decide("bootstrap_owner", humanSubject({ role: "owner" }), {
        targetProjectId: "project-a",
        targetHumanPrincipalId: "human-1"
      })
    ).toMatchObject({ allowed: false, code: "human_bootstrap_requires_local_admin" });

    expect(
      decide(
        "join_project",
        {
          kind: "invitation_bearer",
          invitation: invitation(),
          projectId: "project-a",
          now
        },
        { targetProjectId: "project-a" }
      )
    ).toEqual({ allowed: true });
    // join never elevates: invitation schema role is member-only
    expect(invitation().role).toBe("member");
  });

  it("denies cross-project membership and invitation use", () => {
    expect(
      decide("view_project", humanSubject({ projectId: "project-a" }), {
        targetProjectId: "project-b"
      })
    ).toMatchObject({ allowed: false, code: "human_auth_project_mismatch" });

    expect(
      decide(
        "join_project",
        {
          kind: "invitation_bearer",
          invitation: invitation("project-a"),
          projectId: "project-a",
          now
        },
        { targetProjectId: "project-b" }
      )
    ).toMatchObject({ allowed: false, code: "human_cross_project_forbidden" });

    expect(
      decide(
        "bootstrap_owner",
        { kind: "local_administrative_proof", proof: localAdmin("project-a") },
        { targetProjectId: "project-b", targetHumanPrincipalId: "human-1" }
      )
    ).toMatchObject({ allowed: false, code: "human_auth_project_mismatch" });
  });

  it("enforces invitation create/revoke as owner-only and member collaboration actions", () => {
    const member = humanSubject({ role: "member" });
    const owner = humanSubject({ role: "owner" });
    const project = { targetProjectId: "project-a" };

    for (const action of [
      "create_invitation",
      "revoke_invitation",
      "list_project_devices",
      "promote_owner"
    ] as const) {
      expect(decide(action, member, project)).toMatchObject({
        allowed: false,
        code: "human_role_insufficient"
      });
      expect(decide(action, owner, project)).toEqual({ allowed: true });
    }

    for (const action of [
      "view_project",
      "view_members",
      "update_own_profile",
      "assign_work",
      "comment",
      "view_activity",
      "remote_run_control",
      "list_own_devices"
    ] as const) {
      expect(decide(action, member, project)).toEqual({ allowed: true });
      expect(decide(action, owner, project)).toEqual({ allowed: true });
      expect(decide(action, { kind: "unauthenticated" }, project)).toMatchObject({
        allowed: false,
        code: "human_auth_unauthenticated"
      });
    }
  });

  it("protects last owner on demote, remove, and self-leave", () => {
    const owner = humanSubject({ role: "owner", humanPrincipalId: "human-1" });

    expect(
      decide("demote_owner", owner, {
        targetProjectId: "project-a",
        targetHumanPrincipalId: "human-1",
        targetMembershipRole: "owner",
        activeOwnerCount: 1
      })
    ).toMatchObject({ allowed: false, code: "human_last_owner_protected" });

    expect(
      decide("remove_member", owner, {
        targetProjectId: "project-a",
        targetHumanPrincipalId: "human-1",
        targetMembershipRole: "owner",
        activeOwnerCount: 1
      })
    ).toMatchObject({ allowed: false, code: "human_last_owner_protected" });

    expect(
      decide("demote_owner", owner, {
        targetProjectId: "project-a",
        targetHumanPrincipalId: "human-2",
        targetMembershipRole: "owner",
        activeOwnerCount: 2
      })
    ).toEqual({ allowed: true });

    // Owner may self-leave when another owner remains.
    expect(
      decide("remove_member", owner, {
        targetProjectId: "project-a",
        targetHumanPrincipalId: "human-1",
        targetMembershipRole: "owner",
        activeOwnerCount: 2
      })
    ).toEqual({ allowed: true });
  });

  it("allows member self-leave but not removing others; owners may remove others", () => {
    const member = humanSubject({ role: "member", humanPrincipalId: "human-member" });
    const owner = humanSubject({ role: "owner", humanPrincipalId: "human-owner" });

    expect(
      decide("remove_member", member, {
        targetProjectId: "project-a",
        targetHumanPrincipalId: "human-member",
        targetMembershipRole: "member",
        activeOwnerCount: 1
      })
    ).toEqual({ allowed: true });

    expect(
      decide("remove_member", member, {
        targetProjectId: "project-a",
        targetHumanPrincipalId: "human-other",
        targetMembershipRole: "member",
        activeOwnerCount: 1
      })
    ).toMatchObject({ allowed: false, code: "human_role_insufficient" });

    expect(
      decide("remove_member", owner, {
        targetProjectId: "project-a",
        targetHumanPrincipalId: "human-member",
        targetMembershipRole: "member",
        activeOwnerCount: 1
      })
    ).toEqual({ allowed: true });
  });

  it("scopes device revoke to own device for members and allows owner project device revoke", () => {
    const member = humanSubject({ role: "member", humanPrincipalId: "human-member" });
    const owner = humanSubject({ role: "owner", humanPrincipalId: "human-owner" });

    expect(
      decide("revoke_own_device", member, {
        targetProjectId: "project-a",
        targetDeviceOwnerPrincipalId: "human-member",
        targetDeviceCredentialId: "device-1"
      })
    ).toEqual({ allowed: true });

    expect(
      decide("revoke_own_device", member, {
        targetProjectId: "project-a",
        targetDeviceOwnerPrincipalId: "human-other",
        targetDeviceCredentialId: "device-2"
      })
    ).toMatchObject({ allowed: false, code: "human_device_not_owner" });

    expect(
      decide("revoke_member_device", member, {
        targetProjectId: "project-a",
        targetDeviceOwnerPrincipalId: "human-other",
        targetDeviceCredentialId: "device-2"
      })
    ).toMatchObject({ allowed: false, code: "human_role_insufficient" });

    expect(
      decide("revoke_member_device", owner, {
        targetProjectId: "project-a",
        targetDeviceOwnerPrincipalId: "human-member",
        targetDeviceCredentialId: "device-2",
        targetDeviceOwnerMembershipActive: true
      })
    ).toEqual({ allowed: true });

    // Owner cannot revoke devices of principals with no active membership on this project.
    expect(
      decide("revoke_member_device", owner, {
        targetProjectId: "project-a",
        targetDeviceOwnerPrincipalId: "human-other-project-only",
        targetDeviceCredentialId: "device-foreign",
        targetDeviceOwnerMembershipActive: false
      })
    ).toMatchObject({ allowed: false, code: "human_membership_required" });

    expect(
      decide("revoke_member_device", owner, {
        targetProjectId: "project-a",
        targetDeviceOwnerPrincipalId: "human-other-project-only",
        targetDeviceCredentialId: "device-foreign"
      })
    ).toMatchObject({ allowed: false, code: "human_membership_required" });
  });

  it("rejects Host-like subjects by requiring concrete human policy subject kinds only", () => {
    // There is no host subject kind; attempting to authorize with unauthenticated or wrong kind fails closed.
    expect(
      decide("remote_run_control", { kind: "unauthenticated" }, { targetProjectId: "project-a" })
    ).toMatchObject({ allowed: false, code: "human_auth_unauthenticated" });

    expect(
      decide("join_project", { kind: "unauthenticated" }, { targetProjectId: "project-a" })
    ).toMatchObject({ allowed: false, code: "human_auth_unauthenticated" });

    // Invitation bearer cannot perform member project actions (credential-kind mismatch at subject boundary).
    expect(
      decide(
        "view_project",
        {
          kind: "invitation_bearer",
          invitation: invitation(),
          projectId: "project-a",
          now
        },
        { targetProjectId: "project-a" }
      )
    ).toMatchObject({ allowed: false, code: "human_auth_forbidden" });

    // Local admin proof cannot substitute for human membership on collaboration actions.
    expect(
      decide(
        "assign_work",
        { kind: "local_administrative_proof", proof: localAdmin() },
        { targetProjectId: "project-a" }
      )
    ).toMatchObject({ allowed: false, code: "human_auth_forbidden" });
  });

  it("denies join with expired or cross-project invitation bearer", () => {
    const expired = projectInvitationMetadataSchema.parse({
      ...invitation(),
      expiresAt: "2026-07-24T11:00:00.000Z"
    });
    expect(
      decide(
        "join_project",
        {
          kind: "invitation_bearer",
          invitation: expired,
          projectId: "project-a",
          now
        },
        { targetProjectId: "project-a" }
      )
    ).toMatchObject({ allowed: false, code: "human_invitation_expired" });
  });
});

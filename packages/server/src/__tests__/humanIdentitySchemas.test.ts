import {
  hostCredentialTokenSchema,
  hostEnrollmentCodeSchema
} from "@planweave-ai/agent-host-protocol";
import { describe, expect, it } from "vitest";
import {
  actorRefFromHuman,
  actorRefSchema,
  evaluateDeviceUsability,
  evaluateInvitationUsability,
  humanAuthContextSchema,
  humanDeviceCredentialMetadataSchema,
  humanDeviceTokenSchema,
  humanPrincipalSchema,
  localAdministrativeProofSchema,
  projectInvitationMetadataSchema,
  projectInvitationTokenSchema,
  projectMembershipSchema,
  projectScopedActionSchema,
  tokenSha256HexSchema
} from "../identity/schemas.js";

const now = new Date("2026-07-24T12:00:00.000Z");
const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const humanDeviceToken = `pw_hdev_${"A".repeat(43)}`;
const invitationToken = `pw_inv_${"B".repeat(43)}`;
const hostToken = `pw_host_${"C".repeat(43)}`;
const enrollToken = `pw_enroll_${"D".repeat(43)}`;

function principal() {
  return humanPrincipalSchema.parse({
    humanPrincipalId: "human-1",
    displayName: "Ada",
    createdAt: "2026-07-24T10:00:00.000Z"
  });
}

function membership(role: "owner" | "member" = "member") {
  return projectMembershipSchema.parse({
    membershipId: "membership-1",
    projectId: "project-a",
    humanPrincipalId: "human-1",
    role,
    revision: 1,
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z"
  });
}

function invitation(overrides: Record<string, unknown> = {}) {
  return projectInvitationMetadataSchema.parse({
    invitationId: "invite-1",
    projectId: "project-a",
    role: "member",
    createdByHumanPrincipalId: "human-owner",
    tokenSha256: digestA,
    createdAt: "2026-07-24T10:00:00.000Z",
    expiresAt: "2026-07-25T10:00:00.000Z",
    ...overrides
  });
}

function device(overrides: Record<string, unknown> = {}) {
  return humanDeviceCredentialMetadataSchema.parse({
    deviceCredentialId: "device-1",
    humanPrincipalId: "human-1",
    mintedForProjectId: "project-a",
    tokenSha256: digestB,
    createdAt: "2026-07-24T10:00:00.000Z",
    ...overrides
  });
}

describe("human identity schemas", () => {
  it("accepts strict human principal, membership, invitation, and device metadata", () => {
    expect(principal().displayName).toBe("Ada");
    expect(membership("owner").role).toBe("owner");
    expect(membership("owner").revision).toBe(1);
    expect(invitation().role).toBe("member");
    expect(device().tokenSha256).toHaveLength(64);
    expect(
      humanAuthContextSchema.parse({
        humanPrincipalId: "human-1",
        displayName: "Ada",
        deviceCredentialId: "device-1",
        projectId: "project-a",
        role: "owner",
        membershipId: "membership-1"
      }).role
    ).toBe("owner");
  });

  it("rejects invitation roles other than member and incomplete consumption markers", () => {
    expect(() =>
      projectInvitationMetadataSchema.parse({
        ...invitation(),
        role: "owner"
      })
    ).toThrow();
    expect(() =>
      projectInvitationMetadataSchema.parse({
        ...invitation(),
        consumedAt: "2026-07-24T11:00:00.000Z"
      })
    ).toThrow();
  });

  it("uses distinct human token wire forms and rejects Host/enroll credentials", () => {
    expect(humanDeviceTokenSchema.parse(humanDeviceToken)).toBe(humanDeviceToken);
    expect(projectInvitationTokenSchema.parse(invitationToken)).toBe(invitationToken);

    expect(() => humanDeviceTokenSchema.parse(hostToken)).toThrow();
    expect(() => humanDeviceTokenSchema.parse(enrollToken)).toThrow();
    expect(() => humanDeviceTokenSchema.parse(invitationToken)).toThrow();
    expect(() => projectInvitationTokenSchema.parse(humanDeviceToken)).toThrow();
    expect(() => projectInvitationTokenSchema.parse(hostToken)).toThrow();

    // Host schemas must not accept human secrets (credential-kind isolation).
    expect(() => hostCredentialTokenSchema.parse(humanDeviceToken)).toThrow();
    expect(() => hostCredentialTokenSchema.parse(invitationToken)).toThrow();
    expect(() => hostEnrollmentCodeSchema.parse(humanDeviceToken)).toThrow();
    expect(hostCredentialTokenSchema.parse(hostToken)).toBe(hostToken);
  });

  it("rejects Host-shaped values from human auth context construction", () => {
    expect(() =>
      humanAuthContextSchema.parse({
        humanPrincipalId: "host-looking-id",
        displayName: "Not A Host",
        deviceCredentialId: "device-1",
        projectId: "project-a",
        role: "owner",
        membershipId: "membership-1",
        // extra Host fields must fail strict object
        hostId: "host-1",
        tokenSha256: digestA
      })
    ).toThrow();
  });

  it("keeps ActorRef as display-only projection without secrets", () => {
    const context = humanAuthContextSchema.parse({
      humanPrincipalId: "human-1",
      displayName: "Ada",
      deviceCredentialId: "device-1",
      projectId: "project-a",
      role: "member",
      membershipId: "membership-1"
    });
    const ref = actorRefFromHuman(context);
    expect(ref).toEqual({ kind: "human", id: "human-1", displayName: "Ada" });
    expect(actorRefSchema.safeParse({ kind: "human", id: "human-1", token: "x" }).success).toBe(
      false
    );
  });

  it("validates local administrative proof as non-network bootstrap subject payload", () => {
    expect(
      localAdministrativeProofSchema.parse({
        kind: "local_administrative_proof",
        projectId: "project-a",
        humanPrincipalId: "human-1",
        displayName: "Ada",
        issuedAt: "2026-07-24T10:00:00.000Z"
      }).kind
    ).toBe("local_administrative_proof");
    expect(() =>
      localAdministrativeProofSchema.parse({
        kind: "operator",
        projectId: "project-a",
        humanPrincipalId: "human-1",
        displayName: "Ada",
        issuedAt: "2026-07-24T10:00:00.000Z"
      })
    ).toThrow();
  });

  it("evaluates invitation and device usability including cross-project and expiry", () => {
    expect(
      evaluateInvitationUsability({
        invitation: invitation(),
        projectId: "project-a",
        now
      })
    ).toEqual({ usable: true });

    expect(
      evaluateInvitationUsability({
        invitation: invitation(),
        projectId: "project-b",
        now
      })
    ).toEqual({ usable: false, code: "human_cross_project_forbidden" });

    expect(
      evaluateInvitationUsability({
        invitation: invitation({ expiresAt: "2026-07-24T11:00:00.000Z" }),
        projectId: "project-a",
        now
      })
    ).toEqual({ usable: false, code: "human_invitation_expired" });

    expect(
      evaluateInvitationUsability({
        invitation: invitation({ revokedAt: "2026-07-24T11:00:00.000Z" }),
        projectId: "project-a",
        now
      })
    ).toEqual({ usable: false, code: "human_invitation_revoked" });

    expect(
      evaluateInvitationUsability({
        invitation: invitation({
          consumedAt: "2026-07-24T11:00:00.000Z",
          consumedByHumanPrincipalId: "human-2"
        }),
        projectId: "project-a",
        now
      })
    ).toEqual({ usable: false, code: "human_invitation_consumed" });

    expect(
      evaluateDeviceUsability({
        device: device(),
        humanPrincipalId: "human-1",
        now
      })
    ).toEqual({ usable: true });

    expect(
      evaluateDeviceUsability({
        device: device(),
        humanPrincipalId: "human-2",
        now
      })
    ).toEqual({ usable: false, code: "human_device_not_owner" });

    expect(
      evaluateDeviceUsability({
        device: device({ revokedAt: "2026-07-24T11:00:00.000Z" }),
        humanPrincipalId: "human-1",
        now
      })
    ).toEqual({ usable: false, code: "human_device_revoked" });

    expect(
      evaluateDeviceUsability({
        device: device({ expiresAt: "2026-07-24T11:00:00.000Z" }),
        humanPrincipalId: "human-1",
        now
      })
    ).toEqual({ usable: false, code: "human_device_expired" });
  });

  it("rejects invalid digests and unknown project actions", () => {
    expect(() => tokenSha256HexSchema.parse("not-hex")).toThrow();
    expect(() => tokenSha256HexSchema.parse("A".repeat(64))).toThrow();
    expect(projectScopedActionSchema.parse("bootstrap_owner")).toBe("bootstrap_owner");
    expect(projectScopedActionSchema.parse("update_own_profile")).toBe("update_own_profile");
    expect(() => projectScopedActionSchema.parse("delete_project")).toThrow();
  });

  it("rejects oversized display names and free-text bodies at schema boundary", () => {
    expect(() =>
      humanPrincipalSchema.parse({
        humanPrincipalId: "human-1",
        displayName: "x".repeat(129),
        createdAt: "2026-07-24T10:00:00.000Z"
      })
    ).toThrow();
  });
});

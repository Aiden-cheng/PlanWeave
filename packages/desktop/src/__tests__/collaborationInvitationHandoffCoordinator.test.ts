import { describe, expect, it, vi } from "vitest";
import { parseCollaborationInvitationHandoffV2 } from "@planweave-ai/collaboration-protocol/handoff/invitation";
import { CollaborationInvitationHandoffCoordinator } from "../main/collaboration/CollaborationInvitationHandoffCoordinator.js";
import type { CollaborationProfileView } from "../shared/collaboration.js";

const invitationToken = `pw_inv_${"A".repeat(43)}`;
const invitation = {
  invitation: {
    invitationId: "invitation-1",
    projectId: "project-1",
    role: "member" as const,
    createdByHumanPrincipalId: "human-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-02T00:00:00.000Z"
  },
  invitationToken
};

function profile(profileId: string, serverBaseUrl: string): CollaborationProfileView {
  return {
    profileId,
    displayName: "Server",
    serverBaseUrl,
    projectId: "project-1",
    allowInsecureTransport: false,
    endpoint: {
      topology: "public_https",
      serverOrigin: serverBaseUrl,
      allowedClientOrigins: [serverBaseUrl],
      tlsTrust: "system_ca"
    },
    connectionState: "ready",
    hasDeviceCredential: true,
    deviceCredentialPersistence: "persisted",
    deviceCredentialId: "device-1",
    humanPrincipalId: "human-1",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("CollaborationInvitationHandoffCoordinator", () => {
  it("uses the coordinator endpoint only for its reserved local profile namespace", async () => {
    const activeProfile = profile("planweave-local-project-1", "https://planweave.example.ts.net/");
    activeProfile.endpoint = {
      topology: "private_https",
      serverOrigin: activeProfile.serverBaseUrl,
      allowedClientOrigins: [activeProfile.serverBaseUrl],
      tlsTrust: "system_ca"
    };
    const service = {
      getStatus: vi.fn().mockResolvedValue({
        activeProfileId: activeProfile.profileId,
        profiles: [activeProfile]
      }),
      createInvitation: vi.fn().mockResolvedValue(invitation),
      getInvitationSecret: vi.fn().mockResolvedValue(invitation),
      revokeInvitation: vi.fn()
    };
    const localProfileForId = vi.fn((profileId: string) =>
      profileId === activeProfile.profileId ? activeProfile : null
    );
    const coordinator = new CollaborationInvitationHandoffCoordinator(service, {
      recognizesLocalProfile: (profileId) => profileId.startsWith("planweave-local-"),
      invitationEndpoint: () => ({
        topology: "private_https",
        serverOrigin: "https://planweave.example.ts.net/",
        allowedClientOrigins: ["https://planweave.example.ts.net/"],
        tlsTrust: "system_ca"
      }),
      localProfileForId,
      getExposureView: () => ({ canInvite: true })
    });

    const result = await coordinator.create({});
    expect(parseCollaborationInvitationHandoffV2(result.handoff)?.endpoint.topology).toBe(
      "private_https"
    );
    expect(localProfileForId).toHaveBeenCalledWith(activeProfile.profileId);
  });

  it("uses the active remote profile endpoint instead of the local coordinator", async () => {
    const activeProfile = profile("remote-1", "https://server.example.test/");
    const service = {
      getStatus: vi.fn().mockResolvedValue({
        activeProfileId: activeProfile.profileId,
        profiles: [activeProfile]
      }),
      createInvitation: vi.fn().mockResolvedValue(invitation),
      getInvitationSecret: vi.fn().mockResolvedValue(invitation),
      revokeInvitation: vi.fn()
    };
    const coordinator = new CollaborationInvitationHandoffCoordinator(service, {
      recognizesLocalProfile: () => false,
      invitationEndpoint: () => null,
      localProfileForId: () => null,
      getExposureView: () => ({ canInvite: false })
    });

    const result = await coordinator.create({});
    expect(parseCollaborationInvitationHandoffV2(result.handoff)?.endpoint).toMatchObject({
      topology: "public_https",
      serverOrigin: "https://server.example.test/"
    });
    expect(service.revokeInvitation).not.toHaveBeenCalled();
  });

  it("revokes a newly minted invitation when the active authority changes", async () => {
    const first = profile("remote-1", "https://one.example.test/");
    const second = profile("remote-2", "https://two.example.test/");
    const service = {
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({ activeProfileId: first.profileId, profiles: [first, second] })
        .mockResolvedValueOnce({ activeProfileId: second.profileId, profiles: [first, second] }),
      createInvitation: vi.fn().mockResolvedValue(invitation),
      getInvitationSecret: vi.fn().mockResolvedValue(invitation),
      revokeInvitation: vi.fn().mockResolvedValue(undefined)
    };
    const coordinator = new CollaborationInvitationHandoffCoordinator(service, {
      recognizesLocalProfile: () => false,
      invitationEndpoint: () => null,
      localProfileForId: () => null,
      getExposureView: () => ({ canInvite: false })
    });

    await expect(coordinator.create({})).rejects.toThrow(
      "collaboration_invitation_authority_changed"
    );
    expect(service.revokeInvitation).toHaveBeenCalledWith({ invitationId: "invitation-1" });
  });

  it("reports cleanup failure without returning a mismatched bearer token", async () => {
    const first = profile("remote-1", "https://one.example.test/");
    const second = profile("remote-2", "https://two.example.test/");
    const service = {
      getStatus: vi
        .fn()
        .mockResolvedValueOnce({ activeProfileId: first.profileId, profiles: [first, second] })
        .mockResolvedValueOnce({ activeProfileId: second.profileId, profiles: [first, second] }),
      createInvitation: vi.fn().mockResolvedValue(invitation),
      getInvitationSecret: vi.fn().mockResolvedValue(invitation),
      revokeInvitation: vi.fn().mockRejectedValue(new Error("revoke_failed"))
    };
    const coordinator = new CollaborationInvitationHandoffCoordinator(service, {
      recognizesLocalProfile: () => false,
      invitationEndpoint: () => null,
      localProfileForId: () => null,
      getExposureView: () => ({ canInvite: false })
    });

    await expect(coordinator.create({})).rejects.toThrow(
      "collaboration_invitation_authority_changed_revoke_failed"
    );
  });
});

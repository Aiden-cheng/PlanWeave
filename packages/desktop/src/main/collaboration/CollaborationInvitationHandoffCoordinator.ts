import {
  deploymentEndpointSchema,
  type DeploymentEndpoint
} from "@planweave-ai/collaboration-protocol/deployment";
import {
  collaborationInvitationHandoffResponseSchema,
  serializeCollaborationInvitationHandoffV2,
  type CollaborationInvitationHandoffResponse
} from "@planweave-ai/collaboration-protocol/handoff/invitation";
import type { HumanCreateInvitationResponse } from "@planweave-ai/collaboration-protocol/identity/workspace";
import type { CollaborationStatus } from "../../shared/collaboration.js";

type LocalInvitationAuthority = {
  recognizesLocalProfile(profileId: string): boolean;
  invitationEndpoint(): DeploymentEndpoint | null;
  localProfileForId(profileId: string): {
    profileId: string;
    projectId: string;
    serverBaseUrl: string;
    endpoint: DeploymentEndpoint;
  } | null;
  getExposureView(): { canInvite: boolean };
};

type InvitationAuthoritySnapshot = {
  profileId: string;
  projectId: string;
  endpoint: DeploymentEndpoint;
};

export type CollaborationInvitationHandoffPort = {
  getStatus(): Promise<Pick<CollaborationStatus, "activeProfileId" | "profiles">>;
  createInvitation(input: unknown): Promise<HumanCreateInvitationResponse>;
  getInvitationSecret(input: unknown): Promise<HumanCreateInvitationResponse>;
  revokeInvitation(input: { invitationId: string }): Promise<unknown>;
};

function sameAuthority(
  left: InvitationAuthoritySnapshot,
  right: InvitationAuthoritySnapshot
): boolean {
  return (
    left.profileId === right.profileId &&
    left.projectId === right.projectId &&
    JSON.stringify(left.endpoint) === JSON.stringify(right.endpoint)
  );
}

export class CollaborationInvitationHandoffCoordinator {
  constructor(
    private readonly service: CollaborationInvitationHandoffPort,
    private readonly local: LocalInvitationAuthority
  ) {}

  private async authority(): Promise<InvitationAuthoritySnapshot> {
    const status = await this.service.getStatus();
    const profiles = status.profiles.filter(
      (profile) => profile.profileId === status.activeProfileId
    );
    if (profiles.length !== 1) throw new Error("collaboration_invitation_profile_not_ready");
    const profile = profiles[0]!;
    if (!this.local.recognizesLocalProfile(profile.profileId)) {
      return {
        profileId: profile.profileId,
        projectId: profile.projectId,
        endpoint: deploymentEndpointSchema.parse(profile.endpoint)
      };
    }
    const endpoint = this.local.invitationEndpoint();
    const localProfile = this.local.localProfileForId(profile.profileId);
    if (
      !endpoint ||
      !localProfile ||
      !this.local.getExposureView().canInvite ||
      localProfile.profileId !== profile.profileId ||
      localProfile.projectId !== profile.projectId ||
      localProfile.serverBaseUrl !== profile.serverBaseUrl ||
      JSON.stringify(localProfile.endpoint) !== JSON.stringify(profile.endpoint) ||
      JSON.stringify(endpoint) !== JSON.stringify(profile.endpoint)
    ) {
      throw new Error("collaboration_invitation_endpoint_not_ready");
    }
    return { profileId: profile.profileId, projectId: profile.projectId, endpoint };
  }

  private response(
    invitation: HumanCreateInvitationResponse,
    authority: InvitationAuthoritySnapshot
  ): CollaborationInvitationHandoffResponse {
    if (invitation.invitation.projectId !== authority.projectId) {
      throw new Error("collaboration_invitation_authority_mismatch");
    }
    return collaborationInvitationHandoffResponseSchema.parse({
      ...invitation,
      handoff: serializeCollaborationInvitationHandoffV2({
        endpoint: authority.endpoint,
        projectId: authority.projectId,
        invitationToken: invitation.invitationToken
      })
    });
  }

  async create(input: unknown): Promise<CollaborationInvitationHandoffResponse> {
    const before = await this.authority();
    const invitation = await this.service.createInvitation(input);
    try {
      const response = this.response(invitation, before);
      const after = await this.authority();
      if (!sameAuthority(before, after)) {
        throw new Error("collaboration_invitation_authority_changed");
      }
      return response;
    } catch (error) {
      try {
        await this.service.revokeInvitation({ invitationId: invitation.invitation.invitationId });
      } catch (revokeError) {
        throw new AggregateError(
          [error, revokeError],
          "collaboration_invitation_authority_changed_revoke_failed"
        );
      }
      throw error;
    }
  }

  async get(input: unknown): Promise<CollaborationInvitationHandoffResponse> {
    const before = await this.authority();
    const invitation = await this.service.getInvitationSecret(input);
    const response = this.response(invitation, before);
    const after = await this.authority();
    if (!sameAuthority(before, after)) {
      throw new Error("collaboration_invitation_authority_changed");
    }
    return response;
  }
}

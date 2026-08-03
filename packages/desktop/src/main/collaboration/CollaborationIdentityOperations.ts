import {
  humanDeviceListQuerySchema,
  humanInvitationListQuerySchema,
  humanPageQuerySchema,
  type HumanDevicePage,
  type HumanInvitationPage,
  type HumanInvitationView,
  type HumanMemberPage
} from "@planweave-ai/collaboration-protocol/identity/workspace";
import {
  collaborationCreateInvitationInputSchema,
  collaborationDeviceCredentialIdInputSchema,
  collaborationHumanPrincipalIdInputSchema,
  collaborationInvitationIdInputSchema,
  collaborationInvitationIdsInputSchema,
  type CollaborationInvitationCreateView
} from "../../shared/collaboration.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import type { CollaborationInvitationVault } from "./collaborationInvitationVault.js";

type CollaborationIdentityOperationsDependencies = {
  invitationVault: CollaborationInvitationVault;
  getClientProfileId(): string | null;
  withActiveClient<T>(operation: (client: CollaborationClient) => Promise<T>): Promise<T>;
};

/** Owns session-scoped workspace identity reads and mutations. */
export class CollaborationIdentityOperations {
  constructor(private readonly dependencies: CollaborationIdentityOperationsDependencies) {}

  async listMembers(input: unknown = {}): Promise<HumanMemberPage> {
    return this.dependencies.withActiveClient((client) =>
      client.listMembers(humanPageQuerySchema.parse(input ?? {}))
    );
  }

  async listDevices(input: unknown = {}): Promise<HumanDevicePage> {
    return this.dependencies.withActiveClient((client) =>
      client.listDevices(humanDeviceListQuerySchema.parse(input ?? {}))
    );
  }

  async listInvitations(input: unknown = {}): Promise<HumanInvitationPage> {
    return this.dependencies.withActiveClient((client) =>
      client.listInvitations(humanInvitationListQuerySchema.parse(input ?? {}))
    );
  }

  async createInvitation(input: unknown = {}): Promise<CollaborationInvitationCreateView> {
    const parsed = collaborationCreateInvitationInputSchema.parse(input ?? {});
    const profileId = this.dependencies.getClientProfileId();
    const invitation = await this.dependencies.withActiveClient((client) =>
      client.createInvitation(parsed)
    );
    if (profileId) await this.dependencies.invitationVault.set(profileId, invitation);
    return invitation;
  }

  async getInvitationSecret(input: unknown): Promise<CollaborationInvitationCreateView> {
    const { invitationId } = collaborationInvitationIdInputSchema.parse(input);
    const profileId = this.dependencies.getClientProfileId();
    if (!profileId) throw new Error("No active collaboration profile.");
    const invitation = await this.dependencies.invitationVault.get(profileId, invitationId);
    if (!invitation) {
      throw new Error(
        "Complete invitation is unavailable. Create a new invitation to store it securely."
      );
    }
    return invitation;
  }

  async revokeInvitation(input: unknown): Promise<HumanInvitationView> {
    const { invitationId } = collaborationInvitationIdInputSchema.parse(input);
    const profileId = this.dependencies.getClientProfileId();
    const revoked = await this.dependencies.withActiveClient((client) =>
      client.revokeInvitation(invitationId)
    );
    if (profileId) await this.dependencies.invitationVault.delete(profileId, invitationId);
    return revoked;
  }

  async revokeInvitations(input: unknown) {
    const parsed = collaborationInvitationIdsInputSchema.parse(input);
    const profileId = this.dependencies.getClientProfileId();
    const revoked = await this.dependencies.withActiveClient((client) =>
      client.revokeInvitations(parsed)
    );
    if (profileId) {
      await Promise.all(
        parsed.invitationIds.map((id) => this.dependencies.invitationVault.delete(profileId, id))
      );
    }
    return revoked;
  }

  async removeMember(input: unknown): Promise<void> {
    const { humanPrincipalId } = collaborationHumanPrincipalIdInputSchema.parse(input);
    return this.dependencies.withActiveClient((client) => client.removeMember(humanPrincipalId));
  }

  async promoteOwner(input: unknown): Promise<void> {
    const { humanPrincipalId } = collaborationHumanPrincipalIdInputSchema.parse(input);
    return this.dependencies.withActiveClient((client) => client.promoteOwner(humanPrincipalId));
  }

  async demoteOwner(input: unknown): Promise<void> {
    const { humanPrincipalId } = collaborationHumanPrincipalIdInputSchema.parse(input);
    return this.dependencies.withActiveClient((client) => client.demoteOwner(humanPrincipalId));
  }

  async revokeDevice(input: unknown): Promise<void> {
    const { deviceCredentialId } = collaborationDeviceCredentialIdInputSchema.parse(input);
    return this.dependencies.withActiveClient((client) => client.revokeDevice(deviceCredentialId));
  }
}

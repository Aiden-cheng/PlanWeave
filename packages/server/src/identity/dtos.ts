import {
  humanDeviceViewSchema,
  humanInvitationViewSchema,
  humanMembershipViewSchema,
  humanPrincipalViewSchema,
  type HumanDeviceView,
  type HumanInvitationView,
  type HumanMembershipView,
  type HumanPrincipalView
} from "@planweave-ai/collaboration-protocol/identity/workspace";
import type {
  HumanDeviceCredentialMetadata,
  HumanPrincipal,
  ProjectInvitationMetadata,
  ProjectMembership
} from "./schemas.js";

export {
  assertHumanDisplayDtoRedacted,
  humanBootstrapRequestSchema,
  humanBootstrapResponseSchema,
  humanConsumeInvitationRequestSchema,
  humanConsumeInvitationResponseSchema,
  humanCreateInvitationRequestSchema,
  humanCreateInvitationResponseSchema,
  humanDeviceListQuerySchema,
  humanDevicePageSchema,
  humanDeviceTokenHandoffSchema,
  humanDeviceViewSchema,
  humanInvitationListQuerySchema,
  humanInvitationPageSchema,
  humanInvitationViewSchema,
  humanMemberPageSchema,
  humanMembershipViewSchema,
  humanPageQuerySchema,
  humanPrincipalViewSchema,
  humanRevokeInvitationsRequestSchema,
  humanRevokeInvitationsResponseSchema,
  workspaceIdentityReadModelSchema
} from "@planweave-ai/collaboration-protocol/identity/workspace";
export type {
  HumanBootstrapRequest,
  HumanBootstrapResponse,
  HumanConsumeInvitationRequest,
  HumanConsumeInvitationResponse,
  HumanCreateInvitationRequest,
  HumanCreateInvitationResponse,
  HumanDeviceListQuery,
  HumanDevicePage,
  HumanDeviceTokenHandoff,
  HumanDeviceView,
  HumanInvitationListQuery,
  HumanInvitationPage,
  HumanInvitationView,
  HumanMemberPage,
  HumanMembershipView,
  HumanPageQuery,
  HumanPrincipalView,
  HumanRevokeInvitationsRequest,
  HumanRevokeInvitationsResponse,
  WorkspaceIdentityReadModel
} from "@planweave-ai/collaboration-protocol/identity/workspace";

export function toPrincipalView(principal: HumanPrincipal): HumanPrincipalView {
  return humanPrincipalViewSchema.parse({
    humanPrincipalId: principal.humanPrincipalId,
    displayName: principal.displayName,
    createdAt: principal.createdAt
  });
}

export function toMembershipView(
  membership: ProjectMembership,
  displayName: string
): HumanMembershipView {
  return humanMembershipViewSchema.parse({
    membershipId: membership.membershipId,
    projectId: membership.projectId,
    humanPrincipalId: membership.humanPrincipalId,
    displayName,
    role: membership.role,
    createdAt: membership.createdAt,
    updatedAt: membership.updatedAt
  });
}

export function toDeviceView(device: HumanDeviceCredentialMetadata): HumanDeviceView {
  return humanDeviceViewSchema.parse({
    deviceCredentialId: device.deviceCredentialId,
    humanPrincipalId: device.humanPrincipalId,
    mintedForProjectId: device.mintedForProjectId,
    label: device.label,
    createdAt: device.createdAt,
    expiresAt: device.expiresAt,
    revokedAt: device.revokedAt,
    lastUsedAt: device.lastUsedAt
  });
}

export function toInvitationView(invitation: ProjectInvitationMetadata): HumanInvitationView {
  return humanInvitationViewSchema.parse({
    invitationId: invitation.invitationId,
    projectId: invitation.projectId,
    role: invitation.role,
    createdByHumanPrincipalId: invitation.createdByHumanPrincipalId,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    revokedAt: invitation.revokedAt,
    consumedAt: invitation.consumedAt
  });
}

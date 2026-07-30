import type { LoopbackProjectRegistrationView } from "@planweave-ai/collaboration-contracts";

type LocalCollaborationProfile = {
  profileId: string;
  displayName: string;
  serverBaseUrl: string;
  projectId: string;
  allowInsecureTransport: boolean;
};

type LocalCollaborationCoordinatorPort = {
  localProfile(): LocalCollaborationProfile | null;
  registerCurrentProject(actor: { kind: "human"; id: string }): LoopbackProjectRegistrationView;
};

type LocalCollaborationServicePort = {
  upsertProfile(input: unknown): Promise<unknown>;
  migrateLocalProfileCredential(sourceProfileId: string, targetProfileId: string): Promise<void>;
  setActiveProfile(input: unknown): Promise<unknown>;
  activeHumanPrincipalId(profileId: string): Promise<string | null>;
  bootstrapOwner(input: unknown): Promise<{ principal: { humanPrincipalId: string } }>;
  connectSession(input: unknown): Promise<unknown>;
};

/** Restores the selected local canvas as a complete owner session after every server start. */
export async function activateLocalCollaborationSelection({
  coordinator,
  service,
  ownerDisplayName
}: {
  coordinator: LocalCollaborationCoordinatorPort;
  service: LocalCollaborationServicePort;
  ownerDisplayName: string;
}): Promise<LoopbackProjectRegistrationView> {
  const profile = coordinator.localProfile();
  if (!profile) throw new Error("local_collaboration_selection_required");

  await service.upsertProfile(profile);
  await service.migrateLocalProfileCredential("planweave-local-loopback", profile.profileId);
  await service.setActiveProfile({ profileId: profile.profileId });

  let humanPrincipalId = await service.activeHumanPrincipalId(profile.profileId);
  if (!humanPrincipalId) {
    const handoff = await service.bootstrapOwner({
      profileId: profile.profileId,
      request: { displayName: ownerDisplayName }
    });
    humanPrincipalId = handoff.principal.humanPrincipalId;
  }

  const registration = coordinator.registerCurrentProject({ kind: "human", id: humanPrincipalId });
  await service.connectSession({ profileId: profile.profileId });
  return registration;
}

import type { CollaborationSessionPhase } from "../../shared/collaboration.js";

type PersistedCollaborationSessionService = {
  getStatus(): Promise<{
    activeProfileId: string | null;
    profiles: Array<{ profileId: string; hasDeviceCredential: boolean }>;
    session: { phase: CollaborationSessionPhase };
  }>;
  connectSession(input: { profileId: string }): Promise<unknown>;
};

/** Restores the active persisted profile once during Desktop startup. */
export async function restorePersistedCollaborationSession(
  service: PersistedCollaborationSessionService
): Promise<boolean> {
  const status = await service.getStatus();
  if (status.session.phase === "connecting" || status.session.phase === "connected") {
    return false;
  }
  if (!status.activeProfileId) return false;

  const activeProfile = status.profiles.find(
    (profile) => profile.profileId === status.activeProfileId
  );
  if (!activeProfile?.hasDeviceCredential) return false;

  await service.connectSession({ profileId: activeProfile.profileId });
  return true;
}

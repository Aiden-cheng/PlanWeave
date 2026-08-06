import type { CollaborationConnectionProfile } from "@planweave-ai/collaboration-protocol/connection";
import type { LoopbackProjectRegistrationView } from "@planweave-ai/collaboration-protocol/loopback";
import type { LocalCollaborationRegistrationInput } from "../../shared/localCollaborationScopes.js";

type LocalCollaborationProfile = CollaborationConnectionProfile;

type LocalCollaborationCoordinatorPort = {
  currentSelection(): NonNullable<LocalCollaborationRegistrationInput["selection"]> | null;
  status(): { state: string };
  start(): Promise<{ state: string }>;
  currentSelectionIsTrusted(): boolean;
  recognizesLocalProfile(profileId: string): boolean;
  setCurrentSelection(
    input: NonNullable<LocalCollaborationRegistrationInput["selection"]>
  ): Promise<void>;
  clearCurrentSelection(): Promise<void>;
  localProfile(): LocalCollaborationProfile | null;
  localProfileForId(profileId: string): LocalCollaborationProfile | null;
  registerCurrentProject(actor: { kind: "human"; id: string }): LoopbackProjectRegistrationView;
  registerLocalProfile(
    profileId: string,
    actor: { kind: "human"; id: string }
  ): LoopbackProjectRegistrationView;
};

type LocalCollaborationSelectionServicePort = {
  upsertProfile(input: CollaborationConnectionProfile): Promise<unknown>;
  migrateLocalProfileCredential(sourceProfileId: string, targetProfileId: string): Promise<void>;
  adoptWorkspaceAuthority(input: {
    profileId: string;
    workspaceId: string;
    membershipRole: "owner" | "member";
  }): Promise<void>;
  setActiveProfile(input: unknown): Promise<unknown>;
  activeHumanPrincipalId(profileId: string): Promise<string | null>;
  bootstrapOwner(input: unknown): Promise<{
    workspaceId: string;
    principal: { humanPrincipalId: string };
  }>;
  connectSession(input: unknown): Promise<unknown>;
  clearActiveProfile(): Promise<unknown>;
};

type LocalCollaborationServicePort = LocalCollaborationSelectionServicePort & {
  getStatus(): Promise<{
    activeProfileId: string | null;
    profiles: Array<{ profileId: string; hasDeviceCredential: boolean }>;
    session: { phase: string };
  }>;
  runStatusPublicationTransaction<T>(operation: () => Promise<T>): Promise<T>;
};

type LocalCollaborationActivationCoordinatorPort = Pick<
  LocalCollaborationCoordinatorPort,
  "localProfile" | "registerCurrentProject"
>;

export type LocalCollaborationActivationCommand = {
  activate(input: LocalCollaborationRegistrationInput): Promise<LoopbackProjectRegistrationView>;
  selectAndReconcile(
    selection: NonNullable<LocalCollaborationRegistrationInput["selection"]>
  ): Promise<LoopbackProjectRegistrationView | null>;
  reconcile(): Promise<LoopbackProjectRegistrationView | null>;
};

/** Restores the selected local canvas as a complete owner session after every server start. */
export async function activateLocalCollaborationSelection({
  coordinator,
  service,
  ownerDisplayName
}: {
  coordinator: LocalCollaborationActivationCoordinatorPort;
  service: LocalCollaborationSelectionServicePort;
  ownerDisplayName: string;
}): Promise<LoopbackProjectRegistrationView> {
  const profile = coordinator.localProfile();
  if (!profile) throw new Error("local_collaboration_selection_required");

  return activateLocalCollaborationProfile({
    profile,
    service,
    registerProject: (actor) => coordinator.registerCurrentProject(actor),
    ownerDisplayName
  });
}

async function activateLocalCollaborationProfile({
  profile,
  service,
  registerProject,
  ownerDisplayName
}: {
  profile: LocalCollaborationProfile;
  service: LocalCollaborationSelectionServicePort;
  registerProject: (actor: { kind: "human"; id: string }) => LoopbackProjectRegistrationView;
  ownerDisplayName: string;
}): Promise<LoopbackProjectRegistrationView> {
  await service.upsertProfile(profile);
  await service.migrateLocalProfileCredential("planweave-local-loopback", profile.profileId);
  await service.setActiveProfile({ profileId: profile.profileId });

  let humanPrincipalId = await service.activeHumanPrincipalId(profile.profileId);
  let authenticatedWorkspaceId: string | null = null;
  if (!humanPrincipalId) {
    const handoff = await service.bootstrapOwner({
      profileId: profile.profileId,
      request: { displayName: ownerDisplayName }
    });
    humanPrincipalId = handoff.principal.humanPrincipalId;
    authenticatedWorkspaceId = handoff.workspaceId;
  }

  const registration = registerProject({ kind: "human", id: humanPrincipalId });
  if (authenticatedWorkspaceId && authenticatedWorkspaceId !== registration.workspaceId) {
    throw new Error("local_collaboration_workspace_mismatch");
  }
  await service.adoptWorkspaceAuthority({
    profileId: profile.profileId,
    workspaceId: registration.workspaceId,
    membershipRole: "owner"
  });
  await service.connectSession({ profileId: profile.profileId });
  return registration;
}

function shouldRestoreConnectedSession(phase: string): boolean {
  return phase === "connecting" || phase === "connected";
}

/** Serial application command for selecting and activating one local collaboration canvas. */
export function createLocalCollaborationActivationCommand({
  coordinator,
  service,
  coordinatorReady = Promise.resolve()
}: {
  coordinator: LocalCollaborationCoordinatorPort;
  service: LocalCollaborationServicePort;
  coordinatorReady?: Promise<unknown>;
}): LocalCollaborationActivationCommand {
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => undefined).then(operation);
    queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  const execute = (
    registrationInput: LocalCollaborationRegistrationInput,
    options: { activationRequired: boolean }
  ): Promise<LoopbackProjectRegistrationView | null> =>
    enqueue(async () => {
      await coordinatorReady;
      return service.runStatusPublicationTransaction(async () => {
        const previousStatus = await service.getStatus();
        const previousSelection = coordinator.currentSelection();
        const selectionChanged = registrationInput.selection !== undefined;
        let transitionStarted = !selectionChanged;
        try {
          if (registrationInput.selection) {
            await coordinator.setCurrentSelection(registrationInput.selection);
            transitionStarted = true;
          }
          if (
            previousStatus.activeProfileId &&
            coordinator.recognizesLocalProfile(previousStatus.activeProfileId) &&
            coordinator.status().state !== "running"
          ) {
            try {
              const restored = await coordinator.start();
              if (restored.state !== "running") {
                if (!options.activationRequired) return null;
                throw new Error("local_collaboration_server_restore_failed");
              }
            } catch (error) {
              if (!options.activationRequired) return null;
              throw error;
            }
          }
          if (options.activationRequired) {
            return await activateLocalCollaborationSelection({
              coordinator,
              service,
              ownerDisplayName: registrationInput.ownerDisplayName ?? "Local owner"
            });
          }

          const activeProfile = previousStatus.activeProfileId
            ? coordinator.localProfileForId(previousStatus.activeProfileId)
            : null;
          const recoverableProfiles = previousStatus.activeProfileId
            ? []
            : previousStatus.profiles
                .filter((profile) => profile.hasDeviceCredential)
                .map((profile) => coordinator.localProfileForId(profile.profileId))
                .filter((profile): profile is LocalCollaborationProfile => profile !== null);
          const profileToRestore =
            activeProfile ??
            (recoverableProfiles.length === 1
              ? recoverableProfiles[0]!
              : previousStatus.profiles.some((profile) => profile.hasDeviceCredential)
                ? null
                : coordinator.currentSelectionIsTrusted()
                  ? coordinator.localProfile()
                  : null);
          if (!profileToRestore) return null;

          return await activateLocalCollaborationProfile({
            profile: profileToRestore,
            service,
            registerProject: (actor) =>
              coordinator.registerLocalProfile(profileToRestore.profileId, actor),
            ownerDisplayName: registrationInput.ownerDisplayName ?? "Local owner"
          });
        } catch (error) {
          if (!transitionStarted) throw error;
          if (selectionChanged) {
            if (previousSelection) {
              await coordinator.setCurrentSelection(previousSelection);
            } else {
              await coordinator.clearCurrentSelection();
            }
          }
          if (previousStatus.activeProfileId) {
            await service.setActiveProfile({ profileId: previousStatus.activeProfileId });
            if (shouldRestoreConnectedSession(previousStatus.session.phase)) {
              await service.connectSession({ profileId: previousStatus.activeProfileId });
            }
          } else {
            await service.clearActiveProfile();
          }
          throw error;
        }
      });
    });

  return {
    activate: (registrationInput) =>
      execute(registrationInput, { activationRequired: true }).then((registration) => {
        if (!registration) throw new Error("local_collaboration_activation_required");
        return registration;
      }),
    selectAndReconcile: (selection) => execute({ selection }, { activationRequired: false }),
    reconcile: () => execute({}, { activationRequired: false })
  };
}

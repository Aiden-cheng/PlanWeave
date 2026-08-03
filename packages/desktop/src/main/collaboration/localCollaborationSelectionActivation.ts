import type { LoopbackProjectRegistrationView } from "@planweave-ai/collaboration-protocol";
import type { LocalCollaborationRegistrationInput } from "../../shared/localCollaborationScopes.js";

type LocalCollaborationProfile = {
  profileId: string;
  displayName: string;
  serverBaseUrl: string;
  projectId: string;
  allowInsecureTransport: boolean;
};

type LocalCollaborationCoordinatorPort = {
  currentSelection(): NonNullable<LocalCollaborationRegistrationInput["selection"]> | null;
  status(): { state: string };
  currentSelectionIsTrusted(): boolean;
  ownsLocalProfile(profileId: string): boolean;
  setCurrentSelection(
    input: NonNullable<LocalCollaborationRegistrationInput["selection"]>
  ): Promise<void>;
  clearCurrentSelection(): Promise<void>;
  localProfile(): LocalCollaborationProfile | null;
  registerCurrentProject(actor: { kind: "human"; id: string }): LoopbackProjectRegistrationView;
};

type LocalCollaborationSelectionServicePort = {
  upsertProfile(input: unknown): Promise<unknown>;
  migrateLocalProfileCredential(sourceProfileId: string, targetProfileId: string): Promise<void>;
  setActiveProfile(input: unknown): Promise<unknown>;
  activeHumanPrincipalId(profileId: string): Promise<string | null>;
  bootstrapOwner(input: unknown): Promise<{ principal: { humanPrincipalId: string } }>;
  connectSession(input: unknown): Promise<unknown>;
  clearActiveProfile(): Promise<unknown>;
};

type LocalCollaborationServicePort = LocalCollaborationSelectionServicePort & {
  getStatus(): Promise<{
    activeProfileId: string | null;
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
  reconcile(previousLocalProfileId?: string): Promise<LoopbackProjectRegistrationView | null>;
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

function shouldRestoreConnectedSession(phase: string): boolean {
  return phase === "connecting" || phase === "connected";
}

/** Serial application command for selecting and activating one local collaboration canvas. */
export function createLocalCollaborationActivationCommand({
  coordinator,
  service
}: {
  coordinator: LocalCollaborationCoordinatorPort;
  service: LocalCollaborationServicePort;
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
    options: { activationRequired: boolean; previousLocalProfileId?: string }
  ): Promise<LoopbackProjectRegistrationView | null> =>
    enqueue(() =>
      service.runStatusPublicationTransaction(async () => {
        const previousStatus = await service.getStatus();
        const previousSelection = coordinator.currentSelection();
        const previousLocalProfileId =
          options.previousLocalProfileId ?? coordinator.localProfile()?.profileId;
        const selectionChanged = registrationInput.selection !== undefined;
        let transitionStarted = !selectionChanged;
        try {
          if (registrationInput.selection) {
            await coordinator.setCurrentSelection(registrationInput.selection);
            transitionStarted = true;
          }
          const shouldActivate =
            options.activationRequired ||
            (coordinator.status().state === "running" && coordinator.currentSelectionIsTrusted());
          if (!shouldActivate) {
            const activeProfileId = previousStatus.activeProfileId;
            if (
              activeProfileId &&
              (activeProfileId === previousLocalProfileId ||
                coordinator.ownsLocalProfile(activeProfileId))
            ) {
              await service.clearActiveProfile();
            }
            return null;
          }
          return await activateLocalCollaborationSelection({
            coordinator,
            service,
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
      })
    );

  return {
    activate: (registrationInput) =>
      execute(registrationInput, { activationRequired: true }).then((registration) => {
        if (!registration) throw new Error("local_collaboration_activation_required");
        return registration;
      }),
    selectAndReconcile: (selection) => execute({ selection }, { activationRequired: false }),
    reconcile: (previousLocalProfileId) =>
      execute({}, { activationRequired: false, previousLocalProfileId })
  };
}

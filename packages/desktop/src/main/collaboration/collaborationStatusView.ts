import type { CollaborationConnectionProfile } from "@planweave-ai/collaboration-contracts";
import {
  COLLABORATION_SESSION_ONLY_WARNING,
  type CollaborationProfileView,
  type CollaborationSessionPhase,
  type CollaborationStatus
} from "../../shared/collaboration.js";
import type { CollaborationClient } from "./CollaborationClient.js";
import type { CollaborationObserverStatus } from "./CollaborationClient.js";
import type { CollaborationCredentialVault } from "./collaborationCredentialVault.js";
import type { CollaborationProfileStore } from "./collaborationProfileStore.js";
import type { CollaborationWorkspaceConnection } from "./collaborationWorkspaceConnection.js";

export type CollaborationStatusSession = {
  phase: CollaborationSessionPhase;
  detail: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  clientProfileId: string | null;
  observerStatus: CollaborationObserverStatus;
  client: CollaborationClient | null;
};

export type BuildCollaborationStatusOptions = {
  profiles: CollaborationProfileStore;
  vault: CollaborationCredentialVault;
  workspaceConnection: CollaborationWorkspaceConnection;
  session: CollaborationStatusSession;
  clock?: { now(): Date };
};

function toPublicProfile(
  profile: CollaborationConnectionProfile & { updatedAt: string },
  credential: {
    hasDeviceCredential: boolean;
    deviceCredentialPersistence: CollaborationProfileView["deviceCredentialPersistence"];
    deviceCredentialId: string | null;
    humanPrincipalId: string | null;
  }
): CollaborationProfileView {
  return {
    profileId: profile.profileId,
    displayName: profile.displayName,
    serverBaseUrl: profile.serverBaseUrl,
    projectId: profile.projectId,
    allowInsecureTransport: profile.allowInsecureTransport,
    hasDeviceCredential: credential.hasDeviceCredential,
    deviceCredentialPersistence: credential.deviceCredentialPersistence,
    deviceCredentialId: credential.deviceCredentialId,
    humanPrincipalId: credential.humanPrincipalId,
    updatedAt: profile.updatedAt
  };
}

/** Builds the redacted renderer status from credential/profile read models. */
export async function buildCollaborationStatus(
  options: BuildCollaborationStatusOptions
): Promise<CollaborationStatus> {
  const documentProfiles = await options.profiles.list();
  const activeProfileId = await options.profiles.getActiveProfileId();
  const profiles: CollaborationProfileView[] = [];
  for (const profile of documentProfiles) {
    const persistence = await options.vault.persistenceFor(profile.profileId);
    const metadata = await options.vault.getMetadata(profile.profileId);
    profiles.push(
      toPublicProfile(profile, {
        hasDeviceCredential: persistence !== "missing",
        deviceCredentialPersistence: persistence,
        deviceCredentialId: metadata?.deviceCredentialId ?? null,
        humanPrincipalId: metadata?.humanPrincipalId ?? null
      })
    );
  }

  const hasSessionOnly = await options.vault.hasAnySessionOnlyCredential();
  const nonPersistenceWarning =
    options.vault.storageAvailability() === "unavailable"
      ? profiles.some((profile) => profile.hasDeviceCredential) || hasSessionOnly
        ? COLLABORATION_SESSION_ONLY_WARNING
        : null
      : profiles.some((profile) => profile.deviceCredentialPersistence === "session-only")
        ? COLLABORATION_SESSION_ONLY_WARNING
        : null;
  const detail =
    options.session.observerStatus.state !== "stopped" && options.session.client
      ? `observer:${options.session.observerStatus.state}`
      : options.session.detail;

  return {
    profiles,
    activeProfileId,
    credentialStorage: options.vault.storageAvailability(),
    nonPersistenceWarning,
    session: {
      phase: options.session.phase,
      activeProfileId: options.session.clientProfileId ?? activeProfileId,
      detail,
      lastErrorCode: options.session.lastErrorCode,
      lastErrorMessage: options.session.lastErrorMessage
    },
    workspaceConnection: await options.workspaceConnection.buildView(),
    workspacePicker: await options.workspaceConnection.buildPickerPage(),
    updatedAt: (options.clock?.now() ?? new Date()).toISOString()
  };
}

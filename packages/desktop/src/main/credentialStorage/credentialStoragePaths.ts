import { join } from "node:path";
import type { CredentialStorageMode } from "../../shared/credentialStorageSettings.js";
import { desktopHomePaths } from "../planweaveHomePaths.js";

export type CredentialStoragePaths = {
  preferenceFile: string;
  applicationKeyFile: string;
  collaborationCredentialsFile: string;
  collaborationInvitationsFile: string;
  coordinatorCredentialsFile: string;
  operatorCredentialsFile: string;
};

export function credentialStoragePaths(mode: CredentialStorageMode): CredentialStoragePaths {
  const home = desktopHomePaths();
  const application = mode === "application";
  return {
    preferenceFile: join(home.collaborationDir, "credential-storage.json"),
    applicationKeyFile: join(home.collaborationDir, "application-credential.key"),
    collaborationCredentialsFile: application
      ? join(home.collaborationDir, "credentials.application.json")
      : home.collaborationCredentialsFile,
    collaborationInvitationsFile: application
      ? join(home.collaborationDir, "invitations.application.json")
      : home.collaborationInvitationsFile,
    coordinatorCredentialsFile: application
      ? join(home.operatorControlDir, "coordinator-credentials.application.json")
      : join(home.operatorControlDir, "coordinator-credentials.json"),
    operatorCredentialsFile: application
      ? join(home.operatorControlDir, "credentials.application.json")
      : home.operatorCredentialsFile
  };
}

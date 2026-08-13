import { z } from "zod";

export const credentialStorageModeSchema = z.enum(["application", "system"]);
export type CredentialStorageMode = z.infer<typeof credentialStorageModeSchema>;

export const credentialStoragePreferenceSchema = z
  .object({
    version: z.literal(1),
    mode: credentialStorageModeSchema
  })
  .strict();
export type CredentialStoragePreference = z.infer<typeof credentialStoragePreferenceSchema>;

export const credentialStorageConfigureInputSchema = z
  .object({ mode: credentialStorageModeSchema })
  .strict();
export type CredentialStorageConfigureInput = z.infer<
  typeof credentialStorageConfigureInputSchema
>;

export type CredentialStorageSettingsStatus = {
  activeMode: CredentialStorageMode;
  configuredMode: CredentialStorageMode;
  restartRequired: boolean;
};

export const credentialStorageSettingsInvokeChannels = {
  getStatus: "planweave-credential-storage:getStatus",
  configure: "planweave-credential-storage:configure"
} as const;

export type PlanWeaveCredentialStorageSettingsApi = {
  getCredentialStorageSettings: () => Promise<CredentialStorageSettingsStatus>;
  configureCredentialStorage: (
    input: CredentialStorageConfigureInput
  ) => Promise<CredentialStorageSettingsStatus>;
};

export type SafeStorageDecryptor = {
  decryptString(encrypted: Buffer): string;
};

export class SafeStorageAccessError extends Error {
  readonly code = "SAFE_STORAGE_ACCESS_FAILED";

  constructor(secretLabel: string, cause: unknown) {
    super(`Configured credential storage could not decrypt the ${secretLabel}.`, { cause });
    this.name = "SafeStorageAccessError";
  }
}

export function decryptSafeStorageString(
  safeStorage: SafeStorageDecryptor,
  encrypted: Buffer,
  secretLabel: string
): string {
  try {
    return safeStorage.decryptString(encrypted);
  } catch (error) {
    throw new SafeStorageAccessError(secretLabel, error);
  }
}

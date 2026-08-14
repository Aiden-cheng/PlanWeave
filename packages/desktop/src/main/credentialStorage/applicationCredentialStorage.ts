import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, type CipherGCMTypes } from "node:crypto";
import type { CredentialStorageMode } from "../../shared/credentialStorageSettings.js";

export type DesktopCredentialStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

const ALGORITHM: CipherGCMTypes = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = Buffer.from("PWCRED1", "ascii");

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

export function createApplicationCredentialStorage(options: {
  keyPath: string;
}): DesktopCredentialStorage {
  let cachedKey: Buffer | null = null;

  const loadKey = (): Buffer => {
    if (cachedKey) return cachedKey;
    try {
      const existing = readFileSync(options.keyPath);
      if (existing.byteLength !== KEY_BYTES) throw new Error("credential_key_invalid");
      chmodSync(options.keyPath, 0o600);
      cachedKey = existing;
      return existing;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }

    const parent = dirname(options.keyPath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    const generated = randomBytes(KEY_BYTES);
    try {
      writeFileSync(options.keyPath, generated, { flag: "wx", mode: 0o600 });
      cachedKey = generated;
      return generated;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const existing = readFileSync(options.keyPath);
      if (existing.byteLength !== KEY_BYTES) throw new Error("credential_key_invalid");
      chmodSync(options.keyPath, 0o600);
      cachedKey = existing;
      return existing;
    }
  };

  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, loadKey(), nonce);
      const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
      return Buffer.concat([PREFIX, nonce, cipher.getAuthTag(), ciphertext]);
    },
    decryptString: (encrypted) => {
      const minimumLength = PREFIX.byteLength + NONCE_BYTES + TAG_BYTES;
      if (
        encrypted.byteLength < minimumLength ||
        !encrypted.subarray(0, PREFIX.byteLength).equals(PREFIX)
      ) {
        throw new Error("credential_ciphertext_format_invalid");
      }
      const nonceStart = PREFIX.byteLength;
      const tagStart = nonceStart + NONCE_BYTES;
      const ciphertextStart = tagStart + TAG_BYTES;
      try {
        const decipher = createDecipheriv(
          ALGORITHM,
          loadKey(),
          encrypted.subarray(nonceStart, tagStart)
        );
        decipher.setAuthTag(encrypted.subarray(tagStart, ciphertextStart));
        return Buffer.concat([
          decipher.update(encrypted.subarray(ciphertextStart)),
          decipher.final()
        ]).toString("utf8");
      } catch (error) {
        throw new Error("credential_ciphertext_authentication_failed", { cause: error });
      }
    }
  };
}

export function selectDesktopCredentialStorage(options: {
  mode: CredentialStorageMode;
  applicationKeyPath: string;
  systemStorage: DesktopCredentialStorage;
}): DesktopCredentialStorage {
  return options.mode === "system"
    ? options.systemStorage
    : createApplicationCredentialStorage({ keyPath: options.applicationKeyPath });
}

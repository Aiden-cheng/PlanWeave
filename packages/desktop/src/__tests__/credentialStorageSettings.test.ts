import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createApplicationCredentialStorage,
  selectDesktopCredentialStorage
} from "../main/credentialStorage/applicationCredentialStorage.js";
import { CredentialStoragePreferenceStore } from "../main/credentialStorage/credentialStoragePreferenceStore.js";

describe("credential storage settings", () => {
  it("defaults to app-managed storage and persists an explicit system-keychain choice", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-credential-setting-"));
    const store = new CredentialStoragePreferenceStore(join(root, "preference.json"));

    await expect(store.read()).resolves.toEqual({ version: 1, mode: "application" });
    await expect(store.write({ mode: "system" })).resolves.toEqual({
      version: 1,
      mode: "system"
    });
    await expect(store.read()).resolves.toEqual({ version: 1, mode: "system" });
  });

  it("uses authenticated app-managed encryption without touching system storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-app-credential-"));
    const keyPath = join(root, "private", "credential.key");
    const systemStorage = {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn(() => {
        throw new Error("system storage must not be used");
      }),
      decryptString: vi.fn(() => {
        throw new Error("system storage must not be used");
      })
    };
    const storage = selectDesktopCredentialStorage({
      mode: "application",
      applicationKeyPath: keyPath,
      systemStorage
    });

    const encrypted = storage.encryptString("device-secret");
    expect(encrypted.toString("utf8")).not.toContain("device-secret");
    expect(storage.decryptString(encrypted)).toBe("device-secret");
    expect(systemStorage.encryptString).not.toHaveBeenCalled();
    expect(systemStorage.decryptString).not.toHaveBeenCalled();
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "private"))).mode & 0o777).toBe(0o700);
  });

  it("uses system storage only after that mode is explicitly selected", () => {
    const systemStorage = {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((value: string) => Buffer.from(`system:${value}`)),
      decryptString: vi.fn((value: Buffer) => value.toString("utf8").slice("system:".length))
    };
    const storage = selectDesktopCredentialStorage({
      mode: "system",
      applicationKeyPath: "/unused/application.key",
      systemStorage
    });

    const encrypted = storage.encryptString("device-secret");
    expect(storage.decryptString(encrypted)).toBe("device-secret");
    expect(systemStorage.encryptString).toHaveBeenCalledTimes(1);
    expect(systemStorage.decryptString).toHaveBeenCalledTimes(1);
  });

  it("rejects tampered ciphertext instead of returning corrupted plaintext", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-app-credential-tamper-"));
    const storage = createApplicationCredentialStorage({
      keyPath: join(root, "credential.key")
    });
    const encrypted = storage.encryptString("device-secret");
    encrypted[encrypted.length - 1] ^= 1;

    expect(() => storage.decryptString(encrypted)).toThrow(
      "credential_ciphertext_authentication_failed"
    );
  });
});

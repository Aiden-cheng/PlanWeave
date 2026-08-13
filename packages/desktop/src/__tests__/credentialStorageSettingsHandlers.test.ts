import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CredentialStoragePreferenceStore } from "../main/credentialStorage/credentialStoragePreferenceStore.js";
import { registerCredentialStorageSettingsHandlers } from "../main/credentialStorage/credentialStorageSettingsHandlers.js";
import { credentialStorageSettingsInvokeChannels } from "../shared/credentialStorageSettings.js";

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, input?: unknown) => unknown>(),
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, input?: unknown) => unknown) => {
      electronMock.handlers.set(channel, handler);
    })
  },
  safeStorage: { isEncryptionAvailable: vi.fn() }
}));

vi.mock("electron", () => ({
  ipcMain: electronMock.ipcMain,
  safeStorage: electronMock.safeStorage
}));

const roots: string[] = [];

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.ipcMain.handle.mockClear();
  electronMock.safeStorage.isEncryptionAvailable.mockClear();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("credential storage settings handlers", () => {
  it("returns the active mode and schedules a configured mode for the next restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-credential-handler-"));
    roots.push(root);
    const store = new CredentialStoragePreferenceStore(join(root, "preference.json"));
    const migrate = vi.fn(async () => ({
      counts: {
        collaborationCredentials: 1,
        invitations: 0,
        coordinatorCredentials: 1,
        operatorCredentials: 0,
        mcpRuntimeApiKey: 0
      },
      rollbackSharedFiles: vi.fn(async () => undefined)
    }));
    registerCredentialStorageSettingsHandlers({
      store,
      activeMode: "application",
      migration: { migrate }
    });

    const getStatus = electronMock.handlers.get(credentialStorageSettingsInvokeChannels.getStatus);
    const configure = electronMock.handlers.get(credentialStorageSettingsInvokeChannels.configure);
    expect(getStatus).toBeTypeOf("function");
    expect(configure).toBeTypeOf("function");
    await expect(getStatus?.({})).resolves.toEqual({
      activeMode: "application",
      configuredMode: "application",
      restartRequired: false
    });
    await expect(configure?.({}, { mode: "system" })).resolves.toEqual({
      activeMode: "application",
      configuredMode: "system",
      restartRequired: true
    });
    expect(migrate).toHaveBeenCalledOnce();
    expect(migrate).toHaveBeenCalledWith("system");
  });

  it("does not initialize system credential storage while opening the settings page", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-credential-handler-readonly-"));
    roots.push(root);
    registerCredentialStorageSettingsHandlers({
      store: new CredentialStoragePreferenceStore(join(root, "preference.json")),
      activeMode: "application",
      migration: {
        migrate: vi.fn(() => {
          throw new Error("migration must not run while reading settings");
        })
      }
    });

    const getStatus = electronMock.handlers.get(credentialStorageSettingsInvokeChannels.getStatus);
    await expect(getStatus?.({})).resolves.toMatchObject({
      activeMode: "application",
      configuredMode: "application"
    });
    expect(electronMock.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
  });

  it("rejects an unknown storage mode at the IPC boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-credential-handler-invalid-"));
    roots.push(root);
    registerCredentialStorageSettingsHandlers({
      store: new CredentialStoragePreferenceStore(join(root, "preference.json")),
      activeMode: "application",
      migration: {
        migrate: vi.fn(() => {
          throw new Error("migration must not run for invalid input");
        })
      }
    });

    const configure = electronMock.handlers.get(credentialStorageSettingsInvokeChannels.configure);
    await expect(configure?.({}, { mode: "plaintext" })).rejects.toThrow();
  });

  it("keeps the active preference when credential migration fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-credential-handler-failed-"));
    roots.push(root);
    const store = new CredentialStoragePreferenceStore(join(root, "preference.json"));
    registerCredentialStorageSettingsHandlers({
      store,
      activeMode: "application",
      migration: {
        migrate: vi.fn(async () => {
          throw new Error("credential_storage_migration_failed");
        })
      }
    });

    const configure = electronMock.handlers.get(credentialStorageSettingsInvokeChannels.configure);
    await expect(configure?.({}, { mode: "system" })).rejects.toThrow(
      "credential_storage_migration_failed"
    );
    await expect(store.read()).resolves.toEqual({ version: 1, mode: "application" });
  });
});

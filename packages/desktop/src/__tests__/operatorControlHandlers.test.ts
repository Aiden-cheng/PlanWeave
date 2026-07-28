import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerOperatorControlHandlers,
  shutdownOperatorControlService
} from "../main/operatorControl/operatorControlHandlers.js";
import { operatorControlInvokeChannels } from "../shared/operatorControl.js";

type IpcHandler = (event: unknown, input: unknown) => unknown;

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler))
    },
    readText: vi.fn(),
    writeText: vi.fn()
  };
});

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { readText: electronMock.readText, writeText: electronMock.writeText },
  ipcMain: electronMock.ipcMain,
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error("safeStorage_unavailable");
    },
    decryptString: () => {
      throw new Error("safeStorage_unavailable");
    }
  }
}));

const roots: string[] = [];

beforeEach(() => {
  electronMock.handlers.clear();
  electronMock.ipcMain.handle.mockClear();
  electronMock.readText.mockReset();
  electronMock.writeText.mockReset();
});

afterEach(async () => {
  await shutdownOperatorControlService();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("operator control main-process credential import", () => {
  it("reads the token in main and rejects renderer token smuggling", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-operator-handler-"));
    roots.push(root);
    const token = "operator_handler_token_abcdefghijklmnopqrstuvwxyz";
    const readOperatorToken = vi.fn(() => token);
    const service = registerOperatorControlHandlers({
      profileStorePaths: { profilesPath: join(root, "profiles.json") },
      credentialsPath: join(root, "credentials.json"),
      readOperatorToken
    });
    await service.upsertProfile({
      profileId: "profile-a",
      displayName: "Operator A",
      serverBaseUrl: "https://operator.example.test/",
      allowInsecureTransport: false
    });

    const handler = electronMock.handlers.get(operatorControlInvokeChannels.importCredential);
    if (!handler) throw new Error("operator_import_handler_missing");
    await handler({}, { profileId: "profile-a" });

    expect(readOperatorToken).toHaveBeenCalledTimes(1);
    await expect(service.getStatus()).resolves.toMatchObject({
      profiles: [{ profileId: "profile-a", hasOperatorCredential: true }]
    });

    expect(() => handler({}, { profileId: "profile-a", operatorToken: token })).toThrow(
      "Operator IPC rejected importOperatorCredential"
    );
    expect(readOperatorToken).toHaveBeenCalledTimes(1);
  });
});

describe("operator control main-owned Host handoff", () => {
  it("rejects renderer-supplied enrollment codes before any clipboard write", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-operator-handoff-handler-"));
    roots.push(root);
    const service = registerOperatorControlHandlers({
      profileStorePaths: { profilesPath: join(root, "profiles.json") },
      credentialsPath: join(root, "credentials.json")
    });
    await service.upsertProfile({
      profileId: "profile-a",
      displayName: "Operator A",
      serverBaseUrl: "https://operator.example.test/",
      allowInsecureTransport: false
    });

    const handler = electronMock.handlers.get(
      operatorControlInvokeChannels.copyHostBootstrapHandoff
    );
    if (!handler) throw new Error("operator_handoff_handler_missing");
    await expect(
      handler({}, { profileId: "profile-a", enrollmentCode: `pw_enroll_${"A".repeat(43)}` })
    ).rejects.toThrow("Operator IPC rejected copyHostBootstrapHandoff");
    expect(electronMock.writeText).not.toHaveBeenCalled();
  });
});

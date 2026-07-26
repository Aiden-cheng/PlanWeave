import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exampleBootstrapResponse,
  exampleHumanDeviceToken,
  exampleInvitationToken
} from "@planweave-ai/collaboration-contracts";
import {
  CollaborationCredentialVault,
  CollaborationProfileStore,
  CollaborationService,
  redactCollaborationText
} from "../main/collaboration/index.js";
import {
  COLLABORATION_SESSION_ONLY_WARNING,
  collaborationInvokeChannels,
  assertNoSmuggledCollaborationSecrets
} from "../shared/collaboration.js";

const tempRoots: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function mockSafeStorage(options?: { available?: boolean; corruptDecrypt?: boolean }): {
  isEncryptionAvailable: ReturnType<typeof vi.fn>;
  encryptString: ReturnType<typeof vi.fn>;
  decryptString: ReturnType<typeof vi.fn>;
} {
  const available = options?.available ?? true;
  return {
    isEncryptionAvailable: vi.fn(() => available),
    encryptString: vi.fn((value: string) => Buffer.from(value, "utf8")),
    decryptString: vi.fn((value: Buffer) => {
      if (options?.corruptDecrypt) {
        throw new Error("decryption failed");
      }
      return value.toString("utf8");
    })
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength
  });
  res.end(bytes);
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "test_handler_failed" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("collaboration credential vault + profile store", () => {
  it("persists profiles without secrets and encrypts device tokens when safeStorage is available", async () => {
    const root = await tempDir("planweave-collab-");
    const profilesPath = join(root, "profiles.json");
    const credentialsPath = join(root, "credentials.json");
    const safeStorage = mockSafeStorage({ available: true });
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath },
      safeStorage
    });
    const store = new CollaborationProfileStore({ profilesPath });

    await store.upsert({
      profileId: "profile-1",
      displayName: "Demo",
      serverBaseUrl: "https://collab.example.com/",
      projectId: "project-1",
      allowInsecureTransport: false
    });
    await vault.setDeviceToken("profile-1", exampleHumanDeviceToken, {
      deviceCredentialId: "device-1",
      humanPrincipalId: "human-1"
    });

    const profileRaw = await readFile(profilesPath, "utf8");
    expect(profileRaw).not.toContain(exampleHumanDeviceToken);
    expect(profileRaw).not.toContain("encryptedDeviceToken");
    expect(profileRaw).toContain("profile-1");

    const credentialRaw = await readFile(credentialsPath, "utf8");
    expect(credentialRaw).not.toContain(exampleHumanDeviceToken);
    expect(credentialRaw).toContain("encryptedDeviceToken");
    expect(await vault.getDeviceToken("profile-1")).toBe(exampleHumanDeviceToken);
    expect(await vault.persistenceFor("profile-1")).toBe("persisted");

    const profileStat = await stat(profilesPath);
    const credentialStat = await stat(credentialsPath);
    expect(profileStat.mode & 0o777).toBe(0o600);
    expect(credentialStat.mode & 0o777).toBe(0o600);
  });

  it("keeps the token session-only when safeStorage is unavailable and never writes plaintext", async () => {
    const root = await tempDir("planweave-collab-session-");
    const credentialsPath = join(root, "credentials.json");
    const safeStorage = mockSafeStorage({ available: false });
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath },
      safeStorage
    });

    const persistence = await vault.setDeviceToken("profile-1", exampleHumanDeviceToken);
    expect(persistence).toBe("session-only");
    expect(await vault.getDeviceToken("profile-1")).toBe(exampleHumanDeviceToken);
    expect(await vault.hasAnySessionOnlyCredential()).toBe(true);

    await expect(readFile(credentialsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats corrupt or rotated ciphertext as missing and purges the durable entry", async () => {
    const root = await tempDir("planweave-collab-corrupt-");
    const credentialsPath = join(root, "credentials.json");
    const goodStorage = mockSafeStorage({ available: true });
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath },
      safeStorage: goodStorage
    });
    await vault.setDeviceToken("profile-1", exampleHumanDeviceToken);

    const rotated = new CollaborationCredentialVault({
      paths: { credentialsPath },
      safeStorage: mockSafeStorage({ available: true, corruptDecrypt: true })
    });
    expect(await rotated.getDeviceToken("profile-1")).toBeUndefined();
    expect(await rotated.persistenceFor("profile-1")).toBe("missing");

    const remaining = JSON.parse(await readFile(credentialsPath, "utf8")) as {
      credentials: Record<string, unknown>;
    };
    expect(remaining.credentials["profile-1"]).toBeUndefined();
  });

  it("clears revoked credentials from memory and disk", async () => {
    const root = await tempDir("planweave-collab-revoke-");
    const credentialsPath = join(root, "credentials.json");
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath },
      safeStorage: mockSafeStorage({ available: true })
    });
    await vault.setDeviceToken("profile-1", exampleHumanDeviceToken);
    await vault.clear("profile-1");
    expect(await vault.getDeviceToken("profile-1")).toBeUndefined();
    const remaining = JSON.parse(await readFile(credentialsPath, "utf8")) as {
      credentials: Record<string, unknown>;
    };
    expect(remaining.credentials["profile-1"]).toBeUndefined();
  });
});

describe("CollaborationService IPC trust boundary", () => {
  async function serviceWithRoot(root: string, available = true) {
    const safeStorage = mockSafeStorage({ available });
    return new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage
      }),
      safeStorage
    });
  }

  it("rejects smuggled secrets and non-profile URL shortcuts on upsert", async () => {
    const root = await tempDir("planweave-collab-smuggle-");
    const service = await serviceWithRoot(root);

    await expect(
      service.upsertProfile({
        profileId: "profile-1",
        displayName: "Demo",
        serverBaseUrl: "https://collab.example.com/",
        projectId: "project-1",
        allowInsecureTransport: false,
        deviceToken: exampleHumanDeviceToken
      })
    ).rejects.toThrow(/deviceToken/);

    await expect(
      service.upsertProfile({
        profileId: "profile-1",
        displayName: "Demo",
        serverBaseUrl: "https://collab.example.com/",
        projectId: "project-1",
        allowInsecureTransport: false,
        credentialPath: "/tmp/secret"
      })
    ).rejects.toThrow(/credentialPath/);

    await expect(
      service.importDeviceCredential({
        profileId: "missing",
        deviceToken: exampleHumanDeviceToken,
        encryptedDeviceToken: "abc"
      })
    ).rejects.toThrow(/encryptedDeviceToken/);

    expect(() =>
      assertNoSmuggledCollaborationSecrets({ authorization: "Bearer x" }, "test")
    ).toThrow(/authorization/);
  });

  it("rejects malformed profile payloads and invalid tokens", async () => {
    const root = await tempDir("planweave-collab-malformed-");
    const service = await serviceWithRoot(root);

    await expect(
      service.upsertProfile({
        profileId: "profile-1",
        displayName: "Demo",
        serverBaseUrl: "https://collab.example.com/not-origin",
        projectId: "project-1",
        allowInsecureTransport: false
      })
    ).rejects.toThrow();

    await service.upsertProfile({
      profileId: "profile-1",
      displayName: "Demo",
      serverBaseUrl: "https://collab.example.com/",
      projectId: "project-1",
      allowInsecureTransport: false
    });

    await expect(
      service.importDeviceCredential({
        profileId: "profile-1",
        deviceToken: "not-a-token"
      })
    ).rejects.toThrow();
  });

  it("surfaces session-only warning and never returns tokens from status", async () => {
    const root = await tempDir("planweave-collab-status-");
    const service = await serviceWithRoot(root, false);
    await service.upsertProfile({
      profileId: "profile-1",
      displayName: "Demo",
      serverBaseUrl: "https://collab.example.com/",
      projectId: "project-1",
      allowInsecureTransport: false
    });
    await service.importDeviceCredential({
      profileId: "profile-1",
      deviceToken: exampleHumanDeviceToken,
      deviceCredentialId: "device-1",
      humanPrincipalId: "human-1"
    });

    const status = await service.getStatus();
    expect(status.credentialStorage).toBe("unavailable");
    expect(status.nonPersistenceWarning).toBe(COLLABORATION_SESSION_ONLY_WARNING);
    expect(status.profiles[0]?.deviceCredentialPersistence).toBe("session-only");
    expect(status.profiles[0]?.hasDeviceCredential).toBe(true);
    expect(JSON.stringify(status)).not.toContain(exampleHumanDeviceToken);
    expect(JSON.stringify(status)).not.toContain("encryptedDeviceToken");
    expect(JSON.stringify(status)).not.toContain(join(root, "credentials.json"));
  });

  it("bootstraps owner through main, stores token, and strips deviceToken from handoff", async () => {
    const fixture = await listen(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toContain("/human/bootstrap");
      expect(req.headers.authorization).toBeUndefined();
      await readBody(req);
      json(res, 200, exampleBootstrapResponse);
    });
    try {
      const root = await tempDir("planweave-collab-bootstrap-");
      const service = await serviceWithRoot(root, true);
      await service.upsertProfile({
        profileId: "profile-1",
        displayName: "Demo",
        serverBaseUrl: fixture.origin,
        projectId: "project-demo-001",
        allowInsecureTransport: true
      });

      const handoff = await service.bootstrapOwner({
        profileId: "profile-1",
        request: { displayName: "Owner" }
      });

      expect(handoff.deviceCredentialPersistence).toBe("persisted");
      expect(handoff.principal.displayName).toBe("Owner");
      expect(JSON.stringify(handoff)).not.toContain(exampleHumanDeviceToken);
      expect((handoff as { deviceToken?: string }).deviceToken).toBeUndefined();

      const status = await service.getStatus();
      expect(status.profiles[0]?.hasDeviceCredential).toBe(true);
      expect(status.activeProfileId).toBe("profile-1");
    } finally {
      await fixture.close();
    }
  });

  it("rejects existingDeviceToken from renderer on consumeInvitation", async () => {
    const root = await tempDir("planweave-collab-consume-reject-");
    const service = await serviceWithRoot(root);
    await service.upsertProfile({
      profileId: "profile-1",
      displayName: "Demo",
      serverBaseUrl: "https://collab.example.com/",
      projectId: "project-1",
      allowInsecureTransport: false
    });

    await expect(
      service.consumeInvitation({
        profileId: "profile-1",
        existingDeviceToken: exampleHumanDeviceToken,
        request: {
          invitationToken: exampleInvitationToken,
          displayName: "Member"
        }
      })
    ).rejects.toThrow(/existingDeviceToken/);
  });

  it("disposes the live session on project switch, logout, and shutdown", async () => {
    const root = await tempDir("planweave-collab-cleanup-");
    const dispose = vi.fn();
    const stopObserver = vi.fn();
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      createClient: () =>
        ({
          startObserver: vi.fn(),
          stopObserver,
          dispose,
          bootstrapOwner: vi.fn(),
          consumeInvitation: vi.fn()
        }) as never
    });

    await service.upsertProfile({
      profileId: "profile-a",
      displayName: "A",
      serverBaseUrl: "https://a.example.com/",
      projectId: "project-a",
      allowInsecureTransport: false
    });
    await service.upsertProfile({
      profileId: "profile-b",
      displayName: "B",
      serverBaseUrl: "https://b.example.com/",
      projectId: "project-b",
      allowInsecureTransport: false
    });
    await service.importDeviceCredential({
      profileId: "profile-a",
      deviceToken: exampleHumanDeviceToken
    });
    await service.importDeviceCredential({
      profileId: "profile-b",
      deviceToken: exampleHumanDeviceToken
    });

    await service.connectSession({ profileId: "profile-a" });
    expect(dispose).not.toHaveBeenCalled();

    await service.setActiveProfile({ profileId: "profile-b" });
    expect(stopObserver).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();

    dispose.mockClear();
    stopObserver.mockClear();
    await service.connectSession({ profileId: "profile-b" });
    await service.clearDeviceCredential({ profileId: "profile-b" });
    expect(dispose).toHaveBeenCalled();

    dispose.mockClear();
    await service.importDeviceCredential({
      profileId: "profile-a",
      deviceToken: exampleHumanDeviceToken
    });
    await service.connectSession({ profileId: "profile-a" });
    await service.shutdown();
    expect(dispose).toHaveBeenCalled();
    await expect(service.getStatus()).rejects.toThrow(/shut down/);
  });

  it("preserves validated observer cursor across dispose and resumes startObserver", async () => {
    const root = await tempDir("planweave-collab-cursor-");
    const startObserver = vi.fn();
    let observerCursor = 0;
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      createClient: () =>
        ({
          startObserver: (
            handlers: { onStatus?: (status: unknown) => void },
            options?: { cursor?: number }
          ) => {
            startObserver(handlers, options);
            if (options?.cursor !== undefined) {
              observerCursor = options.cursor;
            }
            handlers.onStatus?.({
              state: "connected",
              cursor: observerCursor > 0 ? observerCursor : 42,
              connectedAt: "2030-01-01T00:00:00.000Z"
            });
            observerCursor = observerCursor > 0 ? observerCursor : 42;
          },
          stopObserver: vi.fn(),
          dispose: vi.fn(),
          lastObserverCursor: () => observerCursor,
          bootstrapOwner: vi.fn(),
          consumeInvitation: vi.fn()
        }) as never
    });

    await service.upsertProfile({
      profileId: "profile-a",
      displayName: "A",
      serverBaseUrl: "https://a.example.com/",
      projectId: "project-a",
      allowInsecureTransport: false
    });
    await service.importDeviceCredential({
      profileId: "profile-a",
      deviceToken: exampleHumanDeviceToken
    });

    await service.connectSession({ profileId: "profile-a" });
    expect(startObserver).toHaveBeenCalledWith(expect.any(Object), { cursor: 0 });

    await service.disconnectSession();
    startObserver.mockClear();
    observerCursor = 0;

    await service.connectSession({ profileId: "profile-a" });
    expect(startObserver).toHaveBeenCalledWith(expect.any(Object), { cursor: 42 });

    await service.upsertProfile({
      profileId: "profile-a",
      displayName: "A moved",
      serverBaseUrl: "https://moved.example.com/",
      projectId: "project-moved",
      allowInsecureTransport: false
    });
    startObserver.mockClear();
    observerCursor = 0;

    await service.connectSession({ profileId: "profile-a" });
    expect(startObserver).toHaveBeenCalledWith(expect.any(Object), { cursor: 0 });

    await service.shutdown();
  });

  it("does not leak absolute vault/profile paths through storage or boundary errors", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const root = await tempDir("planweave-collab-path-");
    const profilesPath = join(root, "profiles.json");
    const credentialsDir = join(root, "credentials-as-dir");
    await writeFile(profilesPath, "{not-json", "utf8");
    await mkdir(credentialsDir);

    const profileStore = new CollaborationProfileStore({ profilesPath });
    await expect(profileStore.read()).rejects.toMatchObject({
      message: expect.stringMatching(/Invalid collaboration profiles JSON/)
    });
    try {
      await profileStore.read();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(profilesPath);
      expect((error as Error).message).not.toContain(root);
    }

    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath: credentialsDir },
      safeStorage: mockSafeStorage({ available: true })
    });
    // Directory path makes readFile fail without embedding the absolute path in the boundary message.
    try {
      await vault.getDeviceToken("profile-a");
      throw new Error("vault read should fail");
    } catch (error) {
      if (error instanceof Error && error.message === "vault read should fail") throw error;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/Failed to read collaboration credentials/);
      expect((error as Error).message).not.toContain(credentialsDir);
      expect((error as Error).message).not.toContain(root);
    }

    const { collaborationErrorFromUnknown } = await import(
      "../main/collaboration/collaborationErrors.js"
    );
    const leakedPath = join(root, "secrets", "credentials.json");
    const leaked = collaborationErrorFromUnknown(
      new Error(`Failed to read collaboration credentials at ${leakedPath}: EACCES`)
    );
    expect(leaked.message).not.toContain(leakedPath);
    expect(leaked.message).not.toContain(root);
    expect(leaked.message).toContain("<redacted-path>");
  });

  it("registers unique collaboration invoke channels", () => {
    const channels = Object.values(collaborationInvokeChannels);
    expect(new Set(channels).size).toBe(channels.length);
    for (const channel of channels) {
      expect(channel.startsWith("planweave-collaboration:")).toBe(true);
    }
  });

  it("redacts device tokens and absolute paths from diagnostic text", () => {
    const raw = `Authorization: Bearer ${exampleHumanDeviceToken} body={"deviceToken":"${exampleHumanDeviceToken}"} path=/Users/alice/.planweave/credentials.json`;
    const redacted = redactCollaborationText(raw);
    expect(redacted).not.toContain(exampleHumanDeviceToken);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("/Users/alice");
    expect(redacted).toContain("<redacted-path>");
  });
});

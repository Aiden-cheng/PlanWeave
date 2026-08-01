import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COLLABORATION_REQUEST_TIMEOUT_MS,
  exampleBootstrapResponse,
  exampleHumanDeviceToken,
  exampleInvitationToken,
  exampleObserverCatchupRequired,
  exampleObserverEvent,
  exampleSetupCode,
  exampleSetupCodeRedeemDeviceResponse
} from "@planweave-ai/collaboration-contracts";
import {
  CollaborationClientError,
  CollaborationCredentialVault,
  CollaborationInvitationVault,
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
  it("encrypts invitation secrets and restores them only for the owning profile", async () => {
    const root = await tempDir("planweave-collab-invitations-");
    const invitationsPath = join(root, "invitations.json");
    const safeStorage = mockSafeStorage({ available: true });
    const invitation = {
      invitation: {
        invitationId: "invitation-001",
        projectId: "project-1",
        role: "member" as const,
        createdByHumanPrincipalId: "human-1",
        createdAt: "2030-01-01T00:00:00.000Z",
        expiresAt: "2030-01-02T00:00:00.000Z"
      },
      invitationToken: exampleInvitationToken
    };

    const first = new CollaborationInvitationVault({ path: invitationsPath, safeStorage });
    await expect(first.set("profile-1", invitation)).resolves.toBe("persisted");
    expect(await readFile(invitationsPath, "utf8")).not.toContain(exampleInvitationToken);

    const reopened = new CollaborationInvitationVault({ path: invitationsPath, safeStorage });
    await expect(reopened.get("profile-1", "invitation-001")).resolves.toEqual(invitation);
    await expect(reopened.get("profile-2", "invitation-001")).resolves.toBeNull();

    await reopened.delete("profile-1", "invitation-001");
    await expect(reopened.get("profile-1", "invitation-001")).resolves.toBeNull();
  });

  it("keeps invitation secrets in memory when safeStorage is unavailable", async () => {
    const root = await tempDir("planweave-collab-session-invitations-");
    const invitationsPath = join(root, "invitations.json");
    const invitation = {
      invitation: {
        invitationId: "invitation-002",
        projectId: "project-1",
        role: "member" as const,
        createdByHumanPrincipalId: "human-1",
        createdAt: "2030-01-01T00:00:00.000Z",
        expiresAt: "2030-01-02T00:00:00.000Z"
      },
      invitationToken: exampleInvitationToken
    };
    const vault = new CollaborationInvitationVault({
      path: invitationsPath,
      safeStorage: mockSafeStorage({ available: false })
    });

    await expect(vault.set("profile-1", invitation)).resolves.toBe("session-only");
    await expect(vault.get("profile-1", "invitation-002")).resolves.toEqual(invitation);
    await expect(readFile(invitationsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

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

  it("rejects valid JSON with unsupported versions or invalid store shapes", async () => {
    const root = await tempDir("planweave-collab-invalid-store-");
    const profilesPath = join(root, "profiles.json");
    const credentialsPath = join(root, "credentials.json");

    await writeFile(
      profilesPath,
      JSON.stringify({ version: 2, profiles: [], activeProfileId: null }),
      "utf8"
    );
    await expect(new CollaborationProfileStore({ profilesPath }).read()).rejects.toThrow(
      "Invalid collaboration profiles JSON."
    );

    await writeFile(credentialsPath, JSON.stringify({ version: 1, credentials: [] }), "utf8");
    const vault = new CollaborationCredentialVault({
      paths: { credentialsPath },
      safeStorage: mockSafeStorage({ available: true })
    });
    await expect(vault.getDeviceToken("profile-1")).rejects.toThrow(
      "Invalid collaboration credentials JSON."
    );
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
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
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
    expect(() =>
      assertNoSmuggledCollaborationSecrets({ url: "https://other.example/" }, "test")
    ).toThrow(/url/);
    expect(() =>
      assertNoSmuggledCollaborationSecrets({ command: "server --unsafe" }, "test")
    ).toThrow(/command/);
    expect(() => assertNoSmuggledCollaborationSecrets({ path: "/tmp/project" }, "test")).toThrow(
      /path/
    );
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

  it("migrates the legacy local credential only to a profile for the same project", async () => {
    const root = await tempDir("planweave-collab-local-profile-migration-");
    const service = await serviceWithRoot(root);
    const baseProfile = {
      displayName: "Local",
      serverBaseUrl: "http://127.0.0.1:8787/",
      allowInsecureTransport: true
    };
    await service.upsertProfile({
      ...baseProfile,
      profileId: "planweave-local-loopback",
      projectId: "project-a"
    });
    await service.upsertProfile({
      ...baseProfile,
      profileId: "planweave-local-project-a",
      projectId: "project-a"
    });
    await service.upsertProfile({
      ...baseProfile,
      profileId: "planweave-local-project-b",
      projectId: "project-b"
    });
    await service.importDeviceCredential({
      profileId: "planweave-local-loopback",
      deviceToken: exampleHumanDeviceToken,
      deviceCredentialId: "device-a",
      humanPrincipalId: "owner-a"
    });

    await service.migrateLocalProfileCredential(
      "planweave-local-loopback",
      "planweave-local-project-a"
    );
    await service.migrateLocalProfileCredential(
      "planweave-local-loopback",
      "planweave-local-project-b"
    );

    const status = await service.getStatus();
    const profileA = status.profiles.find(
      (profile) => profile.profileId === "planweave-local-project-a"
    );
    const profileB = status.profiles.find(
      (profile) => profile.profileId === "planweave-local-project-b"
    );
    expect(profileA).toMatchObject({
      hasDeviceCredential: true,
      deviceCredentialId: "device-a",
      humanPrincipalId: "owner-a"
    });
    expect(profileB?.hasDeviceCredential).toBe(false);
  });

  it("publishes only the final non-empty profile during a nested activation transaction", async () => {
    const root = await tempDir("planweave-collab-activation-publication-");
    const publishedActiveProfileIds: Array<string | null> = [];
    const safeStorage = mockSafeStorage({ available: true });
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage
      }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
      safeStorage,
      createClient: () =>
        ({
          verifyAccess: vi.fn().mockResolvedValue(undefined),
          startObserver: vi.fn(),
          stopObserver: vi.fn(),
          dispose: vi.fn(),
          bootstrapOwner: vi.fn(),
          consumeInvitation: vi.fn()
        }) as never,
      onStatusChange: (status) => publishedActiveProfileIds.push(status.activeProfileId)
    });
    const baseProfile = {
      displayName: "Local",
      serverBaseUrl: "http://127.0.0.1:8787/",
      allowInsecureTransport: true
    };
    await service.upsertProfile({
      ...baseProfile,
      profileId: "profile-stable",
      projectId: "project-stable"
    });
    await service.upsertProfile({
      ...baseProfile,
      profileId: "profile-next",
      projectId: "project-next"
    });
    await service.importDeviceCredential({
      profileId: "profile-next",
      deviceToken: exampleHumanDeviceToken,
      humanPrincipalId: "human-owner"
    });
    await service.setActiveProfile({ profileId: "profile-stable" });
    publishedActiveProfileIds.length = 0;

    await service.runStatusPublicationTransaction(async () => {
      await service.upsertProfile({
        ...baseProfile,
        profileId: "profile-next",
        projectId: "project-next"
      });
      await service.runStatusPublicationTransaction(async () => {
        await service.setActiveProfile({ profileId: "profile-next" });
        await service.connectSession({ profileId: "profile-next" });
      });
    });

    expect(publishedActiveProfileIds).toEqual(["profile-next"]);
  });

  it("publishes the restored stable profile after an activation transaction fails", async () => {
    const root = await tempDir("planweave-collab-activation-rollback-");
    const publishedActiveProfileIds: Array<string | null> = [];
    const safeStorage = mockSafeStorage({ available: true });
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
      safeStorage,
      onStatusChange: (status) => publishedActiveProfileIds.push(status.activeProfileId)
    });
    await service.upsertProfile({
      profileId: "profile-stable",
      displayName: "Stable",
      serverBaseUrl: "http://127.0.0.1:8787/",
      projectId: "project-stable",
      allowInsecureTransport: true
    });
    await service.setActiveProfile({ profileId: "profile-stable" });
    publishedActiveProfileIds.length = 0;

    await expect(
      service.runStatusPublicationTransaction(async () => {
        await service.clearActiveProfile();
        await service.setActiveProfile({ profileId: "profile-stable" });
        throw new Error("activation_failed");
      })
    ).rejects.toThrow("activation_failed");

    expect(publishedActiveProfileIds).toEqual(["profile-stable"]);
  });

  it("redeems a setup code in main and exposes only a redacted Workspace connection", async () => {
    const root = await tempDir("planweave-collab-workspace-setup-");
    const request = vi.fn(async (_input: RequestInfo | URL) => {
      const url = String(_input);
      const body = url.includes("/workspace-connection")
        ? {
            schemaVersion: "workspace-setup/v1",
            items: [
              {
                schemaVersion: "workspace-setup/v1",
                workspaceId: exampleSetupCodeRedeemDeviceResponse.connectionProfile.workspaceId,
                displayName: "Authoritative Workspace",
                role: "owner",
                archivedAt: null,
                membershipActive: true
              }
            ],
            nextCursor: null
          }
        : exampleSetupCodeRedeemDeviceResponse;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      request
    });

    const status = await service.redeemSetupCode({
      serverBaseUrl: "http://127.0.0.1:8787/",
      allowInsecureTransport: true,
      setupCode: exampleSetupCode,
      displayName: "Ada"
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(status.workspaceConnection.status).toBe("connected");
    expect(status.workspaceConnection.workspaceId).toBe(
      exampleSetupCodeRedeemDeviceResponse.connectionProfile.workspaceId
    );
    const statusJson = JSON.stringify(status);
    expect(statusJson).not.toContain(exampleSetupCode);
    expect(statusJson).not.toContain(exampleSetupCodeRedeemDeviceResponse.deviceToken);
    expect(statusJson).not.toContain("encryptedDeviceToken");

    const profileJson = await readFile(join(root, "workspace-profiles.json"), "utf8");
    expect(profileJson).not.toContain(exampleSetupCodeRedeemDeviceResponse.deviceToken);
    await service.disconnectWorkspaceConnection();
    expect((await service.getStatus()).workspaceConnection.status).toBe("local_only");
  });

  it.each([
    [
      "offline",
      () => Promise.reject(new TypeError("network unavailable")),
      "collaboration_offline"
    ],
    [
      "revoked",
      () =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "workspace_connection_unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" }
          })
        ),
      "workspace_connection_unauthorized"
    ],
    [
      "cross-workspace",
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              schemaVersion: "workspace-setup/v1",
              items: [
                {
                  schemaVersion: "workspace-setup/v1",
                  workspaceId: "workspace-other",
                  displayName: "Other Workspace",
                  role: "member",
                  archivedAt: null,
                  membershipActive: true
                }
              ],
              nextCursor: null
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        ),
      "workspace_connection_workspace_unavailable"
    ]
  ])("fails closed when Workspace readiness is %s", async (_name, workspaceResponse, code) => {
    const root = await tempDir("planweave-collab-workspace-readiness-");
    let requestCount = 0;
    const request = vi.fn(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(JSON.stringify(exampleSetupCodeRedeemDeviceResponse), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return workspaceResponse();
    });
    const service = new CollaborationService({
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      request
    });

    await expect(
      service.redeemSetupCode({
        serverBaseUrl: "http://127.0.0.1:8787/",
        allowInsecureTransport: true,
        setupCode: exampleSetupCode,
        displayName: "Ada"
      })
    ).rejects.toMatchObject({ code });
    const status = await service.getStatus();
    expect(status.workspaceConnection.status).toBe("error");
    expect(status.workspaceConnection.error?.code).toBe(code);
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
          verifyAccess: vi.fn().mockResolvedValue(undefined),
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

  it("keeps authenticated HTTP reads available when the observer times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const root = await tempDir("planweave-collab-observer-timeout-");
    const stopObserver = vi.fn();
    const dispose = vi.fn();
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      createClient: () =>
        ({
          verifyAccess: vi.fn().mockResolvedValue(undefined),
          startObserver: (handlers: {
            onStatus?: (status: { state: "connecting"; attempt: number }) => void;
          }) => handlers.onStatus?.({ state: "connecting", attempt: 1 }),
          stopObserver,
          stopPresence: vi.fn(),
          dispose,
          bootstrapOwner: vi.fn(),
          consumeInvitation: vi.fn()
        }) as never
    });

    try {
      await service.upsertProfile({
        profileId: "profile-timeout",
        displayName: "Windows test",
        serverBaseUrl: "http://192.168.123.23:62060/",
        projectId: "project-timeout",
        allowInsecureTransport: true
      });
      await service.importDeviceCredential({
        profileId: "profile-timeout",
        deviceToken: exampleHumanDeviceToken
      });

      const connecting = await service.connectSession({ profileId: "profile-timeout" });
      expect(connecting.session.phase).toBe("connected");

      await vi.advanceTimersByTimeAsync(COLLABORATION_REQUEST_TIMEOUT_MS + 1);
      const timedOut = await service.getStatus();

      expect(timedOut.session).toMatchObject({
        phase: "connected",
        detail: "observer:connect_timeout",
        lastErrorCode: "collaboration_observer_connect_timeout"
      });
      expect(stopObserver).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      await service.shutdown();
      vi.useRealTimers();
    }
  });

  it("creates a fresh client when retrying a failed observer session", async () => {
    const root = await tempDir("planweave-collab-observer-failed-retry-");
    const createClient = vi.fn(() =>
      ({
        verifyAccess: vi.fn().mockResolvedValue(undefined),
        startObserver: (handlers: {
          onStatus?: (status: { state: "failed"; code: string }) => void;
        }) =>
          handlers.onStatus?.({
            state: "failed",
            code: "collaboration_observer_http_403"
          }),
        stopObserver: vi.fn(),
        stopPresence: vi.fn(),
        dispose: vi.fn(),
        bootstrapOwner: vi.fn(),
        consumeInvitation: vi.fn()
      }) as never
    );
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      createClient
    });

    await service.upsertProfile({
      profileId: "profile-retry",
      displayName: "Windows test",
      serverBaseUrl: "http://192.168.123.23:50653/",
      projectId: "project-retry",
      allowInsecureTransport: true
    });
    await service.importDeviceCredential({
      profileId: "profile-retry",
      deviceToken: exampleHumanDeviceToken
    });

    expect((await service.connectSession({ profileId: "profile-retry" })).session).toMatchObject({
      phase: "connected",
      lastErrorCode: "collaboration_observer_http_403",
      lastErrorMessage:
        "Realtime updates are unavailable because this member does not have project read access. Ask an owner to share the project or grant this member project access."
    });
    await service.connectSession({ profileId: "profile-retry" });

    expect(createClient).toHaveBeenCalledTimes(2);
    await service.shutdown();
  });

  it("rejects an invalid credential during HTTP preflight before starting the observer", async () => {
    const root = await tempDir("planweave-collab-session-preflight-");
    const startObserver = vi.fn();
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      createClient: () =>
        ({
          verifyAccess: vi.fn().mockRejectedValue(
            new CollaborationClientError({
              kind: "auth",
              code: "human_auth_unauthenticated",
              message: "Unauthorized",
              httpStatus: 401
            })
          ),
          startObserver,
          stopObserver: vi.fn(),
          stopPresence: vi.fn(),
          dispose: vi.fn(),
          bootstrapOwner: vi.fn(),
          consumeInvitation: vi.fn()
        }) as never
    });

    await service.upsertProfile({
      profileId: "profile-preflight",
      displayName: "Windows test",
      serverBaseUrl: "http://192.168.123.23:50653/",
      projectId: "project-preflight",
      allowInsecureTransport: true
    });
    await service.importDeviceCredential({
      profileId: "profile-preflight",
      deviceToken: exampleHumanDeviceToken
    });

    await expect(service.connectSession({ profileId: "profile-preflight" })).rejects.toMatchObject({
      code: "human_auth_unauthenticated",
      httpStatus: 401
    });
    expect(startObserver).not.toHaveBeenCalled();
    expect((await service.getStatus()).session).toMatchObject({
      phase: "error",
      detail: "connect_preflight_failed",
      lastErrorCode: "human_auth_unauthenticated"
    });
    expect(
      (await service.getStatus()).profiles.find(
        (profile) => profile.profileId === "profile-preflight"
      )?.hasDeviceCredential
    ).toBe(false);
    await service.shutdown();
  });

  it("also bounds reconnecting after an established observer loses its socket", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const root = await tempDir("planweave-collab-observer-reconnect-timeout-");
    const stopObserver = vi.fn();
    const dispose = vi.fn();
    let onStatus:
      | ((
          status:
            | { state: "connected"; cursor: number; connectedAt: string }
            | { state: "reconnecting"; attempt: number; delayMs: number }
        ) => void)
      | undefined;
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      createClient: () =>
        ({
          verifyAccess: vi.fn().mockResolvedValue(undefined),
          startObserver: (handlers: { onStatus?: typeof onStatus }) => {
            onStatus = handlers.onStatus;
            onStatus?.({
              state: "connected",
              cursor: 4,
              connectedAt: "2030-01-01T00:00:00.000Z"
            });
          },
          stopObserver,
          stopPresence: vi.fn(),
          dispose,
          lastObserverCursor: () => 4,
          bootstrapOwner: vi.fn(),
          consumeInvitation: vi.fn()
        }) as never
    });

    try {
      await service.upsertProfile({
        profileId: "profile-reconnect-timeout",
        displayName: "Windows test",
        serverBaseUrl: "http://192.168.123.23:62060/",
        projectId: "project-timeout",
        allowInsecureTransport: true
      });
      await service.importDeviceCredential({
        profileId: "profile-reconnect-timeout",
        deviceToken: exampleHumanDeviceToken
      });

      const connected = await service.connectSession({ profileId: "profile-reconnect-timeout" });
      expect(connected.session.phase).toBe("connected");

      onStatus?.({ state: "reconnecting", attempt: 1, delayMs: 500 });
      expect((await service.getStatus()).session.phase).toBe("connected");
      await vi.advanceTimersByTimeAsync(COLLABORATION_REQUEST_TIMEOUT_MS + 1);

      expect((await service.getStatus()).session.lastErrorCode).toBe(
        "collaboration_observer_connect_timeout"
      );
      expect((await service.getStatus()).session.phase).toBe("connected");
      expect(stopObserver).toHaveBeenCalledTimes(1);
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      await service.shutdown();
      vi.useRealTimers();
    }
  });

  it("preserves validated observer cursor across dispose and resumes startObserver", async () => {
    const root = await tempDir("planweave-collab-cursor-");
    const startObserver = vi.fn();
    const observerHandlers: Array<{
      onStatus?: (status: unknown) => void;
      onEvent?: (event: typeof exampleObserverEvent) => void;
      onCatchupRequired?: (message: typeof exampleObserverCatchupRequired) => void;
    }> = [];
    let observerCursor = 0;
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage: mockSafeStorage({ available: true })
      }),
      createClient: () =>
        ({
          verifyAccess: vi.fn().mockResolvedValue(undefined),
          startObserver: (
            handlers: {
              onStatus?: (status: unknown) => void;
              onEvent?: (event: typeof exampleObserverEvent) => void;
              onCatchupRequired?: (message: typeof exampleObserverCatchupRequired) => void;
            },
            options?: { cursor?: number }
          ) => {
            startObserver(handlers, options);
            observerHandlers.push(handlers);
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
    observerHandlers.at(-1)?.onStatus?.({
      state: "connected",
      cursor: 88,
      connectedAt: "2030-01-01T00:00:00.000Z"
    });
    observerHandlers.at(-1)?.onCatchupRequired?.({
      ...exampleObserverCatchupRequired,
      resumeCursor: 98
    });
    observerHandlers.at(-1)?.onEvent?.({
      ...exampleObserverEvent,
      cursor: 99,
      previousCursor: 42
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
    const raw = `Authorization: Bearer ${exampleHumanDeviceToken} body={"deviceToken":"${exampleHumanDeviceToken}"} home=/Users/alice/.planweave/credentials.json service=/srv/planweave/config.json workspace=/workspace/project/token mount=/mnt/data/secret url=https://collab.example.com/api/v1`;
    const redacted = redactCollaborationText(raw);
    expect(redacted).not.toContain(exampleHumanDeviceToken);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("/Users/alice");
    expect(redacted).not.toContain("/srv/planweave");
    expect(redacted).not.toContain("/workspace/project");
    expect(redacted).not.toContain("/mnt/data");
    expect(redacted).toContain("<redacted-path>");
    expect(redacted).toContain("https://collab.example.com/api/v1");
  });
});

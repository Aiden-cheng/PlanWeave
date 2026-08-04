import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import { CollaborationCredentialVault } from "../main/collaboration/collaborationCredentialVault.js";
import {
  CollaborationProfileStore,
  type CollaborationProfileStorePersistence
} from "../main/collaboration/collaborationProfileStore.js";
import { CollaborationService } from "../main/collaboration/collaborationService.js";
import { collaborationUpsertProfileInputSchema } from "../shared/collaboration.js";
import {
  assertRendererProfileNamespace,
  migrateLegacyStoredCollaborationProfile
} from "../main/collaboration/collaborationProfileEndpoint.js";

const configuredEndpoint = {
  topology: "private_https" as const,
  serverOrigin: "https://192.168.1.20:7443/",
  allowedClientOrigins: ["https://192.168.1.20:7443/"],
  tlsTrust: "configured_ca" as const
};

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString()
};

function legacyDocument() {
  return {
    version: 1,
    activeProfileId: "legacy-https",
    profiles: [
      {
        profileId: "legacy-loopback",
        displayName: "Local legacy",
        serverBaseUrl: "http://127.0.0.1:8787/",
        projectId: "project-local",
        allowInsecureTransport: true,
        updatedAt: "2030-01-01T00:00:00.000Z"
      },
      {
        profileId: "legacy-https",
        displayName: "Remote legacy",
        serverBaseUrl: "https://server.example.test/",
        projectId: "project-remote",
        allowInsecureTransport: false,
        updatedAt: "2030-01-01T00:00:00.000Z"
      }
    ]
  };
}

function readyProfile(profileId: string) {
  const serverBaseUrl = `https://${profileId}.example.test/`;
  return {
    profileId,
    displayName: profileId,
    serverBaseUrl,
    projectId: "project-1",
    allowInsecureTransport: false,
    endpoint: {
      topology: "public_https" as const,
      serverOrigin: serverBaseUrl,
      allowedClientOrigins: [serverBaseUrl],
      tlsTrust: "system_ca" as const
    }
  };
}

function controllablePersistence(): {
  persistence: CollaborationProfileStorePersistence;
  failNextWrite(): void;
} {
  let writeFailurePending = false;
  return {
    persistence: {
      read: (path) => readFile(path, "utf8"),
      write: async (path, value) => {
        if (writeFailurePending) {
          writeFailurePending = false;
          throw new Error("injected profile writer failure");
        }
        await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      }
    },
    failNextWrite() {
      writeFailurePending = true;
    }
  };
}

describe("collaboration profile endpoint authority", () => {
  it("round-trips configured CA endpoint data through durable profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-profile-endpoint-"));
    const profilesPath = join(root, "profiles.json");
    const store = new CollaborationProfileStore({ profilesPath });
    await store.upsert({
      profileId: "remote-lan",
      displayName: "LAN Server",
      serverBaseUrl: configuredEndpoint.serverOrigin,
      projectId: "project-1",
      allowInsecureTransport: false,
      endpoint: configuredEndpoint
    });
    expect(
      (await new CollaborationProfileStore({ profilesPath }).get("remote-lan"))?.endpoint
    ).toEqual(configuredEndpoint);
  });

  it("migrates only explicit legacy HTTP authorities and rejects ambiguous HTTPS", () => {
    expect(
      migrateLegacyStoredCollaborationProfile({
        profileId: "legacy-loopback",
        displayName: "Legacy",
        serverBaseUrl: "http://127.0.0.1:8787/",
        projectId: "project-1",
        allowInsecureTransport: true
      }).endpoint.topology
    ).toBe("loopback_http");
    expect(() =>
      migrateLegacyStoredCollaborationProfile({
        profileId: "legacy-https",
        displayName: "Legacy",
        serverBaseUrl: "https://server.example.test/",
        projectId: "project-1",
        allowInsecureTransport: false
      })
    ).toThrow("collaboration_profile_endpoint_reconnect_required");
  });

  it("rejects legacy profiles at the normal upsert boundary", () => {
    expect(
      collaborationUpsertProfileInputSchema.safeParse({
        profileId: "legacy-loopback",
        displayName: "Legacy",
        serverBaseUrl: "http://127.0.0.1:8787/",
        projectId: "project-1",
        allowInsecureTransport: true
      }).success
    ).toBe(false);
  });

  it("migrates version 1 HTTP documents to endpoint-backed version 3", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-profile-migration-"));
    const profilesPath = join(root, "profiles.json");
    await writeFile(
      profilesPath,
      JSON.stringify({
        version: 1,
        activeProfileId: "legacy-loopback",
        profiles: [
          {
            profileId: "legacy-loopback",
            displayName: "Legacy",
            serverBaseUrl: "http://127.0.0.1:8787/",
            projectId: "project-1",
            allowInsecureTransport: true,
            updatedAt: "2030-01-01T00:00:00.000Z"
          }
        ]
      })
    );
    await new CollaborationProfileStore({ profilesPath }).read();
    const persisted = JSON.parse(await readFile(profilesPath, "utf8"));
    expect(persisted).toMatchObject({
      version: 3,
      profiles: [
        {
          connectionState: "ready",
          endpoint: { topology: "loopback_http" }
        }
      ]
    });
  });

  it("writes strict ready and reconnect-required durable records and rejects invalid combinations", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-profile-shapes-"));
    const profilesPath = join(root, "profiles.json");
    await writeFile(profilesPath, JSON.stringify(legacyDocument()));
    await new CollaborationProfileStore({ profilesPath }).read();
    const persisted = JSON.parse(await readFile(profilesPath, "utf8"));
    expect(persisted.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connectionState: "ready", endpoint: expect.any(Object) }),
        expect.objectContaining({ connectionState: "reconnect_required", endpoint: null })
      ])
    );

    const ready = persisted.profiles.find(
      (profile: { connectionState: string }) => profile.connectionState === "ready"
    );
    const reconnect = persisted.profiles.find(
      (profile: { connectionState: string }) => profile.connectionState === "reconnect_required"
    );
    const invalidDocuments = [
      { ...persisted, profiles: [{ ...ready, endpoint: null }] },
      { ...persisted, profiles: [{ ...reconnect, endpoint: ready.endpoint }] },
      { ...persisted, profiles: [{ ...ready, connectionState: "reconnect_required" }] },
      { ...persisted, profiles: [{ ...reconnect, connectionState: "ready" }] },
      {
        ...persisted,
        profiles: [
          {
            ...ready,
            endpoint: { ...ready.endpoint, topology: "unknown_https" }
          }
        ]
      },
      { ...persisted, profiles: [{ ...ready, unexpected: true }] },
      { ...persisted, version: 4 }
    ];
    for (const invalid of invalidDocuments) {
      await writeFile(profilesPath, JSON.stringify(invalid));
      await expect(new CollaborationProfileStore({ profilesPath }).read()).rejects.toThrow(
        "Invalid collaboration profiles JSON."
      );
    }
  });

  it("migrates version 2 records with an explicit ready discriminator", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-profile-v2-migration-"));
    const profilesPath = join(root, "profiles.json");
    await writeFile(
      profilesPath,
      JSON.stringify({
        version: 2,
        activeProfileId: "remote-v2",
        profiles: [{ ...readyProfile("remote-v2"), updatedAt: "2030-01-01T00:00:00.000Z" }]
      })
    );
    await new CollaborationProfileStore({ profilesPath }).read();
    expect(JSON.parse(await readFile(profilesPath, "utf8"))).toMatchObject({
      version: 3,
      activeProfileId: "remote-v2",
      profiles: [{ profileId: "remote-v2", connectionState: "ready" }]
    });
  });

  it("migrates pre-discriminator version 3 records written by earlier desktop builds", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-profile-v3-migration-"));
    const profilesPath = join(root, "profiles.json");
    await writeFile(
      profilesPath,
      JSON.stringify({
        version: 3,
        activeProfileId: "remote-v3",
        profiles: [{ ...readyProfile("remote-v3"), updatedAt: "2030-01-01T00:00:00.000Z" }]
      })
    );

    const document = await new CollaborationProfileStore({ profilesPath }).read();

    expect(document).toMatchObject({
      version: 3,
      activeProfileId: "remote-v3",
      profiles: [{ profileId: "remote-v3", connectionState: "ready" }]
    });
    expect(JSON.parse(await readFile(profilesPath, "utf8"))).toMatchObject({
      version: 3,
      activeProfileId: "remote-v3",
      profiles: [{ profileId: "remote-v3", connectionState: "ready" }]
    });
  });

  it.each([
    ["tailscale_https", "https://planweave.example-tailnet.ts.net/"],
    ["lan_https", "https://192.168.1.20:7443/"]
  ] as const)("migrates legacy %s endpoints to private HTTPS", async (topology, serverOrigin) => {
    const root = await mkdtemp(join(tmpdir(), "planweave-profile-topology-migration-"));
    const profilesPath = join(root, "profiles.json");
    await writeFile(
      profilesPath,
      JSON.stringify({
        version: 3,
        activeProfileId: "remote-private",
        profiles: [
          {
            profileId: "remote-private",
            displayName: "Private server",
            serverBaseUrl: serverOrigin,
            projectId: "project-1",
            allowInsecureTransport: false,
            endpoint: {
              topology,
              serverOrigin,
              allowedClientOrigins: [serverOrigin],
              tlsTrust: "system_ca"
            },
            updatedAt: "2030-01-01T00:00:00.000Z",
            connectionState: "ready"
          }
        ]
      })
    );

    const document = await new CollaborationProfileStore({ profilesPath }).read();

    expect(document.profiles[0]).toMatchObject({
      connectionState: "ready",
      endpoint: { topology: "private_https" }
    });
    expect(JSON.parse(await readFile(profilesPath, "utf8"))).toMatchObject({
      version: 3,
      activeProfileId: "remote-private",
      profiles: [{ endpoint: { topology: "private_https" } }]
    });
  });

  it("keeps cached and durable state unchanged after failed profile mutations", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-profile-write-failure-"));
    const profilesPath = join(root, "profiles.json");
    const controlled = controllablePersistence();
    const store = new CollaborationProfileStore({ profilesPath }, controlled.persistence);
    await store.upsert(readyProfile("profile-a"));
    await store.upsert(readyProfile("profile-b"));
    await store.setActiveProfileId("profile-a");
    const detachedSnapshot = await store.read();
    detachedSnapshot.profiles.splice(0);
    detachedSnapshot.activeProfileId = null;
    expect((await store.list()).map((profile) => profile.profileId)).toEqual([
      "profile-a",
      "profile-b"
    ]);
    expect(await store.getActiveProfileId()).toBe("profile-a");
    const service = new CollaborationService({
      profileStore: store,
      vault: new CollaborationCredentialVault({
        paths: { credentialsPath: join(root, "credentials.json") },
        safeStorage
      }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
      safeStorage
    });

    controlled.failNextWrite();
    await expect(store.upsert(readyProfile("failed-upsert"))).rejects.toThrow(
      "Failed to write collaboration profiles."
    );
    expect((await service.getStatus()).profiles.map((profile) => profile.profileId)).toEqual([
      "profile-a",
      "profile-b"
    ]);
    await store.remove("profile-b");
    expect(JSON.parse(await readFile(profilesPath, "utf8")).profiles).not.toContainEqual(
      expect.objectContaining({ profileId: "failed-upsert" })
    );

    controlled.failNextWrite();
    await expect(store.remove("profile-a")).rejects.toThrow(
      "Failed to write collaboration profiles."
    );
    expect((await store.list()).map((profile) => profile.profileId)).toEqual(["profile-a"]);
    await store.upsert(readyProfile("profile-c"));
    expect((await store.list()).map((profile) => profile.profileId)).toEqual([
      "profile-a",
      "profile-c"
    ]);

    controlled.failNextWrite();
    await expect(store.setActiveProfileId("profile-c")).rejects.toThrow(
      "Failed to write collaboration profiles."
    );
    expect(await store.getActiveProfileId()).toBe("profile-a");
    expect((await service.getStatus()).activeProfileId).toBe("profile-a");
    await store.upsert(readyProfile("profile-d"));
    const durable = JSON.parse(await readFile(profilesPath, "utf8"));
    expect(durable.activeProfileId).toBe("profile-a");
    expect(durable.profiles.map((profile: { profileId: string }) => profile.profileId)).toEqual([
      "profile-a",
      "profile-c",
      "profile-d"
    ]);
  });

  it("does not publish a failed migration and preserves the write I/O error category", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-profile-migration-failure-"));
    const profilesPath = join(root, "profiles.json");
    const controlled = controllablePersistence();
    await writeFile(profilesPath, JSON.stringify(legacyDocument()));
    const store = new CollaborationProfileStore({ profilesPath }, controlled.persistence);
    controlled.failNextWrite();
    await expect(store.read()).rejects.toThrow("Failed to write collaboration profiles.");
    expect(JSON.parse(await readFile(profilesPath, "utf8"))).toMatchObject({ version: 1 });

    const recovered = await store.read();
    expect(recovered.version).toBe(3);
    expect(recovered.activeProfileId).toBeNull();
    expect(JSON.parse(await readFile(profilesPath, "utf8"))).toMatchObject({ version: 3 });
  });

  it("preserves the read I/O error category", async () => {
    const store = new CollaborationProfileStore(
      { profilesPath: "/not-exposed/collaboration-profiles.json" },
      {
        read: async () => {
          throw Object.assign(new Error("injected read failure"), { code: "EACCES" });
        },
        write: async () => undefined
      }
    );
    await expect(store.read()).rejects.toThrow("Failed to read collaboration profiles.");
  });

  it("quarantines ambiguous HTTPS profiles without blocking status or valid profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-profile-reconnect-"));
    const profilesPath = join(root, "profiles.json");
    const credentialsPath = join(root, "credentials.json");
    await writeFile(profilesPath, JSON.stringify(legacyDocument()));
    const service = new CollaborationService({
      profileStore: new CollaborationProfileStore({ profilesPath }),
      vault: new CollaborationCredentialVault({ paths: { credentialsPath }, safeStorage }),
      workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
      safeStorage
    });

    const status = await service.getStatus();
    expect(status.activeProfileId).toBeNull();
    expect(status.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileId: "legacy-loopback",
          connectionState: "ready",
          endpoint: expect.objectContaining({ topology: "loopback_http" })
        }),
        expect.objectContaining({
          profileId: "legacy-https",
          connectionState: "reconnect_required",
          endpoint: null
        })
      ])
    );
    const persisted = await readFile(profilesPath, "utf8");
    expect(JSON.parse(persisted)).toMatchObject({ version: 3, activeProfileId: null });
    expect(persisted).not.toMatch(/endpoint_reconnect|required error|secret/i);

    await service.removeProfile({ profileId: "legacy-https" });
    expect(await new CollaborationProfileStore({ profilesPath }).list()).toHaveLength(1);
  });

  it("atomically replaces a quarantined profile and preserves it after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-profile-replace-"));
    const profilesPath = join(root, "profiles.json");
    await writeFile(profilesPath, JSON.stringify(legacyDocument()));
    const store = new CollaborationProfileStore({ profilesPath });
    await store.read();
    await store.upsert({
      profileId: "legacy-https",
      displayName: "Reconnected",
      serverBaseUrl: "https://server.example.test/",
      projectId: "project-remote",
      allowInsecureTransport: false,
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://server.example.test/",
        allowedClientOrigins: ["https://server.example.test/"],
        tlsTrust: "system_ca"
      }
    });

    const restarted = new CollaborationProfileStore({ profilesPath });
    expect((await restarted.get("legacy-https"))?.endpoint).toMatchObject({
      topology: "public_https"
    });
    expect(
      (await restarted.list()).filter((profile) => profile.profileId === "legacy-https")
    ).toHaveLength(1);
  });

  it("rejects configured CA at the current transport boundary without downgrading trust", () => {
    expect(
      () =>
        new CollaborationClient({
          profile: {
            profileId: "remote-lan",
            displayName: "LAN Server",
            serverBaseUrl: configuredEndpoint.serverOrigin,
            projectId: "project-1",
            allowInsecureTransport: false,
            endpoint: configuredEndpoint
          },
          credential: { getDeviceToken: async () => undefined }
        })
    ).toThrow("collaboration_configured_ca_unsupported");
  });

  it("rejects renderer attempts to spoof the reserved local profile namespace", () => {
    expect(() => assertRendererProfileNamespace({ profileId: "planweave-local-spoof" })).toThrow(
      "collaboration_local_profile_namespace_reserved"
    );
  });
});

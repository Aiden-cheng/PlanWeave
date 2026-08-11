import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exampleHumanDeviceToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import { CollaborationIdentityOperations } from "../main/collaboration/CollaborationIdentityOperations.js";
import { CollaborationInvitationVault } from "../main/collaboration/collaborationInvitationVault.js";
import { CollaborationProfileStore } from "../main/collaboration/collaborationProfileStore.js";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("CollaborationIdentityOperations", () => {
  it("persists the authoritative renamed human in the active collaboration profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-identity-operations-"));
    directories.push(directory);
    const server = createServer((request, response) => {
      expect(request.method).toBe("PATCH");
      expect(request.url).toBe("/api/v1/projects/project-1/human/me");
      const body = JSON.stringify({
        humanPrincipalId: "human-1",
        displayName: "Grace Hopper",
        createdAt: "2030-01-01T00:00:00.000Z"
      });
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body)
      });
      response.end(body);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}/`;
    const profileStore = new CollaborationProfileStore({
      profilesPath: join(directory, "profiles.json")
    });
    const profile = {
      profileId: "profile-1",
      displayName: "Old Name",
      serverBaseUrl: origin,
      projectId: "project-1",
      allowInsecureTransport: true,
      endpoint: {
        topology: "loopback_http" as const,
        serverOrigin: origin,
        allowedClientOrigins: [origin],
        tlsTrust: "not_applicable" as const
      }
    };
    await profileStore.upsert(profile);
    const client = new CollaborationClient({
      profile,
      credential: { getDeviceToken: () => exampleHumanDeviceToken }
    });
    const publishStatus = vi.fn().mockResolvedValue(undefined);
    const operations = new CollaborationIdentityOperations({
      invitationVault: new CollaborationInvitationVault({
        path: join(directory, "invitations.json"),
        safeStorage: {
          isEncryptionAvailable: () => false,
          encryptString: (value) => Buffer.from(value),
          decryptString: (value) => value.toString("utf8")
        }
      }),
      profiles: profileStore,
      getClientProfileId: () => profile.profileId,
      publishStatus,
      withActiveClient: (operation) => operation(client)
    });

    await expect(
      operations.updateOwnDisplayName({ displayName: "Grace Hopper" })
    ).resolves.toMatchObject({ displayName: "Grace Hopper" });
    expect(await profileStore.get(profile.profileId)).toMatchObject({
      displayName: "Grace Hopper",
      serverBaseUrl: origin,
      projectId: "project-1",
      endpoint: profile.endpoint
    });
    expect(publishStatus).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("migrates only the former localized local-owner default through the rename operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-identity-migration-"));
    directories.push(directory);
    const operations = new CollaborationIdentityOperations({
      invitationVault: new CollaborationInvitationVault({
        path: join(directory, "invitations.json"),
        safeStorage: {
          isEncryptionAvailable: () => false,
          encryptString: (value) => Buffer.from(value),
          decryptString: (value) => value.toString("utf8")
        }
      }),
      profiles: new CollaborationProfileStore({
        profilesPath: join(directory, "profiles.json")
      }),
      getClientProfileId: () => null,
      publishStatus: vi.fn().mockResolvedValue(undefined),
      withActiveClient: async () => {
        throw new Error("network access must be replaced by operation spies");
      }
    });
    const listMembers = vi.spyOn(operations, "listMembers").mockResolvedValue({
      items: [
        {
          membershipId: "membership-owner",
          projectId: "project-1",
          humanPrincipalId: "human-owner",
          displayName: "本机所有者",
          role: "owner",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z"
        }
      ],
      nextCursor: null
    });
    const updateOwnDisplayName = vi.spyOn(operations, "updateOwnDisplayName").mockResolvedValue({
      humanPrincipalId: "human-owner",
      displayName: "Local owner",
      createdAt: "2030-01-01T00:00:00.000Z"
    });

    await expect(
      operations.migrateLegacyLocalOwnerDisplayName({ humanPrincipalId: "human-owner" })
    ).resolves.toBe(true);
    expect(updateOwnDisplayName).toHaveBeenCalledWith({ displayName: "Local owner" });

    listMembers.mockResolvedValueOnce({
      items: [
        {
          membershipId: "membership-owner",
          projectId: "project-1",
          humanPrincipalId: "human-owner",
          displayName: "自定义名称",
          role: "owner",
          createdAt: "2030-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z"
        }
      ],
      nextCursor: null
    });
    updateOwnDisplayName.mockClear();

    await expect(
      operations.migrateLegacyLocalOwnerDisplayName({ humanPrincipalId: "human-owner" })
    ).resolves.toBe(false);
    expect(updateOwnDisplayName).not.toHaveBeenCalled();
  });
});

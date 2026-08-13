import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exampleHumanDeviceToken,
  exampleInvitationToken
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationCredentialVault } from "../main/collaboration/collaborationCredentialVault.js";
import { CollaborationInvitationVault } from "../main/collaboration/collaborationInvitationVault.js";
import { migrateCredentialStorage } from "../main/credentialStorage/credentialStorageMigration.js";
import type { CredentialStoragePaths } from "../main/credentialStorage/credentialStoragePaths.js";
import { OperatorCredentialVault } from "../main/operatorControl/operatorCredentialVault.js";
import {
  readTunnelClientConfig,
  writeTunnelClientConfig
} from "../main/mcpTunnel/tunnelClientStore.js";

const roots: string[] = [];
const operatorToken = "operator_a_token_abcdefghijklmnopqrstuvwxyz_1234";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function storage(prefix: string) {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`${prefix}:${value}`, "utf8"),
    decryptString: (value: Buffer) => {
      const encoded = value.toString("utf8");
      const expected = `${prefix}:`;
      if (!encoded.startsWith(expected)) throw new Error("wrong_credential_storage");
      return encoded.slice(expected.length);
    }
  };
}

function paths(root: string, mode: "application" | "system"): CredentialStoragePaths {
  return {
    preferenceFile: join(root, "preference.json"),
    applicationKeyFile: join(root, "application.key"),
    collaborationCredentialsFile: join(root, `collaboration.${mode}.json`),
    collaborationInvitationsFile: join(root, `invitations.${mode}.json`),
    coordinatorCredentialsFile: join(root, `coordinator.${mode}.json`),
    operatorCredentialsFile: join(root, `operator.${mode}.json`)
  };
}

describe("credential storage migration", () => {
  it("treats the legacy MCP runtime key as a system-storage credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-credential-migration-legacy-mcp-"));
    roots.push(root);
    const applicationStorage = storage("application");
    const systemStorage = storage("system");
    const applicationPaths = paths(root, "application");
    const systemPaths = paths(root, "system");
    const mcpTunnelPaths = { configPath: join(root, "mcp-tunnel.json") };
    const legacySystemCiphertext = systemStorage
      .encryptString("runtime-api-key")
      .toString("base64");
    await writeTunnelClientConfig(
      {
        tunnelClientPath: null,
        verification: null,
        tunnelId: "tunnel-1",
        encryptedRuntimeApiKey: legacySystemCiphertext,
        autoStart: false
      },
      mcpTunnelPaths
    );
    const inaccessibleSystemStorage = {
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error("system_storage_must_not_be_accessed");
      },
      decryptString: () => {
        throw new Error("system_storage_must_not_be_accessed");
      }
    };

    await expect(
      migrateCredentialStorage({
        sourceMode: "application",
        targetMode: "system",
        sourcePaths: applicationPaths,
        targetPaths: systemPaths,
        sourceStorage: applicationStorage,
        targetStorage: inaccessibleSystemStorage,
        mcpTunnelPaths
      })
    ).resolves.toMatchObject({ counts: { mcpRuntimeApiKey: 0 } });
    await expect(readTunnelClientConfig(mcpTunnelPaths)).resolves.toMatchObject({
      encryptedRuntimeApiKey: legacySystemCiphertext
    });
  });

  it("does not access a target credential when the same stable record already exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-credential-migration-existing-"));
    roots.push(root);
    const applicationStorage = storage("application");
    const systemStorage = storage("system");
    const applicationPaths = paths(root, "application");
    const systemPaths = paths(root, "system");
    const mcpTunnelPaths = { configPath: join(root, "mcp-tunnel.json") };
    const coordinator = new OperatorCredentialVault({
      paths: { credentialsPath: applicationPaths.coordinatorCredentialsFile },
      safeStorage: applicationStorage
    });
    await coordinator.setOperatorToken("coordinator-profile-1", operatorToken, "operator-1");

    const sourceDocument = JSON.parse(
      await readFile(applicationPaths.coordinatorCredentialsFile, "utf8")
    ) as {
      version: 1;
      credentials: Record<
        string,
        { encryptedOperatorToken: string; operatorId: string | null; updatedAt: string }
      >;
    };
    const sourceRecord = sourceDocument.credentials["coordinator-profile-1"]!;
    const targetDocument = {
      ...sourceDocument,
      credentials: {
        "coordinator-profile-1": {
          ...sourceRecord,
          encryptedOperatorToken: systemStorage.encryptString(operatorToken).toString("base64")
        }
      }
    };
    await writeFile(
      systemPaths.coordinatorCredentialsFile,
      `${JSON.stringify(targetDocument, null, 2)}\n`,
      "utf8"
    );
    const inaccessibleSystemStorage = {
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error("system_storage_must_not_be_accessed");
      },
      decryptString: () => {
        throw new Error("system_storage_must_not_be_accessed");
      }
    };

    await expect(
      migrateCredentialStorage({
        sourceMode: "application",
        targetMode: "system",
        sourcePaths: applicationPaths,
        targetPaths: systemPaths,
        sourceStorage: applicationStorage,
        targetStorage: inaccessibleSystemStorage,
        mcpTunnelPaths
      })
    ).resolves.toMatchObject({ counts: { coordinatorCredentials: 0 } });
    await expect(readFile(systemPaths.coordinatorCredentialsFile, "utf8")).resolves.toBe(
      `${JSON.stringify(targetDocument, null, 2)}\n`
    );
  });

  it("re-encrypts credentials once per stable id and remains idempotent after switching back", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-credential-migration-"));
    roots.push(root);
    const applicationStorage = storage("application");
    const systemStorage = storage("system");
    const applicationPaths = paths(root, "application");
    const systemPaths = paths(root, "system");
    const mcpTunnelPaths = { configPath: join(root, "mcp-tunnel.json") };

    const collaboration = new CollaborationCredentialVault({
      paths: { credentialsPath: applicationPaths.collaborationCredentialsFile },
      safeStorage: applicationStorage
    });
    await collaboration.setDeviceToken("planweave-local-project-1", exampleHumanDeviceToken, {
      deviceCredentialId: "device-1",
      humanPrincipalId: "human-1"
    });
    const invitations = new CollaborationInvitationVault({
      path: applicationPaths.collaborationInvitationsFile,
      safeStorage: applicationStorage
    });
    await invitations.set("planweave-local-project-1", {
      invitation: {
        invitationId: "invitation-1",
        projectId: "project-1",
        role: "member",
        createdByHumanPrincipalId: "human-1",
        createdAt: "2030-01-01T00:00:00.000Z",
        expiresAt: "2030-01-02T00:00:00.000Z"
      },
      invitationToken: exampleInvitationToken
    });
    const operator = new OperatorCredentialVault({
      paths: { credentialsPath: applicationPaths.operatorCredentialsFile },
      safeStorage: applicationStorage
    });
    await operator.setOperatorToken("operator-profile-1", operatorToken, "operator-1");
    const coordinator = new OperatorCredentialVault({
      paths: { credentialsPath: applicationPaths.coordinatorCredentialsFile },
      safeStorage: applicationStorage
    });
    await coordinator.setOperatorToken("coordinator-profile-1", operatorToken, "operator-1");
    await writeTunnelClientConfig(
      {
        tunnelClientPath: null,
        verification: null,
        tunnelId: "tunnel-1",
        encryptedRuntimeApiKey: null,
        encryptedRuntimeApiKeys: {
          application: applicationStorage.encryptString("runtime-api-key").toString("base64")
        },
        autoStart: true
      },
      mcpTunnelPaths
    );
    const first = await migrateCredentialStorage({
      sourceMode: "application",
      targetMode: "system",
      sourcePaths: applicationPaths,
      targetPaths: systemPaths,
      sourceStorage: applicationStorage,
      targetStorage: systemStorage,
      mcpTunnelPaths
    });
    expect(first.counts).toMatchObject({
      collaborationCredentials: 1,
      invitations: 1,
      coordinatorCredentials: 1,
      operatorCredentials: 1,
      mcpRuntimeApiKey: 1
    });

    const second = await migrateCredentialStorage({
      sourceMode: "system",
      targetMode: "application",
      sourcePaths: systemPaths,
      targetPaths: applicationPaths,
      sourceStorage: systemStorage,
      targetStorage: applicationStorage,
      mcpTunnelPaths
    });
    expect(second.counts.collaborationCredentials).toBe(0);
    expect(second.counts.invitations).toBe(0);
    expect(second.counts.coordinatorCredentials).toBe(0);
    expect(second.counts.operatorCredentials).toBe(0);
    expect(second.counts.mcpRuntimeApiKey).toBe(0);

    const applicationDocument = JSON.parse(
      await readFile(applicationPaths.collaborationCredentialsFile, "utf8")
    ) as { credentials: Record<string, unknown> };
    expect(Object.keys(applicationDocument.credentials)).toEqual(["planweave-local-project-1"]);
    const restoredCollaboration = new CollaborationCredentialVault({
      paths: { credentialsPath: applicationPaths.collaborationCredentialsFile },
      safeStorage: applicationStorage
    });
    await expect(
      restoredCollaboration.getDeviceToken("planweave-local-project-1")
    ).resolves.toBe(exampleHumanDeviceToken);
    const restoredOperator = new OperatorCredentialVault({
      paths: { credentialsPath: applicationPaths.operatorCredentialsFile },
      safeStorage: applicationStorage
    });
    await expect(restoredOperator.getOperatorToken("operator-profile-1")).resolves.toBe(
      operatorToken
    );
    const restoredInvitations = new CollaborationInvitationVault({
      path: applicationPaths.collaborationInvitationsFile,
      safeStorage: applicationStorage
    });
    await expect(
      restoredInvitations.get("planweave-local-project-1", "invitation-1")
    ).resolves.toMatchObject({ invitationToken: exampleInvitationToken });
    const restoredCoordinator = new OperatorCredentialVault({
      paths: { credentialsPath: applicationPaths.coordinatorCredentialsFile },
      safeStorage: applicationStorage
    });
    await expect(
      restoredCoordinator.getOperatorToken("coordinator-profile-1")
    ).resolves.toBe(operatorToken);
    const mcpConfig = await readTunnelClientConfig(mcpTunnelPaths);
    expect(Object.keys(mcpConfig.encryptedRuntimeApiKeys ?? {}).sort()).toEqual([
      "application",
      "system"
    ]);
    expect(
      applicationStorage.decryptString(
        Buffer.from(mcpConfig.encryptedRuntimeApiKeys!.application!, "base64")
      )
    ).toBe("runtime-api-key");
  });
});

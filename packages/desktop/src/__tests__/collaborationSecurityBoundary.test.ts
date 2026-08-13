import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exampleHumanDeviceToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { CollaborationCredentialVault } from "../main/collaboration/collaborationCredentialVault.js";
import { collaborationErrorFromUnknown } from "../main/collaboration/collaborationErrors.js";
import { CollaborationProfileStore } from "../main/collaboration/collaborationProfileStore.js";
import { redactCollaborationText } from "../main/collaboration/redaction.js";
import { CollaborationService } from "../main/collaboration/collaborationService.js";
import {
  assertNoSmuggledCollaborationSecrets,
  collaborationInvokeChannels
} from "../shared/collaboration.js";

const roots: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

function safeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8")
  };
}

function publicEndpoint(serverOrigin: string) {
  return {
    topology: "public_https" as const,
    serverOrigin,
    allowedClientOrigins: [serverOrigin],
    tlsTrust: "system_ca" as const
  };
}

async function serviceWithRoot(root: string): Promise<CollaborationService> {
  const storage = safeStorage();
  return new CollaborationService({
    profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
    vault: new CollaborationCredentialVault({
      paths: { credentialsPath: join(root, "credentials.json") },
      safeStorage: storage
    }),
    workspaceProfileStorePaths: { profilesPath: join(root, "workspace-profiles.json") },
    safeStorage: storage
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("collaboration security boundary", () => {
  it("rejects smuggled secrets and non-profile URL shortcuts on upsert", async () => {
    const service = await serviceWithRoot(await temporaryDirectory("planweave-collab-smuggle-"));

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
    const service = await serviceWithRoot(await temporaryDirectory("planweave-collab-malformed-"));

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
      allowInsecureTransport: false,
      endpoint: publicEndpoint("https://collab.example.com/")
    });
    await expect(
      service.importDeviceCredential({ profileId: "profile-1", deviceToken: "not-a-token" })
    ).rejects.toThrow();
  });

  it("does not leak absolute vault or profile paths through boundary errors", async () => {
    const root = await temporaryDirectory("planweave-collab-path-");
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
      safeStorage: safeStorage()
    });
    await expect(vault.getDeviceToken("profile-a")).rejects.toMatchObject({
      message: "Failed to read collaboration credentials."
    });

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

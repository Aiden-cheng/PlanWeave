/**
 * REL-002#B-002 Desktop IPC trust-boundary attack matrix.
 *
 * Renderer must not smuggle secrets, absolute vault paths, or non-profile transport
 * shortcuts into main. Failures must be redacted for diagnostics.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exampleHumanDeviceToken,
  exampleSecretsForRedaction
} from "@planweave-ai/collaboration-protocol";
import {
  CollaborationCredentialVault,
  CollaborationProfileStore,
  CollaborationService,
  redactCollaborationText
} from "../main/collaboration/index.js";
import { assertNoSmuggledCollaborationSecrets } from "../shared/collaboration.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function mockSafeStorage(options?: { available?: boolean }) {
  const available = options?.available ?? true;
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (buffer: Buffer) => buffer.toString("utf8")
  };
}

async function service(root: string, available = true) {
  return new CollaborationService({
    profileStore: new CollaborationProfileStore({ profilesPath: join(root, "profiles.json") }),
    vault: new CollaborationCredentialVault({
      paths: { credentialsPath: join(root, "credentials.json") },
      safeStorage: mockSafeStorage({ available })
    }),
    safeStorage: mockSafeStorage({ available })
  });
}

describe("Desktop collaboration IPC trust matrix", () => {
  it("denies secret and path smuggling across profile/credential invoke surfaces", async () => {
    const root = await tempDir("planweave-ipc-trust-");
    const collab = await service(root);

    const cases: Array<{ name: string; run: () => Promise<unknown> }> = [
      {
        name: "upsert deviceToken smuggle",
        run: () =>
          collab.upsertProfile({
            profileId: "p1",
            displayName: "Demo",
            serverBaseUrl: "https://collab.example.com/",
            projectId: "project-1",
            allowInsecureTransport: false,
            deviceToken: exampleHumanDeviceToken
          })
      },
      {
        name: "upsert credentialPath smuggle",
        run: () =>
          collab.upsertProfile({
            profileId: "p1",
            displayName: "Demo",
            serverBaseUrl: "https://collab.example.com/",
            projectId: "project-1",
            allowInsecureTransport: false,
            credentialPath: join(root, "secrets.json")
          })
      },
      {
        name: "import dual ciphertext+token",
        run: () =>
          collab.importDeviceCredential({
            profileId: "missing",
            deviceToken: exampleHumanDeviceToken,
            encryptedDeviceToken: "abc"
          })
      },
      {
        name: "import invalid token shape",
        run: async () => {
          await collab.upsertProfile({
            profileId: "p1",
            displayName: "Demo",
            serverBaseUrl: "https://collab.example.com/",
            projectId: "project-1",
            allowInsecureTransport: false
          });
          return collab.importDeviceCredential({
            profileId: "p1",
            deviceToken: "not-a-token"
          });
        }
      }
    ];

    for (const entry of cases) {
      await expect(entry.run(), entry.name).rejects.toThrow();
    }

    expect(() =>
      assertNoSmuggledCollaborationSecrets(
        { authorization: exampleSecretsForRedaction.authorizationHeader },
        "matrix"
      )
    ).toThrow(/authorization/);
  });

  it("never persists plaintext tokens and redacts tokens/paths from diagnostic text", async () => {
    const root = await tempDir("planweave-ipc-redact-");
    const collab = await service(root);
    await collab.upsertProfile({
      profileId: "p1",
      displayName: "Demo",
      serverBaseUrl: "https://collab.example.com/",
      projectId: "project-1",
      allowInsecureTransport: false
    });
    await collab.importDeviceCredential({
      profileId: "p1",
      deviceToken: exampleHumanDeviceToken,
      deviceCredentialId: "device-1",
      humanPrincipalId: "human-1"
    });

    const vaultRaw = await readFile(join(root, "credentials.json"), "utf8");
    expect(vaultRaw).not.toContain(exampleHumanDeviceToken);
    expect(vaultRaw).toMatch(/encryptedDeviceToken/);

    const status = await collab.getStatus();
    const statusJson = JSON.stringify(status);
    expect(statusJson).not.toContain(exampleHumanDeviceToken);
    expect(statusJson).not.toContain("Bearer ");

    const diagnostic = [
      `failed vault path ${join(root, "credentials.json")}`,
      `token ${exampleHumanDeviceToken}`,
      exampleSecretsForRedaction.authorizationHeader,
      `invite pw_inv_abcdefghijklmnopqrstuvwxabcdefghijklmnopq`
    ].join(" | ");
    const redacted = redactCollaborationText(diagnostic);
    expect(redacted).not.toContain(exampleHumanDeviceToken);
    expect(redacted).not.toContain("/Users/");
    expect(redacted).not.toContain("/var/folders/");
    expect(redacted.includes("REDACTED") || redacted.includes("redacted-path")).toBe(true);
  });

  it("rejects non-origin server URLs and insecure non-loopback profiles", async () => {
    const root = await tempDir("planweave-ipc-url-");
    const collab = await service(root);
    await expect(
      collab.upsertProfile({
        profileId: "p1",
        displayName: "Bad",
        serverBaseUrl: "https://collab.example.com/path-not-origin",
        projectId: "project-1",
        allowInsecureTransport: false
      })
    ).rejects.toThrow();
    await expect(
      collab.upsertProfile({
        profileId: "p1",
        displayName: "Insecure",
        serverBaseUrl: "http://example.com/",
        projectId: "project-1",
        allowInsecureTransport: true
      })
    ).rejects.toThrow();
  });

  it("keeps profile store free of device tokens even if renderer writes adjacent files", async () => {
    const root = await tempDir("planweave-ipc-store-");
    const collab = await service(root);
    await collab.upsertProfile({
      profileId: "p1",
      displayName: "Demo",
      serverBaseUrl: "https://collab.example.com/",
      projectId: "project-1",
      allowInsecureTransport: false
    });
    // Adjacent hostile file must not be treated as vault input.
    await writeFile(
      join(root, "leak.json"),
      JSON.stringify({ deviceToken: exampleHumanDeviceToken })
    );
    const profiles = await readFile(join(root, "profiles.json"), "utf8");
    expect(profiles).not.toContain(exampleHumanDeviceToken);
    expect(profiles).not.toContain("deviceToken");
  });
});

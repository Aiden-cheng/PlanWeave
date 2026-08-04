import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exampleSetupCodeIssueResponse } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { parseCollaborationSetupHandoffV1 } from "@planweave-ai/collaboration-protocol/handoff/setup";
import {
  parseAgentHostSetupHandoff,
  serializeAgentHostSetupHandoff
} from "@planweave-ai/agent-host-protocol";
import {
  OPERATOR_CONTROL_JSON_BODY_MAX_BYTES,
  OperatorControlClient
} from "../main/operatorControl/OperatorControlClient.js";
import {
  OperatorCredentialVault,
  type OperatorSafeStoragePort
} from "../main/operatorControl/operatorCredentialVault.js";
import { parseAgentHostClipboardHandoff } from "../main/operatorControl/localAgentHostClipboardHandoff.js";
import { OperatorControlService } from "../main/operatorControl/operatorControlService.js";
import { OperatorProfileStore } from "../main/operatorControl/operatorProfileStore.js";
import {
  assertNoSmuggledOperatorSecrets,
  operatorControlProfileSchema,
  operatorImportCredentialInputSchema
} from "../shared/operatorControl.js";

const tokenA = "operator_a_token_abcdefghijklmnopqrstuvwxyz_1234";
const tokenB = "operator_b_token_abcdefghijklmnopqrstuvwxyz_1234";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

function safeStorage(available: boolean): OperatorSafeStoragePort {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (value) => value.toString("utf8")
  };
}

async function root(prefix: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}

const profile = (profileId: string, serverBaseUrl = "https://operator.example.test/") => ({
  profileId,
  displayName: profileId,
  serverBaseUrl,
  allowInsecureTransport: false
});

describe("Desktop operator control trust boundary", () => {
  it("keeps credential material out of the renderer import contract", () => {
    expect(operatorImportCredentialInputSchema.parse({ profileId: "profile-a" })).toEqual({
      profileId: "profile-a"
    });
    expect(() =>
      operatorImportCredentialInputSchema.parse({
        profileId: "profile-a",
        operatorToken: tokenA
      })
    ).toThrow();
  });

  it("rejects cyclic, deeply nested, and oversized IPC payloads without recursion", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertNoSmuggledOperatorSecrets(cyclic, "cyclic")).toThrow(/cyclic/);

    let deeplyNested: Record<string, unknown> = {};
    const root = deeplyNested;
    for (let depth = 0; depth < 20; depth += 1) {
      const next: Record<string, unknown> = {};
      deeplyNested.next = next;
      deeplyNested = next;
    }
    expect(() => assertNoSmuggledOperatorSecrets(root, "deep")).toThrow(/too deep/);

    expect(() =>
      assertNoSmuggledOperatorSecrets(
        { values: Array.from({ length: 300 }, (_, index) => ({ index })) },
        "large"
      )
    ).toThrow(/too many/);
  });

  it("uses safeStorage or explicit session-only persistence without plaintext", async () => {
    const directory = await root("planweave-operator-vault-");
    const durablePath = join(directory, "credentials.json");
    const durable = new OperatorCredentialVault({
      paths: { credentialsPath: durablePath },
      safeStorage: safeStorage(true)
    });
    expect(await durable.setOperatorToken("profile-a", tokenA)).toBe("persisted");
    const raw = await readFile(durablePath, "utf8");
    expect(raw).not.toContain(tokenA);
    expect(raw).toContain("encryptedOperatorToken");
    expect(await durable.getOperatorToken("profile-a")).toBe(tokenA);

    const sessionPath = join(directory, "session.json");
    const session = new OperatorCredentialVault({
      paths: { credentialsPath: sessionPath },
      safeStorage: safeStorage(false)
    });
    expect(await session.setOperatorToken("profile-a", tokenA)).toBe("session-only");
    expect(await session.getOperatorToken("profile-a")).toBe(tokenA);
    await expect(readFile(sessionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps profiles non-secret and rejects renderer secret smuggling", async () => {
    const directory = await root("planweave-operator-profile-");
    const store = new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") });
    await store.upsert(profile("profile-a"));
    const raw = await readFile(join(directory, "profiles.json"), "utf8");
    expect(raw).not.toContain("operatorToken");
    expect(() =>
      assertNoSmuggledOperatorSecrets(
        { profileId: "profile-a", request: { headers: { Authorization: `Bearer ${tokenA}` } } },
        "test"
      )
    ).toThrow(/not allowed/);
    expect(() =>
      operatorControlProfileSchema.parse({ ...profile("profile-b"), operatorToken: tokenA })
    ).toThrow();
    expect(() =>
      assertNoSmuggledOperatorSecrets(
        {
          ...profile("profile-b"),
          endpoint: {
            topology: "public_https",
            serverOrigin: "https://other.example",
            allowedClientOrigins: ["https://other.example"],
            tlsTrust: "system_ca"
          }
        },
        "upsertOperatorProfile"
      )
    ).toThrow(/endpoint/);
  });

  it("rejects a renderer URL edit that conflicts with a Main-owned endpoint", async () => {
    const directory = await root("planweave-operator-endpoint-");
    const store = new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") });
    await store.upsert({
      ...profile("profile-endpoint", "https://server.example/"),
      endpoint: {
        topology: "public_https",
        serverOrigin: "https://server.example",
        allowedClientOrigins: ["https://server.example"],
        tlsTrust: "system_ca"
      }
    });
    const service = new OperatorControlService({ profileStore: store });
    await expect(
      service.upsertProfile(profile("profile-endpoint", "https://other.example/"))
    ).rejects.toThrow();
    await expect(store.get("profile-endpoint")).resolves.toMatchObject({
      serverBaseUrl: "https://server.example/",
      endpoint: { serverOrigin: "https://server.example" }
    });
  });

  it("preserves a Main-owned persisted endpoint when copying a Host setup handoff", async () => {
    const directory = await root("planweave-operator-host-handoff-");
    const enrollmentCode = `pw_enroll_${"A".repeat(43)}`;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://operator.example.test/api/v1/host-enrollments");
      return new Response(
        JSON.stringify({
          enrollmentCode,
          workspaceId: "workspace-1",
          expiresAt: "2030-01-01T00:15:00.000Z"
        }),
        { status: 201 }
      );
    });
    const profilesPath = join(directory, "profiles.json");
    const credentialsPath = join(directory, "credentials.json");
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath },
        safeStorage: safeStorage(true)
      })
    });
    await service.ensureMainOwnedServerProfile({
      profile: {
        ...profile("profile-handoff"),
        endpoint: {
          topology: "public_https",
          serverOrigin: "https://operator.example.test",
          allowedClientOrigins: ["https://operator.example.test"],
          tlsTrust: "system_ca"
        }
      },
      operatorId: "desktop-local-admin",
      operatorToken: tokenA
    });
    const restartedService = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath },
        safeStorage: safeStorage(true)
      }),
      request
    });
    const copyText = vi.fn();

    const view = await restartedService.copyHostBootstrapHandoff(
      {
        profileId: "profile-handoff",
        request: {
          expiresAt: "2030-01-01T00:15:00.000Z",
          credentialExpiresAt: "2030-01-02T00:00:00.000Z"
        }
      },
      copyText
    );

    const command = copyText.mock.calls[0]?.[0] ?? "";
    const handoff = parseAgentHostSetupHandoff(
      command.slice("planweave agent-host enroll ".length)
    );
    expect(handoff.endpoint).toEqual({
      topology: "public_https",
      serverOrigin: "https://operator.example.test",
      allowedClientOrigins: ["https://operator.example.test"],
      tlsTrust: "system_ca"
    });
    expect(handoff.enrollmentCode).toBe(enrollmentCode);
    expect(view.commandPreview).toBe("planweave agent-host enroll <handoff>");
    await expect(restartedService.getStatus()).resolves.toMatchObject({
      profiles: [
        {
          profileId: "profile-handoff",
          endpoint: { serverOrigin: "https://operator.example.test" }
        }
      ]
    });
  });

  it("redeems a local Host handoff entirely in main and returns only redacted status", async () => {
    const directory = await root("planweave-operator-local-host-");
    const enrollmentCode = `pw_enroll_${"B".repeat(43)}`;
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            enrollmentCode,
            workspaceId: "workspace-local",
            expiresAt: "2030-01-01T00:15:00.000Z"
          }),
          { status: 201 }
        )
    );
    const register = vi.fn().mockResolvedValue({
      supported: true,
      state: "ready",
      workspaceId: "workspace-local",
      background: "running",
      agents: []
    });
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") },
        safeStorage: safeStorage(true)
      }),
      request,
      localAgentHost: {
        status: vi.fn().mockResolvedValue({ supported: true, state: "not_registered", agents: [] }),
        register
      }
    });
    await service.ensureMainOwnedServerProfile({
      profile: {
        ...profile("profile-local"),
        endpoint: {
          topology: "public_https",
          serverOrigin: "https://operator.example.test",
          allowedClientOrigins: ["https://operator.example.test"],
          tlsTrust: "system_ca"
        }
      },
      operatorId: "desktop-local-admin",
      operatorToken: tokenA
    });

    const result = await service.registerLocalAgentHost({
      profileId: "profile-local",
      request: {
        expiresAt: "2030-01-01T00:15:00.000Z",
        credentialExpiresAt: "2030-01-02T00:00:00.000Z"
      },
      exposedProfileIds: ["codex-acp"]
    });

    expect(register).toHaveBeenCalledWith(
      "profile-local",
      expect.stringMatching(/^planweave-agent-host-setup:/),
      ["codex-acp"]
    );
    expect(JSON.stringify(result)).not.toMatch(/enrollmentCode|credentialToken|configPath/);
    const localHandoff = parseAgentHostSetupHandoff(String(register.mock.calls[0]?.[1]));
    expect(localHandoff.enrollmentCode).toBe(enrollmentCode);

    await service.ensureMainOwnedServerProfile({
      profile: {
        ...profile("profile-local"),
        endpoint: {
          topology: "public_https",
          serverOrigin: "https://operator.example.test",
          allowedClientOrigins: ["https://operator.example.test"],
          tlsTrust: "configured_ca"
        }
      },
      operatorId: "desktop-local-admin",
      operatorToken: tokenA
    });
    await expect(
      service.registerLocalAgentHost({
        profileId: "profile-local",
        request: {
          expiresAt: "2030-01-01T00:15:00.000Z",
          credentialExpiresAt: "2030-01-02T00:00:00.000Z"
        },
        exposedProfileIds: ["codex-acp"]
      })
    ).rejects.toThrow("local_agent_host_custom_ca_unsupported");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("accepts a raw or copied Host command without exposing it to the renderer contract", async () => {
    const encodedHandoff = serializeAgentHostSetupHandoff({
      version: "agent-host-setup/v1",
      endpoint: {
        topology: "tailscale_https",
        serverOrigin: "https://planweave.example.ts.net",
        allowedClientOrigins: ["https://planweave.example.ts.net"],
        tlsTrust: "system_ca"
      },
      workspaceId: "workspace-clipboard",
      enrollmentCode: `pw_enroll_${"C".repeat(43)}`,
      expiresAt: "2030-01-01T00:15:00.000Z",
      display: { workspaceName: "Workspace", serverName: "Server" }
    });
    expect(parseAgentHostClipboardHandoff(encodedHandoff)).toMatchObject({
      encodedHandoff,
      handoff: { workspaceId: "workspace-clipboard" }
    });
    expect(
      parseAgentHostClipboardHandoff(`planweave agent-host enroll ${encodedHandoff}`)
    ).toMatchObject({ encodedHandoff });
    expect(() => parseAgentHostClipboardHandoff("planweave agent-host enroll ")).toThrow(
      "local_agent_host_handoff_invalid"
    );
    const expiredHandoff = serializeAgentHostSetupHandoff({
      ...parseAgentHostSetupHandoff(encodedHandoff, new Date("2029-01-01T00:00:00.000Z")),
      expiresAt: "2020-01-01T00:00:00.000Z"
    });
    expect(() => parseAgentHostClipboardHandoff(expiredHandoff)).toThrow(
      "local_agent_host_handoff_expired"
    );

    const register = vi.fn().mockResolvedValue({
      supported: true,
      state: "ready",
      workspaceId: "workspace-clipboard",
      background: "running",
      agents: []
    });
    const service = new OperatorControlService({
      localAgentHost: {
        status: vi.fn().mockResolvedValue({ supported: true, state: "not_registered", agents: [] }),
        register
      }
    });
    const result = await service.enrollLocalAgentHostFromClipboard(
      { exposedProfileIds: ["codex-acp"] },
      `planweave agent-host enroll ${encodedHandoff}`
    );

    expect(register).toHaveBeenCalledWith(undefined, encodedHandoff, ["codex-acp"]);
    expect(JSON.stringify(result)).not.toMatch(/enrollmentCode|planweave-agent-host-setup:/);
    await expect(
      service.enrollLocalAgentHostFromClipboard(
        { exposedProfileIds: ["codex-acp"], enrollmentCode: "smuggled" },
        encodedHandoff
      )
    ).rejects.toThrow("Operator IPC rejected enrollLocalAgentHostFromClipboard");
  });

  it("uses only bounded application endpoints and maps 401/403/malformed responses", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization")
      });
      return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
    });
    const client = new OperatorControlClient({
      profile: profile("profile-a"),
      credential: { getOperatorToken: () => tokenA },
      request
    });
    await expect(client.listHosts({ cursor: 0, limit: 100 })).resolves.toEqual({
      items: [],
      nextCursor: null
    });
    expect(requests[0]).toMatchObject({
      url: expect.stringContaining("/api/v1/hosts?cursor=0&limit=100"),
      authorization: `Bearer ${tokenA}`
    });

    request.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "operator_unauthorized" }), { status: 401 })
    );
    await expect(client.listHosts()).rejects.toMatchObject({
      kind: "unauthorized",
      httpStatus: 401,
      code: "operator_unauthorized"
    });
    request.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "operator_admin_required" }), { status: 403 })
    );
    await expect(client.listHosts()).rejects.toMatchObject({ kind: "forbidden", httpStatus: 403 });
    request.mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    await expect(client.listHosts()).rejects.toMatchObject({ code: "operator_malformed_json" });
    expect(JSON.stringify(requests)).toContain(tokenA);
  });

  it("copies a member setup code in main and returns only redacted handoff metadata", async () => {
    const directory = await root("planweave-operator-member-setup-");
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://operator.example.test/api/v1/setup-codes");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        schemaVersion: "workspace-setup/v1",
        purpose: "device_session"
      });
      return new Response(JSON.stringify(exampleSetupCodeIssueResponse), { status: 201 });
    });
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") },
        safeStorage: safeStorage(false)
      }),
      request,
      clock: { now: () => new Date("2030-01-01T00:02:00.000Z") }
    });
    await service.upsertProfile(profile("profile-a"));
    await service.importCredential({ profileId: "profile-a", operatorToken: tokenA });
    const copyText = vi.fn();

    const handoff = await service.copyMemberSetupCode({ profileId: "profile-a" }, copyText);

    expect(parseCollaborationSetupHandoffV1(copyText.mock.calls[0]?.[0] ?? "")).toEqual({
      serverBaseUrl: "https://operator.example.test/",
      setupCode: exampleSetupCodeIssueResponse.setupCode,
      allowInsecureTransport: false
    });
    expect(handoff).toEqual({
      state: "ready",
      workspaceId: exampleSetupCodeIssueResponse.grant.workspaceId,
      expiresAt: exampleSetupCodeIssueResponse.grant.expiresAt,
      copiedAt: "2030-01-01T00:02:00.000Z"
    });
    expect(JSON.stringify(handoff)).not.toContain(exampleSetupCodeIssueResponse.setupCode);
    await expect(
      service.copyMemberSetupCode({ profileId: "profile-a" }, () => {
        throw new Error("clipboard_unavailable");
      })
    ).rejects.toThrow("clipboard_unavailable");
    await expect(
      service.copyMemberSetupCode(
        { profileId: "profile-a", setupCode: exampleSetupCodeIssueResponse.setupCode },
        copyText
      )
    ).rejects.toThrow("Operator IPC rejected copyMemberSetupCode");
  });

  it("stops reading declared and chunked responses at the byte limit", async () => {
    const request = vi.fn<typeof fetch>();
    const client = new OperatorControlClient({
      profile: profile("profile-a"),
      credential: { getOperatorToken: () => tokenA },
      request
    });
    request.mockResolvedValueOnce(
      new Response(null, {
        status: 200,
        headers: { "content-length": String(OPERATOR_CONTROL_JSON_BODY_MAX_BYTES + 1) }
      })
    );
    await expect(client.listHosts()).rejects.toMatchObject({
      code: "operator_response_too_large"
    });

    let canceled = false;
    const oversizedChunk = new Uint8Array(40 * 1024);
    request.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(oversizedChunk);
          },
          cancel() {
            canceled = true;
          }
        }),
        { status: 200 }
      )
    );
    await expect(client.listHosts()).rejects.toMatchObject({
      code: "operator_response_too_large"
    });
    expect(canceled).toBe(true);
  });

  it("isolates profile credentials in the main service", async () => {
    const directory = await root("planweave-operator-isolation-");
    const request = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status:
            init?.headers && new Headers(init.headers).get("authorization") === `Bearer ${tokenA}`
              ? 200
              : 200
        })
    );
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") },
        safeStorage: safeStorage(false)
      }),
      safeStorage: safeStorage(false),
      request
    });
    await service.upsertProfile(profile("profile-a"));
    await service.upsertProfile(profile("profile-b"));
    await service.importCredential({ profileId: "profile-a", operatorToken: tokenA });
    await service.importCredential({ profileId: "profile-b", operatorToken: tokenB });
    await service.listHosts({ profileId: "profile-a" });
    await service.listHosts({ profileId: "profile-b" });
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
      `Bearer ${tokenA}`
    );
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      `Bearer ${tokenB}`
    );
    const status = await service.getStatus();
    expect(JSON.stringify(status)).not.toContain(tokenA);
    expect(JSON.stringify(status)).not.toContain(tokenB);
  });

  it("reuses a persisted self-host deployment credential for repeat exports", async () => {
    const directory = await root("planweave-operator-deployment-");
    const service = new OperatorControlService({
      profileStore: new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") }),
      vault: new OperatorCredentialVault({
        paths: { credentialsPath: join(directory, "credentials.json") },
        safeStorage: safeStorage(true)
      })
    });
    const first = await service.ensureDeploymentProfile({
      profile: profile("deployment-server", "https://collab.example.test/"),
      operatorId: "desktop-self-host-admin"
    });
    const second = await service.ensureDeploymentProfile({
      profile: {
        ...profile("deployment-server", "https://collab.example.test/"),
        displayName: "Updated"
      },
      operatorId: "desktop-self-host-admin"
    });
    expect(second).toBe(first);
    await expect(service.getStatus()).resolves.toMatchObject({
      profiles: [
        {
          profileId: "deployment-server",
          displayName: "Updated",
          hasOperatorCredential: true,
          operatorCredentialPersistence: "persisted"
        }
      ]
    });
  });

  it("removes a new deployment credential when its profile cannot be persisted", async () => {
    const directory = await root("planweave-operator-deployment-rollback-");
    const vault = new OperatorCredentialVault({
      paths: { credentialsPath: join(directory, "credentials.json") },
      safeStorage: safeStorage(true)
    });
    const store = new OperatorProfileStore({ profilesPath: join(directory, "profiles.json") });
    vi.spyOn(store, "upsert").mockRejectedValueOnce(new Error("profile_store_failed"));
    const service = new OperatorControlService({ profileStore: store, vault });
    await expect(
      service.ensureDeploymentProfile({
        profile: profile("deployment-rollback", "https://collab.example.test/"),
        operatorId: "desktop-self-host-admin"
      })
    ).rejects.toThrow("profile_store_failed");
    expect(await vault.persistenceFor("deployment-rollback")).toBe("missing");
  });

  it("accepts loopback HTTP only when explicitly enabled", () => {
    expect(
      () =>
        new OperatorControlClient({
          profile: profile("p", "http://127.0.0.1:8080/"),
          credential: { getOperatorToken: () => tokenA }
        })
    ).toThrow();
    expect(
      () =>
        new OperatorControlClient({
          profile: { ...profile("p", "http://127.0.0.1:8080/"), allowInsecureTransport: true },
          credential: { getOperatorToken: () => tokenA }
        })
    ).not.toThrow();
    expect(
      () =>
        new OperatorControlClient({
          profile: { ...profile("p", "http://example.test/"), allowInsecureTransport: true },
          credential: { getOperatorToken: () => tokenA }
        })
    ).toThrow();
  });
});

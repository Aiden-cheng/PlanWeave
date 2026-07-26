import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorControlClient } from "../main/operatorControl/OperatorControlClient.js";
import {
  OperatorCredentialVault,
  type OperatorSafeStoragePort
} from "../main/operatorControl/operatorCredentialVault.js";
import { OperatorControlService } from "../main/operatorControl/operatorControlService.js";
import { OperatorProfileStore } from "../main/operatorControl/operatorProfileStore.js";
import {
  assertNoSmuggledOperatorSecrets,
  operatorControlProfileSchema
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

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hostCredentialRotationRequestSchema,
  type HostCredentialRotationRequest
} from "@planweave-ai/agent-host-protocol";
import {
  AgentHostCredentialRenewal,
  hostCredentialRenewalWindowMs
} from "../credentials/credentialRenewal.js";
import { FileHostCredentialStore } from "../credentials/fileCredentialStore.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function credentialStore() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-credential-renewal-"));
  directories.push(directory);
  const path = join(directory, "credentials", "host.json");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        version: "agent-host-credentials/v1",
        active: {
          hostId: "host-renewable",
          credentialToken: `pw_host_${"a".repeat(43)}`,
          issuedAt: "2030-01-01T00:00:00.000Z",
          expiresAt: "2030-06-30T00:00:00.000Z",
          credentialPolicy: { lifetimeDays: 180, renewal: "automatic" }
        }
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  return { path, store: new FileHostCredentialStore(path) };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

describe("Agent Host credential renewal", () => {
  it("uses a bounded 20% renewal window", () => {
    expect(
      hostCredentialRenewalWindowMs({
        hostId: "host",
        credentialToken: `pw_host_${"a".repeat(43)}`,
        issuedAt: "2030-01-01T00:00:00.000Z",
        expiresAt: "2030-01-31T00:00:00.000Z",
        credentialPolicy: { lifetimeDays: 30, renewal: "automatic" }
      })
    ).toBe(6 * 24 * 60 * 60_000);
  });

  it("does not rotate early without a manual request", async () => {
    const { store } = await credentialStore();
    const request = vi.fn(async () =>
      response({
        hostId: "host-renewable",
        serverTime: "2030-01-02T00:00:00.000Z",
        credentialExpiresAt: "2030-06-30T00:00:00.000Z",
        policy: { lifetimeDays: 180, renewal: "automatic" }
      })
    );
    const renewal = new AgentHostCredentialRenewal("https://server.example", store, {
      request,
      clock: () => new Date("2030-01-02T00:00:00.000Z")
    });

    await expect(renewal.poll()).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    expect((await store.read())?.rotation).toBeUndefined();
  });

  it("persists one next token before rotation and retries the exact rotation after response loss", async () => {
    const { path, store } = await credentialStore();
    let now = new Date("2030-01-02T00:00:00.000Z");
    const rotationBodies: HostCredentialRotationRequest[] = [];
    let failFirstRotation = true;
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "GET") {
        return response({
          hostId: "host-renewable",
          serverTime: now.toISOString(),
          credentialExpiresAt: "2030-06-30T00:00:00.000Z",
          policy: { lifetimeDays: 180, renewal: "automatic" },
          renewalRequestedAt: "2030-01-01T23:59:00.000Z"
        });
      }
      const body = hostCredentialRotationRequestSchema.parse(JSON.parse(String(init?.body)));
      rotationBodies.push(body);
      if (failFirstRotation) {
        failFirstRotation = false;
        throw new TypeError("simulated response loss");
      }
      return response({
        hostId: "host-renewable",
        rotationId: body.rotationId,
        credentialExpiresAt: "2030-07-01T00:00:31.000Z"
      });
    });
    const renewal = new AgentHostCredentialRenewal("https://server.example", store, {
      request,
      clock: () => now
    });

    await expect(renewal.poll()).rejects.toThrow("simulated response loss");
    const pendingDocument = JSON.parse(await readFile(path, "utf8"));
    expect(pendingDocument.rotation).toMatchObject({
      rotationId: rotationBodies[0]?.rotationId,
      credentialToken: rotationBodies[0]?.nextCredentialToken
    });

    now = new Date("2030-01-02T00:00:31.000Z");
    const active = await renewal.poll();
    expect(rotationBodies).toHaveLength(2);
    expect(rotationBodies[1]).toEqual(rotationBodies[0]);
    expect(active?.credentialToken).toBe(rotationBodies[0]?.nextCredentialToken);
    expect((await store.read())?.rotation).toBeUndefined();
  });
});

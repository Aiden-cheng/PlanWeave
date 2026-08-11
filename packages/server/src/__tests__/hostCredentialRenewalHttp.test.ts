import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHostRepository } from "../hosts.js";
import { handleHostCredentialRenewalRequest } from "../hostCredentialRenewalHttp.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";

const directories: string[] = [];
const stores: PlanweaveServer[] = [];
const httpServers: Server[] = [];

afterEach(async () => {
  for (const server of httpServers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function token(): string {
  return `pw_host_${randomBytes(32).toString("base64url")}`;
}

describe("Agent Host credential renewal HTTP", () => {
  it("rotates with strict bounded requests and promotes only when the next token authenticates", async () => {
    const now = new Date("2030-01-01T00:00:00.000Z");
    const directory = await mkdtemp(join(tmpdir(), "planweave-renewal-http-"));
    directories.push(directory);
    const store = await startPlanweaveServer({
      dataDirectory: directory,
      databasePath: join(directory, "server.sqlite"),
      busyTimeoutMs: 5_000
    });
    stores.push(store);
    const hosts = new AgentHostRepository(store.database, () => now);
    const currentToken = token();
    const nextToken = token();
    const registration = hosts.registerWithCredential(
      "HTTP Host",
      currentToken,
      [],
      1,
      "2030-06-30T00:00:00.000Z",
      { lifetimeDays: 180, renewal: "automatic" }
    );
    const server = createServer((request, response) => {
      void handleHostCredentialRenewalRequest(request, response, {
        hosts,
        transportAdmission: loopbackHttpTransportAdmission,
        clock: () => now
      });
    });
    httpServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected_http_address");
    const endpoint = `http://127.0.0.1:${address.port}/agent-hosts/${registration.host.id}/credential-renewal`;
    const authorization = (credentialToken: string) => ({
      authorization: `Bearer ${credentialToken}`
    });

    const status = await fetch(endpoint, { headers: authorization(currentToken) });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      hostId: registration.host.id,
      policy: { lifetimeDays: 180, renewal: "automatic" }
    });

    const rotate = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...authorization(currentToken),
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({ rotationId: "rotation-http-001", nextCredentialToken: nextToken })
    });
    expect(rotate.status).toBe(200);
    await expect(rotate.json()).resolves.toMatchObject({ rotationId: "rotation-http-001" });
    expect((await fetch(endpoint, { headers: authorization(currentToken) })).status).toBe(200);
    expect((await fetch(endpoint, { headers: authorization(nextToken) })).status).toBe(200);
    expect((await fetch(endpoint, { headers: authorization(currentToken) })).status).toBe(401);

    const malformed = await fetch(`${endpoint}?unexpected=1`, {
      headers: authorization(nextToken)
    });
    expect(malformed.status).toBe(400);
  });
});

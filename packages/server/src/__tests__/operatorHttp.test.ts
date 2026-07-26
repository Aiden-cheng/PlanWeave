import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashOperatorToken, OperatorTokenRegistry } from "../operatorAuth.js";
import {
  handleOperatorHttpRequest,
  operatorTransportAllowed,
  type OperatorControlPort
} from "../operatorHttp.js";

const servers: HttpServer[] = [];
const token = "operator_test_token_abcdefghijklmnopqrstuvwxyz";

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

function control(): OperatorControlPort {
  return {
    createEnrollmentGrant: vi.fn(() => ({
      enrollmentCode: "pw_enroll_test",
      expiresAt: "2030-01-01T00:00:00.000Z"
    })),
    listHosts: vi.fn(() => ({ items: [], nextCursor: null })),
    getHost: vi.fn(),
    revokeHost: vi.fn(),
    dispatch: vi.fn(async (_principal, request) => {
      if ((request as { projectId?: string }).projectId === "project-b") {
        throw new Error("operator_project_forbidden");
      }
      return { operationId: "operation-1" };
    }),
    observeOperation: vi.fn(),
    executeAction: vi.fn(async () => {
      throw new Error("remote_action_attempt_version_conflict");
    }),
    replayEvents: vi.fn(),
    listPendingInteractions: vi.fn(() => ({ items: [], nextCursor: null })),
    settleInteraction: vi.fn()
  };
}

async function setup(
  allowInsecureDevelopment: boolean,
  readiness: "ready" | "reconciling" = "ready"
) {
  const service = control();
  const authorization = new OperatorTokenRegistry([
    {
      operatorId: "operator-1",
      tokenSha256: hashOperatorToken(token),
      projectIds: ["project-a"],
      serverAdmin: true
    }
  ]);
  const server = createServer((request, response) => {
    void handleOperatorHttpRequest(request, response, {
      authorization,
      service,
      readiness: () => ({ status: readiness, schemaVersion: 1 }),
      serverVersion: "test",
      limits: { maxArtifactBytes: 1024, maxWebSocketPayloadBytes: 2048 },
      allowInsecureDevelopment
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return { origin: `http://127.0.0.1:${address.port}`, service };
}

const authorization = { Authorization: `Bearer ${token}` };

describe("operator HTTP boundary", () => {
  it("enforces transport policy before reading a bearer credential", async () => {
    expect(operatorTransportAllowed({ encrypted: true, remoteAddress: "203.0.113.1" })).toBe(true);
    expect(operatorTransportAllowed({ remoteAddress: "127.0.0.1" })).toBe(false);
    expect(operatorTransportAllowed({ remoteAddress: "127.0.0.1" }, true)).toBe(true);
    expect(operatorTransportAllowed({ remoteAddress: "203.0.113.1" }, true)).toBe(false);

    const fixture = await setup(false);
    const response = await fetch(`${fixture.origin}/api/v1/hosts`, { headers: authorization });
    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toEqual({ error: "operator_insecure_transport" });
    expect(fixture.service.listHosts).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated, malformed, cross-scope, stale, and invalid pagination requests", async () => {
    const fixture = await setup(true);
    expect((await fetch(`${fixture.origin}/api/v1/hosts`)).status).toBe(401);

    const malformed = await fetch(`${fixture.origin}/api/v1/host-enrollments`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: "{"
    });
    expect(malformed.status).toBe(400);

    const crossScope = await fetch(`${fixture.origin}/api/v1/remote-operations`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project-b" })
    });
    expect(crossScope.status).toBe(403);

    const stale = await fetch(`${fixture.origin}/api/v1/remote-operations/operation-1/actions`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: "{}"
    });
    expect(stale.status).toBe(409);

    const invalidPage = await fetch(`${fixture.origin}/api/v1/hosts?limit=1&limit=2`, {
      headers: authorization
    });
    expect(invalidPage.status).toBe(400);
  });

  it("serves public health and delegates bounded host pagination", async () => {
    const fixture = await setup(true);
    await expect((await fetch(`${fixture.origin}/healthz`)).json()).resolves.toEqual({
      status: "ok"
    });
    const response = await fetch(`${fixture.origin}/api/v1/hosts?cursor=0&limit=50`, {
      headers: authorization
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [], nextCursor: null });
    expect(fixture.service.listHosts).toHaveBeenCalledWith(
      expect.objectContaining({ operatorId: "operator-1" }),
      { cursor: "0", limit: "50" }
    );
    await expect((await fetch(`${fixture.origin}/version`)).json()).resolves.toMatchObject({
      limits: { maxArtifactBytes: 1024, maxWebSocketPayloadBytes: 2048 }
    });
  });

  it("returns 503 readiness while startup reconciliation is incomplete", async () => {
    const fixture = await setup(true, "reconciling");
    const response = await fetch(`${fixture.origin}/readyz`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "reconciling",
      schemaVersion: 1
    });
  });
});

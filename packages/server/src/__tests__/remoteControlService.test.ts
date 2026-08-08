import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import { HostEnrollmentService } from "../hostEnrollment.js";
import { OperatorSessionStore } from "../identity/operatorSessionStore.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { hashOperatorToken, OperatorTokenRegistry } from "../operatorAuth.js";
import { handleOperatorHttpRequest } from "../operatorHttp.js";
import { RemoteControlService } from "../remoteControlService.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";

const adminToken = `pw_operator_${"F".repeat(43)}`;
const memberToken = `pw_operator_${"G".repeat(43)}`;
const now = new Date("2026-08-03T08:00:00.000Z");

const databases: SqliteDatabase[] = [];
const servers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const database of databases.splice(0)) database.close();
});

async function setup(input: { serverAdmin?: boolean } = {}) {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  const workspaceIdentity = new WorkspaceIdentityRepository(database);
  const workspaceId = workspaceIdentity.ensureWorkspaceForLegacyProject("project-a");
  const coordination = createRemoteBlockCoordination(
    database,
    {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      clock: () => now,
      runtimeResolver: {
        resolve: () => {
          throw new Error("runtime_not_configured");
        },
        hasScope: () => true
      },
      inputArtifacts: { materialize: async () => undefined },
      artifactContent: { readReport: async () => new Uint8Array() }
    },
    { serverInstanceOwnerToken: "remote-control-service-test" }
  );
  new OperatorSessionStore(database).create({
    workspaceId,
    operatorId: "operator-admin",
    credentialSha256: hashOperatorToken(adminToken),
    issuedAt: now.toISOString(),
    expiresAt: "2030-01-01T00:00:00.000Z"
  });
  new OperatorSessionStore(database).create({
    workspaceId,
    operatorId: "operator-member",
    credentialSha256: hashOperatorToken(memberToken),
    issuedAt: now.toISOString(),
    expiresAt: "2030-01-01T00:00:00.000Z"
  });
  const authorization = new OperatorTokenRegistry(database, [
    {
      operatorId: "operator-admin",
      tokenSha256: hashOperatorToken(adminToken),
      projectIds: ["project-a"],
      serverAdmin: true
    },
    {
      operatorId: "operator-member",
      tokenSha256: hashOperatorToken(memberToken),
      projectIds: ["project-a"],
      serverAdmin: input.serverAdmin ?? false
    }
  ]);
  const service = new RemoteControlService({
    authorization,
    enrollments: new HostEnrollmentService(database, () => now),
    hosts: coordination.hosts,
    agentEndpoints: coordination.agentEndpoints,
    operations: coordination.operations,
    dispatches: coordination.dispatches,
    coordinator: coordination.coordinator,
    events: coordination.acpEvents,
    interactions: coordination.interactions,
    disconnectHost: () => {},
    workspaceIdentity,
    authorizeProjectScope: () => {},
    hostOfflineAfterMs: 60_000,
    clock: () => now
  });
  const httpServer = createServer((request, response) => {
    void handleOperatorHttpRequest(request, response, {
      authorization,
      service,
      readiness: () => ({ status: "ready", schemaVersion: 1 }),
      serverVersion: "test",
      limits: { maxArtifactBytes: 1024, maxWebSocketPayloadBytes: 2048 },
      transportAdmission: loopbackHttpTransportAdmission
    });
  });
  servers.push(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  const principal = authorization.authenticate(`Bearer ${adminToken}`);
  if (!principal) throw new Error("Expected admin principal");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    service,
    coordination,
    workspaceId,
    principal
  };
}

function registerFleetHost(
  coordination: Awaited<ReturnType<typeof setup>>["coordination"]
) {
  const registration = coordination.hosts.register("Fleet Host");
  coordination.hosts.reportOnline(registration.host.id, ["acp.codex"], 1, {
    workspaceMappings: [],
    acpProfiles: [
      {
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        status: "ready",
        capabilities: ["acp.codex"]
      }
    ]
  });
  return registration.host;
}

describe("RemoteControlService owner fleet control plane", () => {
  it("lists fleet hosts without workspace binding and revokes them by hostId", () => {
    const run = async () => {
      const fixture = await setup();
      const host = registerFleetHost(fixture.coordination);
      const page = fixture.service.listHosts(fixture.principal, {});
      expect(page.items.map((item) => item.id)).toContain(host.id);
      const listed = page.items.find((item) => item.id === host.id);
      expect(listed?.workspaceId).toBeUndefined();
      expect(listed?.availability).toEqual({ status: "available", reason: null });

      const revoked = fixture.service.revokeHost(fixture.principal, host.id);
      expect(revoked.revokedAt).toBeDefined();
      expect(revoked.workspaceId).toBeUndefined();
      expect(fixture.coordination.hosts.getRequired(host.id).revokedAt).toBeDefined();
    };
    return run();
  });

  it("lists server-scoped agent endpoints without projectId and keeps project-scoped compat", () => {
    const run = async () => {
      const fixture = await setup();
      registerFleetHost(fixture.coordination);
      const fleet = fixture.service.listAgentEndpoints(fixture.principal, {});
      expect(fleet.items).toHaveLength(1);
      expect(fleet.items[0]?.endpointId).toMatch(/^aep_/);

      const projectScoped = fixture.service.listAgentEndpoints(fixture.principal, {
        projectId: "project-a"
      });
      expect(projectScoped.items).toHaveLength(0);
    };
    return run();
  });

  it("B4/B5: rejects fleet endpoint listing without credential or with member-only operator", async () => {
    const fixture = await setup();
    registerFleetHost(fixture.coordination);
    expect((await fetch(`${fixture.origin}/api/v1/agent-endpoints`)).status).toBe(401);

    const forbidden = await fetch(`${fixture.origin}/api/v1/agent-endpoints`, {
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toEqual({ error: "operator_admin_required" });
  });
});

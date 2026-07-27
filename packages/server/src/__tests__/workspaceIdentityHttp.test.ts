import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHostRepository } from "../hosts.js";
import { handleWorkspaceIdentityHttpRequest } from "../identity/workspaceIdentityHttp.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { applyMigrations } from "../migrations.js";
import { hashOperatorToken, OperatorTokenRegistry } from "../operatorAuth.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const servers: HttpServer[] = [];
const databases: SqliteDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const database of databases.splice(0)) database.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-workspace-identity-http-"));
  directories.push(directory);
  const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
  databases.push(database);
  applyMigrations(database);
  const repository = new WorkspaceIdentityRepository(database);
  const workspaceId = repository.ensureWorkspaceForLegacyProject("project-identity");
  const otherWorkspaceId = repository.ensureWorkspaceForLegacyProject("project-other");
  const hosts = new AgentHostRepository(database);
  const activeHost = hosts.register("Identity Host");
  repository.bindHostToWorkspace(activeHost.host.id, workspaceId);
  const expiredHost = hosts.registerWithCredential(
    "Expired Identity Host",
    `pw_host_${"x".repeat(43)}`,
    [],
    1,
    new Date(Date.now() + 60_000).toISOString()
  );
  repository.bindHostToWorkspace(expiredHost.host.id, workspaceId);
  database
    .prepare("UPDATE agent_hosts SET credential_expires_at=? WHERE id=?")
    .run(new Date(Date.now() - 1).toISOString(), expiredHost.host.id);
  repository.synchronizeHost(expiredHost.host.id);
  const revokedHost = hosts.register("Revoked Identity Host");
  repository.bindHostToWorkspace(revokedHost.host.id, workspaceId);
  hosts.revoke(revokedHost.host.id);
  repository.synchronizeHost(revokedHost.host.id);
  const adminToken = "operator_identity_admin_token_123456789";
  const scopedToken = "operator_identity_scoped_token_123456789";
  const authorization = new OperatorTokenRegistry([
    {
      operatorId: "identity-admin",
      tokenSha256: hashOperatorToken(adminToken),
      projectIds: [],
      serverAdmin: true
    },
    {
      operatorId: "identity-scoped",
      tokenSha256: hashOperatorToken(scopedToken),
      projectIds: ["project-identity"],
      serverAdmin: false
    }
  ]);
  const server = createServer((request, response) => {
    void handleWorkspaceIdentityHttpRequest(request, response, {
      authorization,
      repository,
      allowInsecureDevelopment: true
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected_http_address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    workspaceId,
    otherWorkspaceId,
    adminToken,
    scopedToken
  };
}

describe("workspace identity HTTP", () => {
  it("serves only redacted workspace-authoritative projections and enforces scope", async () => {
    const { origin, workspaceId, adminToken, scopedToken } = await setup();
    const url = `${origin}/api/v1/workspaces/${workspaceId}/identity`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const responseText = await response.text();
    expect(response.status, responseText).toBe(200);
    const body = JSON.parse(responseText) as {
      schemaVersion: string;
      workspace: { workspaceId: string };
      hosts: Array<{
        hostId: string;
        workspaceId: string;
        credentialExpiresAt: string | null;
        revokedAt: string | null;
      }>;
      migration: { status: string };
    };
    expect(body.schemaVersion).toBe("workspace-identity/v1");
    expect(body.workspace.workspaceId).toBe(workspaceId);
    expect(body.hosts).toHaveLength(3);
    expect(body.hosts.every((host) => host.workspaceId === workspaceId)).toBe(true);
    expect(body.hosts.some((host) => host.credentialExpiresAt !== null)).toBe(true);
    expect(body.hosts.some((host) => host.revokedAt !== null)).toBe(true);
    expect(body.migration.status).toBe("completed");
    expect(JSON.stringify(body)).not.toMatch(/credential(?:Sha256|Hash|Token)|token|projectRoot|digest/i);

    const scoped = await fetch(url, {
      headers: { Authorization: `Bearer ${scopedToken}` }
    });
    expect(scoped.status).toBe(200);
    expect((await fetch(`${url}?limit=1&cursor=0`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    })).status).toBe(400);
    expect((await fetch(url)).status).toBe(401);
  });

  it("does not disclose unknown workspaces or cross-workspace scopes", async () => {
    const { origin, workspaceId, otherWorkspaceId, adminToken, scopedToken } = await setup();
    const unknown = await fetch(`${origin}/api/v1/workspaces/workspace-unknown/identity`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    expect(unknown.status).toBe(404);

    const forbidden = await fetch(`${origin}/api/v1/workspaces/${otherWorkspaceId}/identity`, {
      headers: { Authorization: `Bearer ${scopedToken}` }
    });
    expect(forbidden.status).toBe(403);
  });
});

import { createServer, type Server as HttpServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { parseServerConfig } from "../config.js";
import { latestCentralSchemaVersion } from "../migrations.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../serverComposition.js";

const httpServers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const directories: string[] = [];
const adminToken = `pw_operator_${"A".repeat(43)}`;
const projectToken = `pw_operator_${"B".repeat(43)}`;

afterEach(async () => {
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function remoteManifest(): PlanPackageManifest {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": { adapter: "agent", agent: "codex", runner: { transport: "acp" } }
  };
  return manifest;
}

async function setup() {
  const workspace = await createTestWorkspace(remoteManifest());
  directories.push(workspace.home, workspace.root);
  const httpServer = createServer();
  httpServers.push(httpServer);
  const dataDirectory = join(workspace.root, "server-data");
  const projectId = workspace.init.workspace.id;
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7_443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory,
    trustedProjects: [{ projectId, canvasId: "default", projectRoot: workspace.root }],
    operatorCredentials: [
      {
        operatorId: "admin",
        tokenSha256: hashOperatorToken(adminToken),
        projectIds: [],
        serverAdmin: true
      },
      {
        operatorId: "project-operator",
        tokenSha256: hashOperatorToken(projectToken),
        projectIds: [projectId]
      }
    ]
  });
  const composition = await createDistributedServerComposition({
    httpServer,
    config
  });
  compositions.push(composition);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return { composition, projectId, origin: `http://127.0.0.1:${address.port}` };
}

function jsonHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "content-type": "application/json" };
}

describe("distributed server composition", () => {
  it("wires health, enrollment, scoped dispatch, idempotency, pagination, and shutdown", async () => {
    const fixture = await setup();
    expect(fixture.composition.ownsHttpServer).toBe(false);
    await expect((await fetch(`${fixture.origin}/readyz`)).json()).resolves.toEqual({
      status: "ready",
      schemaVersion: latestCentralSchemaVersion
    });

    const trustedBootstrap = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/bootstrap`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Trusted Owner", humanPrincipalId: "trusted-owner" })
      }
    );
    expect(trustedBootstrap.status).toBe(201);

    const unknownBootstrap = await fetch(
      `${fixture.origin}/api/v1/projects/unknown-project/human/bootstrap`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Unknown Owner", humanPrincipalId: "unknown-owner" })
      }
    );
    expect(unknownBootstrap.status).toBe(403);
    await expect(unknownBootstrap.json()).resolves.toEqual({
      error: "human_cross_project_forbidden"
    });

    const enrollment = await fetch(`${fixture.origin}/api/v1/host-enrollments`, {
      method: "POST",
      headers: jsonHeaders(adminToken),
      body: JSON.stringify({
        expiresAt: "2030-01-01T00:00:00.000Z",
        credentialExpiresAt: "2030-01-02T00:00:00.000Z"
      })
    });
    expect(enrollment.status).toBe(201);
    await expect(enrollment.json()).resolves.toMatchObject({
      enrollmentCode: expect.stringMatching(/^pw_enroll_/)
    });

    const request = {
      projectId: fixture.projectId,
      canvasId: "default",
      blockRef: "T-001#B-001",
      idempotencyKey: "composition-dispatch-1"
    };
    const dispatch = async (token: string, body = request) =>
      fetch(`${fixture.origin}/api/v1/remote-operations`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify(body)
      });
    const first = await dispatch(adminToken);
    const second = await dispatch(adminToken);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(secondBody.operationId).toBe(firstBody.operationId);

    const forbidden = await dispatch(projectToken, { ...request, projectId: "different-project" });
    expect(forbidden.status).toBe(403);
    const hosts = await fetch(`${fixture.origin}/api/v1/hosts?limit=1`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    expect(hosts.status).toBe(200);
    await expect(hosts.json()).resolves.toEqual({ items: [], nextCursor: null });

    await fixture.composition.close();
    await fixture.composition.close();
    expect(fixture.composition.readiness()).toMatchObject({ status: "draining" });
    compositions.splice(compositions.indexOf(fixture.composition), 1);
  });
});

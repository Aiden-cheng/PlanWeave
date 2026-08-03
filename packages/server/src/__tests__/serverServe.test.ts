import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { parseServerConfig } from "../config.js";
import { legacyWorkspaceIdForProject } from "./support/legacyWorkspaceId.js";
import { latestCentralSchemaVersion } from "../migrations.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { serveDistributedServer } from "../serverServe.js";

const directories: string[] = [];

afterEach(async () => {
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

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("expected_http_port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

describe("distributed server listener", () => {
  it("serves readiness without an online Host and drains idempotently", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const port = await availablePort();
    const config = parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port },
      publicUrl: `http://127.0.0.1:${port}`,
      allowInsecureDevelopment: true,
      dataDirectory: join(workspace.root, "server-data"),
      trustedProjects: [
        {
          workspaceId: legacyWorkspaceIdForProject(workspace.init.workspace.id),
          projectId: workspace.init.workspace.id,
          canvasId: "default",
          projectRoot: workspace.root
        }
      ],
      operatorCredentials: [
        {
          operatorId: "admin",
          tokenSha256: hashOperatorToken(`pw_operator_${"S".repeat(43)}`),
          projectIds: [],
          serverAdmin: true
        }
      ]
    });
    const server = await serveDistributedServer(config);

    expect(server.readiness()).toEqual({
      status: "ready",
      schemaVersion: latestCentralSchemaVersion
    });
    const response = await fetch(`${config.transport.advertisedOrigin}/readyz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ready",
      schemaVersion: latestCentralSchemaVersion
    });
    const authenticated = await fetch(`${config.transport.advertisedOrigin}/api/v1/hosts?limit=1`, {
      headers: { Authorization: `Bearer pw_operator_${"S".repeat(43)}` }
    });
    expect(authenticated.status).toBe(200);
    await server.close();
    await server.close();
    expect(server.readiness()).toMatchObject({ status: "draining" });
  });

  it("listens on loopback HTTP while advertising Tailscale HTTPS without enabling human transport", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const port = await availablePort();
    const advertisedOrigin = "https://planweave.tailnet.ts.net";
    const config = parseServerConfig({
      version: "server-config/v2",
      transport: {
        mode: "tailscale_https",
        listener: { protocol: "http", host: "127.0.0.1", port },
        advertisedOrigin
      },
      deployment: {
        topology: "tailscale_https",
        serverOrigin: advertisedOrigin,
        allowedClientOrigins: [advertisedOrigin],
        tlsTrust: "system_ca"
      },
      allowedClientOrigins: [advertisedOrigin],
      dataDirectory: join(workspace.root, "tailscale-server-data"),
      trustedProjects: [
        {
          workspaceId: legacyWorkspaceIdForProject(workspace.init.workspace.id),
          projectId: workspace.init.workspace.id,
          canvasId: "default",
          projectRoot: workspace.root
        }
      ],
      operatorCredentials: [
        {
          operatorId: "admin",
          tokenSha256: hashOperatorToken(`pw_operator_${"T".repeat(43)}`),
          projectIds: [],
          serverAdmin: true
        }
      ]
    });
    const server = await serveDistributedServer(config);
    expect(server.publicUrl).toBe(advertisedOrigin);
    const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(readiness.status).toBe(200);
    const blocked = await fetch(`http://127.0.0.1:${port}/api/v1/hosts?limit=1`, {
      headers: { Authorization: `Bearer pw_operator_${"T".repeat(43)}` }
    });
    expect(blocked.status).toBe(426);
    await server.close();
  });
});

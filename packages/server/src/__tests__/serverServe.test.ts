import { createServer } from "node:http";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { parseServerConfig } from "../config.js";
import { ServerExposureManager } from "../exposure/serverExposureManager.js";
import type {
  ExposureOwnership,
  ServerExposureLifecyclePort,
  TailscaleControlPort
} from "../exposure/types.js";
import { startPlanweaveServer } from "../lifecycle.js";
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
    const events: string[] = [];
    const ownership: ExposureOwnership = {
      kind: "tailscale_https",
      createdByActivation: true,
      lease: {
        leaseId: "1".repeat(64),
        configFingerprint: "2".repeat(64),
        nodeIdentitySha256: "3".repeat(64),
        advertisedOrigin,
        httpsPort: 443,
        path: "/",
        backendOrigin: `http://127.0.0.1:${port}`,
        serveConfigSha256: "4".repeat(64),
        createdAt: "2026-08-03T00:00:00.000Z"
      }
    };
    const exposure: ServerExposureLifecyclePort = {
      async inspect() {
        events.push("inspect");
        return {
          state: "available",
          listener: config.transport.listener,
          advertisedOrigin
        };
      },
      async activate() {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`);
        const body = (await response.json()) as { status: string };
        events.push(`activate:${response.status}:${body.status}`);
        return {
          listener: config.transport.listener,
          advertisedOrigin,
          ownership
        };
      },
      async release() {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`);
        const body = (await response.json()) as { status: string };
        events.push(`release:${response.status}:${body.status}`);
      }
    };
    let exposureClosed = false;
    const server = await serveDistributedServer(config, {
      exposure: {
        lifecycle: exposure,
        close() {
          exposureClosed = true;
          events.push("exposure-close");
        }
      }
    });
    expect(server.publicUrl).toBe(advertisedOrigin);
    expect(events).toEqual(["inspect", "activate:503:listening"]);
    const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(readiness.status).toBe(200);
    const blocked = await fetch(`http://127.0.0.1:${port}/api/v1/hosts?limit=1`, {
      headers: { Authorization: `Bearer pw_operator_${"T".repeat(43)}` }
    });
    expect(blocked.status).toBe(426);
    await server.close();
    expect(events).toEqual([
      "inspect",
      "activate:503:listening",
      "release:503:draining",
      "exposure-close"
    ]);
    expect(exposureClosed).toBe(true);
  });

  it("closes an injected exposure resource when HTTPS listener creation fails", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const port = await availablePort();
    const origin = `https://127.0.0.1:${port}`;
    const config = parseServerConfig({
      version: "server-config/v2",
      transport: {
        mode: "direct_https",
        listener: {
          protocol: "https",
          host: "127.0.0.1",
          port,
          tls: {
            certificatePath: join(workspace.root, "missing.crt"),
            privateKeyPath: join(workspace.root, "missing.key")
          }
        },
        advertisedOrigin: origin
      },
      deployment: {
        topology: "loopback_https",
        serverOrigin: origin,
        allowedClientOrigins: [origin],
        tlsTrust: "configured_ca"
      },
      allowedClientOrigins: [origin],
      dataDirectory: join(workspace.root, "listener-failure-data"),
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
          tokenSha256: hashOperatorToken(`pw_operator_${"L".repeat(43)}`),
          projectIds: [],
          serverAdmin: true
        }
      ]
    });
    let closed = false;
    const lifecycle: ServerExposureLifecyclePort = {
      async inspect() {
        throw new Error("unexpected_inspect");
      },
      async activate() {
        throw new Error("unexpected_activate");
      },
      async release() {}
    };
    await expect(
      serveDistributedServer(config, {
        exposure: {
          lifecycle,
          close() {
            closed = true;
          }
        }
      })
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(closed).toBe(true);
  });

  it("aborts a timed-out probe, releases before listener cleanup, and closes owned storage", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const port = await availablePort();
    const advertisedOrigin = "https://timeout.tailnet.ts.net";
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
      dataDirectory: join(workspace.root, "timeout-server-data"),
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
          tokenSha256: hashOperatorToken(`pw_operator_${"U".repeat(43)}`),
          projectIds: [],
          serverAdmin: true
        }
      ]
    });
    const events: string[] = [];
    let state: Awaited<ReturnType<TailscaleControlPort["inspectServe"]>> = { config: null };
    const tailscale: TailscaleControlPort = {
      async inspectNode() {
        return {
          version: "1.98.9",
          nodeIdentitySha256: "5".repeat(64),
          dnsName: "timeout.tailnet.ts.net"
        };
      },
      async inspectServe() {
        return state;
      },
      async ensurePrivateHttps() {
        state = {
          config: {
            raw: {
              TCP: { "443": { HTTPS: true } },
              Web: {
                "timeout.tailnet.ts.net:443": {
                  Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } }
                }
              },
              AllowFunnel: {},
              Services: {},
              Foreground: {}
            }
          }
        };
        return state;
      },
      async releasePrivateHttps() {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`);
        const body = (await response.json()) as { status: string };
        events.push(`release:${response.status}:${body.status}`);
        state = { config: { raw: {} } };
      }
    };
    await expect(
      serveDistributedServer(config, {
        createExposureLifecycle: (leases) =>
          new ServerExposureManager({
            tailscale,
            leases,
            probeTimeoutMs: 10,
            request: async (_url, { signal }) =>
              new Promise((_resolve, reject) => {
                signal.addEventListener("abort", () => {
                  events.push("probe-aborted");
                  reject(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
                });
              })
          })
      })
    ).rejects.toMatchObject({ code: "TAILSCALE_EXTERNAL_PROBE_FAILED" });
    expect(events).toEqual(["probe-aborted", "release:503:listening"]);
    expect((await stat(config.dataDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(config.databasePath)).mode & 0o777).toBe(0o600);

    const rebound = createServer();
    await new Promise<void>((resolve, reject) => {
      rebound.once("error", reject);
      rebound.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => rebound.close(() => resolve()));
    const reopened = await startPlanweaveServer({
      dataDirectory: config.dataDirectory,
      databasePath: config.databasePath,
      busyTimeoutMs: config.limits.busyTimeoutMs
    });
    reopened.close();
  });

  it("secures first-use storage and releases composition ownership after exposure inspect fails", async () => {
    const workspace = await createTestWorkspace(remoteManifest());
    directories.push(workspace.home, workspace.root);
    const port = await availablePort();
    const advertisedOrigin = "https://inspect-failure.tailnet.ts.net";
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
      dataDirectory: join(workspace.root, "inspect-failure-data"),
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
          tokenSha256: hashOperatorToken(`pw_operator_${"I".repeat(43)}`),
          projectIds: [],
          serverAdmin: true
        }
      ]
    });
    await expect(
      serveDistributedServer(config, {
        createExposureLifecycle: () => ({
          async inspect() {
            throw new Error("tailscale_inspect_failed");
          },
          async activate() {
            throw new Error("unexpected_activate");
          },
          async release() {}
        })
      })
    ).rejects.toThrow("tailscale_inspect_failed");
    expect((await stat(config.dataDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(config.databasePath)).mode & 0o777).toBe(0o600);

    const rebound = createServer();
    await new Promise<void>((resolve, reject) => {
      rebound.once("error", reject);
      rebound.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => rebound.close(() => resolve()));
    const reopened = await startPlanweaveServer({
      dataDirectory: config.dataDirectory,
      databasePath: config.databasePath,
      busyTimeoutMs: config.limits.busyTimeoutMs
    });
    reopened.close();
  });
});

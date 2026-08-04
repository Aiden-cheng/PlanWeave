import { randomBytes } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { parseServerConfig, type ServerConfig } from "../config.js";
import { attachTailscaleWebSocketReadiness } from "../exposure/tailscaleWebSocketReadiness.js";
import { createTransportAdmissionPolicy } from "../insecureTransport.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { WebSocketUpgradeRouter } from "../webSocketUpgradeRouter.js";

const servers: Server[] = [];
const networkSockets = new Set<Socket>();

afterEach(async () => {
  for (const socket of networkSockets) socket.destroy();
  networkSockets.clear();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

function config(): ServerConfig {
  return parseServerConfig({
    version: "server-config/v2",
    transport: {
      mode: "tailscale_https",
      listener: { protocol: "http", host: "127.0.0.1", port: 8787 },
      advertisedOrigin: "https://planweave.tailnet.ts.net"
    },
    deployment: {
      topology: "tailscale_https",
      serverOrigin: "https://planweave.tailnet.ts.net",
      allowedClientOrigins: ["https://planweave.tailnet.ts.net"],
      tlsTrust: "system_ca"
    },
    allowedClientOrigins: ["https://planweave.tailnet.ts.net"],
    dataDirectory: "/tmp/planweave-wss-readiness-test",
    trustedProjects: [
      {
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "default",
        projectRoot: "/tmp/planweave-wss-readiness-project"
      }
    ],
    operatorCredentials: [
      {
        operatorId: "admin",
        tokenSha256: hashOperatorToken(`pw_operator_${"E".repeat(43)}`),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
}

function loopbackConfig(): ServerConfig {
  return parseServerConfig({
    version: "server-config/v2",
    transport: {
      mode: "loopback_http",
      listener: { protocol: "http", host: "127.0.0.1", port: 8787 },
      advertisedOrigin: "http://127.0.0.1:8787"
    },
    deployment: {
      topology: "loopback_http",
      serverOrigin: "http://127.0.0.1:8787",
      allowedClientOrigins: ["http://127.0.0.1:8787"],
      tlsTrust: "not_applicable"
    },
    allowedClientOrigins: ["http://127.0.0.1:8787"],
    dataDirectory: "/tmp/planweave-wss-readiness-loopback-test",
    trustedProjects: [
      {
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "default",
        projectRoot: "/tmp/planweave-wss-readiness-project"
      }
    ],
    operatorCredentials: [
      {
        operatorId: "admin",
        tokenSha256: hashOperatorToken(`pw_operator_${"E".repeat(43)}`),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on("connection", (socket) => {
    networkSockets.add(socket);
    socket.once("close", () => networkSockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_server_address_missing");
  return address.port;
}

function connect(port: number, origin: string): Promise<{ opened: boolean; closeCode: number }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/readyz/ws`, { origin });
    let opened = false;
    socket.once("open", () => {
      opened = true;
    });
    socket.once("close", (closeCode) => resolve({ opened, closeCode }));
    socket.once("error", reject);
  });
}

function rejectedStatus(port: number, origin: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const probe = request(
      `http://127.0.0.1:${port}/readyz/ws`,
      {
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          Origin: origin,
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
          "Sec-WebSocket-Version": "13"
        }
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      }
    );
    probe.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("unexpected_websocket_accept"));
    });
    probe.once("error", reject);
    probe.end();
  });
}

describe("Tailscale WebSocket readiness", () => {
  it("returns a real 101 only for the advertised Origin and closes immediately", async () => {
    const server = createServer();
    const serverConfig = config();
    const upgradeRouter = new WebSocketUpgradeRouter(server);
    attachTailscaleWebSocketReadiness({
      config: serverConfig,
      upgradeRouter,
      transportAdmission: createTransportAdmissionPolicy(serverConfig)
    });
    const port = await listen(server);

    await expect(connect(port, "https://planweave.tailnet.ts.net")).resolves.toEqual({
      opened: true,
      closeCode: 1000
    });
    await expect(rejectedStatus(port, "https://attacker.example.com")).resolves.toBe(403);
    upgradeRouter.close();
  });

  it("does not register the readiness route outside tailscale_https", async () => {
    const server = createServer();
    const serverConfig = loopbackConfig();
    const upgradeRouter = new WebSocketUpgradeRouter(server);
    attachTailscaleWebSocketReadiness({
      config: serverConfig,
      upgradeRouter,
      transportAdmission: createTransportAdmissionPolicy(serverConfig)
    });
    const port = await listen(server);

    await expect(rejectedStatus(port, "http://127.0.0.1:8787")).resolves.toBe(404);
    upgradeRouter.close();
  });
});

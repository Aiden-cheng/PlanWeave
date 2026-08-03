import { readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { connect, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  basicManifest,
  createTestWorkspace
} from "../../../../runtime/src/__tests__/promptTestHelpers.js";
import { parseServerConfig } from "../../config.js";
import { AgentHostRepository } from "../../hosts.js";
import { hashOperatorToken } from "../../operatorAuth.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../../serverComposition.js";
import { openServerDatabase } from "../../sqlite.js";

const certificatePath = fileURLToPath(new URL("../fixtures/proxy-test-cert.pem", import.meta.url));
const privateKeyPath = fileURLToPath(new URL("../fixtures/proxy-test-key.pem", import.meta.url));

export const proxyAdminToken = `pw_operator_${"P".repeat(43)}`;
export const proxyAdvertisedOrigin = "https://planweave-proxy-test.example.ts.net";

type ClosableServer = { close(callback: (error?: Error) => void): void };

const servers: ClosableServer[] = [];
const compositions: DistributedServerComposition[] = [];
const directories: string[] = [];
const sockets: WebSocket[] = [];
const proxyTunnels: Array<{ destroy(): void }> = [];

function closeServer(server: ClosableServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function cleanupProxyHarness(): Promise<void> {
  for (const tunnel of proxyTunnels.splice(0)) tunnel.destroy();
  await Promise.all(
    sockets.splice(0).map(
      (socket) =>
        new Promise<void>((resolve) => {
          if (socket.readyState === WebSocket.CLOSED) return resolve();
          socket.once("close", () => resolve());
          socket.terminate();
        })
    )
  );
  for (const composition of compositions.splice(0)) await composition.close();
  for (const server of servers.splice(0).reverse()) await closeServer(server);
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
}

async function listen(server: {
  listen(port: number, host: string, callback: () => void): void;
  address(): unknown;
}): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

export async function setupProxyHarness() {
  const workspace = await createTestWorkspace(basicManifest());
  directories.push(workspace.home, workspace.root);
  const dataDirectory = `${workspace.root}/server-data`;
  const projectId = workspace.init.workspace.id;
  const workspaceId = "workspace-proxy-test";
  const commonConfig = {
    dataDirectory,
    trustedProjects: [{ workspaceId, projectId, canvasId: "default", projectRoot: workspace.root }],
    operatorCredentials: [
      {
        operatorId: "proxy-admin",
        tokenSha256: hashOperatorToken(proxyAdminToken),
        projectIds: [],
        serverAdmin: true
      }
    ]
  } as const;
  const bootstrapServer = createHttpServer();
  const bootstrapConfig = parseServerConfig({
    version: "server-config/v2",
    transport: {
      mode: "loopback_http",
      listener: { protocol: "http", host: "127.0.0.1", port: 7_442 },
      advertisedOrigin: "http://127.0.0.1:7442"
    },
    deployment: {
      topology: "loopback_http",
      serverOrigin: "http://127.0.0.1:7442",
      allowedClientOrigins: ["http://127.0.0.1:7442"],
      tlsTrust: "not_applicable"
    },
    allowedClientOrigins: ["http://127.0.0.1:7442"],
    ...commonConfig
  });
  const bootstrapComposition = await createDistributedServerComposition({
    httpServer: bootstrapServer,
    config: bootstrapConfig
  });
  const bootstrapOrigin = `http://127.0.0.1:${await listen(bootstrapServer)}`;
  const ownerResponse = await fetch(
    `${bootstrapOrigin}/api/v1/projects/${projectId}/human/bootstrap`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Proxy Owner", humanPrincipalId: "proxy-owner" })
    }
  );
  const owner = (await ownerResponse.json()) as { deviceToken: string };
  const invitationResponse = await fetch(
    `${bootstrapOrigin}/api/v1/projects/${projectId}/human/invitations`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.deviceToken}`,
        "content-type": "application/json"
      },
      body: "{}"
    }
  );
  const invitation = (await invitationResponse.json()) as { invitationToken: string };
  const memberResponse = await fetch(
    `${bootstrapOrigin}/api/v1/projects/${projectId}/human/invitations/consume`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invitationToken: invitation.invitationToken,
        displayName: "Proxy Member"
      })
    }
  );
  const member = (await memberResponse.json()) as { deviceToken: string };
  await bootstrapComposition.close();
  await closeServer(bootstrapServer);

  const database = await openServerDatabase(bootstrapConfig.databasePath, 5_000);
  const hosts = new AgentHostRepository(database);
  const host = hosts.register("Proxy Host");
  hosts.bindToWorkspace(host.host.id, workspaceId);
  database.close();

  const backend = createHttpServer();
  servers.push(backend);
  const config = parseServerConfig({
    version: "server-config/v2",
    transport: {
      mode: "tailscale_https",
      listener: { protocol: "http", host: "127.0.0.1", port: 7_443 },
      advertisedOrigin: proxyAdvertisedOrigin
    },
    deployment: {
      topology: "tailscale_https",
      serverOrigin: proxyAdvertisedOrigin,
      allowedClientOrigins: [proxyAdvertisedOrigin],
      tlsTrust: "system_ca"
    },
    allowedClientOrigins: [proxyAdvertisedOrigin],
    ...commonConfig
  });
  const composition = await createDistributedServerComposition({ httpServer: backend, config });
  compositions.push(composition);
  const backendPort = await listen(backend);
  const certificate = await readFile(certificatePath);
  const proxy = createHttpsServer(
    { cert: certificate, key: await readFile(privateKeyPath) },
    (request, response) => {
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: backendPort,
          method: request.method,
          path: request.url,
          headers: request.headers
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        }
      );
      upstream.on("error", (error) => response.destroy(error));
      request.pipe(upstream);
    }
  );
  proxy.on("upgrade", (request, socket, head) => {
    const upstream = connect(backendPort, "127.0.0.1", () => {
      const headerLines: string[] = [];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        headerLines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      }
      upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
      upstream.write(`${headerLines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    proxyTunnels.push(socket, upstream);
    upstream.on("error", (error) => socket.destroy(error));
  });
  servers.push(proxy);
  const proxyPort = await listen(proxy);
  return {
    certificate,
    projectId,
    workspaceId,
    ownerToken: owner.deviceToken,
    memberToken: member.deviceToken,
    hostId: host.host.id,
    hostToken: host.token,
    origin: `https://127.0.0.1:${proxyPort}`,
    wsOrigin: `wss://127.0.0.1:${proxyPort}`
  };
}

export function openProxyWebSocket(input: {
  url: string;
  certificate: Buffer;
  token: string;
  origin?: string;
}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(input.url, {
      ca: input.certificate,
      headers: { Authorization: `Bearer ${input.token}` },
      ...(input.origin ? { origin: input.origin } : {})
    });
    socket.once("open", () => {
      sockets.push(socket);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

export function nextProxyMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return nextProxyMessages(socket, 1).then(([message]) => message);
}

export function nextProxyMessages(
  socket: WebSocket,
  count: number
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for ${count} WebSocket messages.`));
    }, 2_000);
    const onMessage = (data: WebSocket.RawData) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (messages.length !== count) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(messages);
    };
    socket.on("message", onMessage);
  });
}

export function waitForProxyClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

export function proxyRequestStatus(input: {
  origin: string;
  path: string;
  certificate: Buffer;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      `${input.origin}${input.path}`,
      { method: input.method, headers: input.headers, ca: input.certificate },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      }
    );
    request.on("error", reject);
    request.end(input.body);
  });
}

export function proxyWebSocketStatus(input: {
  url: string;
  certificate: Buffer;
  origin?: string;
  token?: string;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(input.url, {
      ca: input.certificate,
      ...(input.token ? { headers: { Authorization: `Bearer ${input.token}` } } : {}),
      ...(input.origin ? { origin: input.origin } : {})
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("open", () => {
      socket.close();
      resolve(101);
    });
    socket.once("error", reject);
  });
}

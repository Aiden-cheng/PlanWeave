import { createServer, type Server as HttpServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { basicManifest, createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { parseServerConfig } from "../config.js";
import { hashOperatorToken } from "../operatorAuth.js";
import { seedOperatorSessions } from "./support/operatorAuthFixture.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../serverComposition.js";

const directories: string[] = [];
const servers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  }
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const workspace = await createTestWorkspace(basicManifest());
  directories.push(workspace.home, workspace.root);
  const httpServer = createServer();
  servers.push(httpServer);
  const operatorToken = `pw_operator_${"P".repeat(43)}`;
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7_443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory: join(workspace.root, "server-data"),
    trustedProjects: [
      { projectId: workspace.init.workspace.id, canvasId: "default", projectRoot: workspace.root }
    ],
    operatorCredentials: [
      {
        operatorId: "presence-test-admin",
        tokenSha256: hashOperatorToken(operatorToken),
        projectIds: [],
        serverAdmin: true
      }
    ]
  });
  const composition = await createDistributedServerComposition({
    httpServer,
    config
  });
  compositions.push(composition);
  await seedOperatorSessions(config.databasePath, config.operatorCredentials);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    wsOrigin: `ws://127.0.0.1:${address.port}`,
    projectId: workspace.init.workspace.id
  };
}

async function bootstrap(origin: string, projectId: string) {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Presence Owner", humanPrincipalId: "presence-owner" })
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { deviceToken: string; device: { deviceCredentialId: string } };
}

async function connect(url: string, token: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("presence_message_timeout")), 3_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

function hello(socket: WebSocket, projectId: string): void {
  socket.send(
    JSON.stringify({
      type: "canvas.presence.hello",
      protocolVersion: 1,
      projectId,
      canvasId: "default"
    })
  );
}

describe("canvas presence WebSocket", () => {
  it("authenticates, returns same-canvas snapshots, and isolates updates to other sessions", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.projectId);
    const url = `${fixture.wsOrigin}/api/v1/projects/${fixture.projectId}/canvases/default/human/presence`;
    const first = await connect(url, owner.deviceToken);
    const second = await connect(url, owner.deviceToken);

    const firstSnapshot = nextMessage(first);
    hello(first, fixture.projectId);
    const firstSnapshotBody = await firstSnapshot;
    expect(firstSnapshotBody.type).toBe("canvas.presence.snapshot");
    expect(firstSnapshotBody.sessions).toEqual([]);
    const secondSnapshot = nextMessage(second);
    hello(second, fixture.projectId);
    const secondSnapshotBody = await secondSnapshot;
    expect(secondSnapshotBody.type).toBe("canvas.presence.snapshot");
    expect((secondSnapshotBody.sessions as unknown[]).length).toBe(1);

    const update = nextMessage(first);
    second.send(
      JSON.stringify({
        type: "canvas.presence.update",
        protocolVersion: 1,
        projectId: fixture.projectId,
        canvasId: "default",
        pointer: { x: 20, y: 30 },
        selectionIds: ["T-001"]
      })
    );
    await expect(update).resolves.toMatchObject({
      type: "canvas.presence.update",
      session: { pointer: { x: 20, y: 30 }, selectionIds: ["T-001"] }
    });
  });

  it("rejects unknown canvas and non-human credentials before upgrade", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.projectId);
    const unknownCanvas = new WebSocket(
      `${fixture.wsOrigin}/api/v1/projects/${fixture.projectId}/canvases/other/human/presence`,
      { headers: { Authorization: `Bearer ${owner.deviceToken}` } }
    );
    const unknownStatus = await new Promise<number>((resolve) => {
      unknownCanvas.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    });
    expect(unknownStatus).toBe(403);
    const unauthorized = new WebSocket(
      `${fixture.wsOrigin}/api/v1/projects/${fixture.projectId}/canvases/default/human/presence`,
      { headers: { Authorization: "Bearer operator-token-not-human" } }
    );
    const unauthorizedStatus = await new Promise<number>((resolve) => {
      unauthorized.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    });
    expect(unauthorizedStatus).toBe(401);
  });

  it("removes a revoked device session and broadcasts leave to the still-authorized peer", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.projectId);
    const invitationResponse = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/invitations`,
      {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${owner.deviceToken}` },
        body: JSON.stringify({})
      }
    );
    expect(invitationResponse.status).toBe(201);
    const invitation = (await invitationResponse.json()) as { invitationToken: string };
    const consumeResponse = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/invitations/consume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          invitationToken: invitation.invitationToken,
          displayName: "Presence Member"
        })
      }
    );
    const consumeBody = await consumeResponse.text();
    expect(consumeResponse.status, consumeBody).toBe(201);
    const secondDevice = JSON.parse(consumeBody) as { deviceToken: string };

    const url = `${fixture.wsOrigin}/api/v1/projects/${fixture.projectId}/canvases/default/human/presence`;
    const revokedSocket = await connect(url, owner.deviceToken);
    const peerSocket = await connect(url, secondDevice.deviceToken);
    const revokedClose = new Promise<number>((resolve) => revokedSocket.once("close", (code) => resolve(code)));
    hello(revokedSocket, fixture.projectId);
    await nextMessage(revokedSocket);
    hello(peerSocket, fixture.projectId);
    await nextMessage(peerSocket);
    const revokedError = nextMessage(revokedSocket);
    const peerLeave = nextMessage(peerSocket);

    const revokeResponse = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/devices/${owner.device.deviceCredentialId}/revoke`,
      { method: "POST", headers: { Authorization: `Bearer ${owner.deviceToken}` } }
    );
    expect(revokeResponse.status).toBe(200);
    await expect(revokedError).resolves.toMatchObject({
      type: "canvas.presence.error",
      code: "unauthorized"
    });
    await expect(peerLeave).resolves.toMatchObject({
      type: "canvas.presence.leave"
    });
    await expect(revokedClose).resolves.toBe(4001);
  });

  it("returns bounded protocol errors for malformed frames and closes the session", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.projectId);
    const url = `${fixture.wsOrigin}/api/v1/projects/${fixture.projectId}/canvases/default/human/presence`;
    const socket = await connect(url, owner.deviceToken);
    hello(socket, fixture.projectId);
    await nextMessage(socket);
    const error = nextMessage(socket);
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
    socket.send("not-json");
    await expect(error).resolves.toMatchObject({
      type: "canvas.presence.error",
      code: "invalid_message"
    });
    await expect(closed).resolves.toBe(4000);
  });
});

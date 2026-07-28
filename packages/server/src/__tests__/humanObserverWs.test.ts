import { createServer, type Server as HttpServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { basicManifest, createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
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

afterEach(async () => {
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const workspace = await createTestWorkspace(basicManifest());
  directories.push(workspace.home, workspace.root);
  const httpServer = createServer();
  servers.push(httpServer);
  const operatorToken = `pw_operator_${"O".repeat(43)}`;
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7_443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory: join(workspace.root, "server-data"),
    trustedProjects: [
      {
        projectId: workspace.init.workspace.id,
        canvasId: "default",
        projectRoot: workspace.root
      }
    ],
    operatorCredentials: [
      {
        operatorId: "observer-admin",
        tokenSha256: hashOperatorToken(operatorToken),
        projectIds: [],
        serverAdmin: true
      }
    ],
    limits: { eventRetentionMaxEvents: 3 }
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
    projectId: workspace.init.workspace.id,
    operatorToken,
    composition
  };
}

function jsonHeaders(token?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function bootstrap(origin: string, projectId: string, principalId: string) {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ displayName: principalId, humanPrincipalId: principalId })
  });
  const body = (await response.json()) as {
    deviceToken: string;
    device: { deviceCredentialId: string };
  };
  expect([200, 201]).toContain(response.status);
  return body;
}

async function createInvitation(origin: string, projectId: string, token: string) {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/human/invitations`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({})
  });
  const body = (await response.json()) as { invitationToken: string; invitation: { invitationId: string } };
  expect(response.status).toBe(201);
  return body;
}

async function connect(url: string, token: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("observer_message_timeout")), 3_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

function nextMessages(socket: WebSocket, count: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const timer = setTimeout(() => reject(new Error("observer_messages_timeout")), 3_000);
    const onMessage = (data: RawData) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
      if (messages.length === count) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(messages);
      }
    };
    socket.on("message", onMessage);
  });
}

function sendHello(socket: WebSocket, projectId: string, lastCursor: number): void {
  socket.send(
    JSON.stringify({
      type: "human.observer.hello",
      protocolVersion: 1,
      projectId,
      lastCursor
    })
  );
}

describe("human observer WSS", () => {
  it("authenticates, pings, fans out durable events, replays, and reports retention gaps", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.projectId, "observer-owner");
    const url = `${fixture.wsOrigin}/api/v1/projects/${fixture.projectId}/human/observe`;
    const first = await connect(url, owner.deviceToken);
    const second = await connect(url, owner.deviceToken);
    sendHello(first, fixture.projectId, 0);
    sendHello(second, fixture.projectId, 0);
    const firstWelcome = await nextMessage(first);
    const secondWelcome = await nextMessage(second);
    expect(firstWelcome).toMatchObject({ type: "human.observer.welcome" });
    expect(secondWelcome).toMatchObject({ type: "human.observer.welcome" });

    first.send(JSON.stringify({ type: "human.observer.ping", protocolVersion: 1 }));
    await expect(nextMessage(first)).resolves.toMatchObject({ type: "human.observer.pong" });

    const firstEventPromise = nextMessage(first);
    const secondEventPromise = nextMessage(second);
    await createInvitation(fixture.origin, fixture.projectId, owner.deviceToken);
    const [firstEvent, secondEvent] = await Promise.all([firstEventPromise, secondEventPromise]);
    expect(firstEvent).toMatchObject({ type: "human.observer.event", kind: "invitation" });
    expect(secondEvent).toMatchObject({ cursor: firstEvent.cursor, kind: "invitation" });
    const eventCursor = Number(firstEvent.cursor);
    first.close();
    second.close();

    await createInvitation(fixture.origin, fixture.projectId, owner.deviceToken);
    const replay = await connect(url, owner.deviceToken);
    const replayMessages = nextMessages(replay, 2);
    sendHello(replay, fixture.projectId, eventCursor);
    const [replayedEvent, replayWelcome] = await replayMessages;
    expect(replayedEvent).toMatchObject({
      type: "human.observer.event",
      kind: "invitation"
    });
    expect(replayWelcome).toMatchObject({ type: "human.observer.welcome" });
    replay.close();

    await createInvitation(fixture.origin, fixture.projectId, owner.deviceToken);
    await createInvitation(fixture.origin, fixture.projectId, owner.deviceToken);
    const gap = await connect(url, owner.deviceToken);
    sendHello(gap, fixture.projectId, 1);
    await expect(nextMessage(gap)).resolves.toMatchObject({
      type: "human.observer.catchup_required",
      reason: "retention_gap"
    });
    gap.close();
  });

  it("rejects invalid upgrades, expires revoked devices, and drains active sessions", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.projectId, "observer-revoked-owner");
    const url = `${fixture.wsOrigin}/api/v1/projects/${fixture.projectId}/human/observe`;
    const rejected = new WebSocket(url, {
      headers: { Authorization: "Bearer operator-token-not-human" }
    });
    const rejectedStatus = await new Promise<number>((resolve) => {
      rejected.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    });
    expect(rejectedStatus).toBe(401);

    const untrusted = new WebSocket(
      `${fixture.wsOrigin}/api/v1/projects/untrusted-project/human/observe`,
      { headers: { Authorization: `Bearer ${owner.deviceToken}` } }
    );
    const untrustedStatus = await new Promise<number>((resolve) => {
      untrusted.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    });
    expect(untrustedStatus).toBe(403);

    const hostPath = new WebSocket(`${fixture.wsOrigin}/agent-hosts/missing-host/connect`, {
      headers: { Authorization: "Bearer pw_host_invalid" }
    });
    const hostStatus = await new Promise<number>((resolve) => {
      hostPath.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    });
    expect(hostStatus).toBe(403);

    const unknown = new WebSocket(`${fixture.wsOrigin}/unknown-upgrade`);
    const unknownStatus = await new Promise<number>((resolve) => {
      unknown.once("unexpected-response", (_request, response) => resolve(response.statusCode));
    });
    expect(unknownStatus).toBe(404);

    const invitation = await createInvitation(
      fixture.origin,
      fixture.projectId,
      owner.deviceToken
    );
    const joined = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/invitations/consume`,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          invitationToken: invitation.invitationToken,
          displayName: "Revoked Member"
        })
      }
    );
    const member = (await joined.json()) as {
      deviceToken: string;
      principal: { humanPrincipalId: string };
    };
    expect(joined.status).toBe(201);
    const memberSocket = await connect(url, member.deviceToken);
    const memberWelcome = nextMessage(memberSocket);
    sendHello(memberSocket, fixture.projectId, 0);
    await memberWelcome;
    const membershipExpired = nextMessage(memberSocket);
    const removed = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/members/${member.principal.humanPrincipalId}/remove`,
      { method: "POST", headers: jsonHeaders(owner.deviceToken), body: JSON.stringify({}) }
    );
    expect(removed.status).toBe(200);
    await expect(membershipExpired).resolves.toMatchObject({
      type: "human.observer.auth_expired"
    });

    const socket = await connect(url, owner.deviceToken);
    sendHello(socket, fixture.projectId, 0);
    await nextMessage(socket);
    const expired = nextMessage(socket);
    const revoke = await fetch(
      `${fixture.origin}/api/v1/projects/${fixture.projectId}/human/devices/${owner.device.deviceCredentialId}/revoke`,
      { method: "POST", headers: jsonHeaders(owner.deviceToken), body: JSON.stringify({}) }
    );
    expect(revoke.status).toBe(200);
    await expect(expired).resolves.toMatchObject({ type: "human.observer.auth_expired" });

    const replacement = await bootstrap(fixture.origin, fixture.projectId, "observer-revoked-owner");
    const draining = await connect(url, replacement.deviceToken);
    sendHello(draining, fixture.projectId, 0);
    await nextMessage(draining);
    const closed = new Promise<number>((resolve) => draining.once("close", resolve));
    await fixture.composition.drainTransports();
    await expect(closed).resolves.toBe(1001);
  });
});

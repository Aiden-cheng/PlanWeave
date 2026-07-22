import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createDistributedCoordination } from "../distributedCoordination.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { serverEventSchema, type ServerEvent } from "../protocol.js";
import { attachAgentHostWebSocketServer, type AgentHostWebSocketServer } from "../wsServer.js";

const directories: string[] = [];
const databases: PlanweaveServer[] = [];
const httpServers: HttpServer[] = [];
const webSocketServers: AgentHostWebSocketServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  }
  await Promise.all(webSocketServers.splice(0).map((server) => server.close()));
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function eventStream(socket: WebSocket) {
  const queued: ServerEvent[] = [];
  const waiting: Array<(event: ServerEvent) => void> = [];
  socket.on("message", (data) => {
    const event = serverEventSchema.parse(JSON.parse(data.toString()));
    const resolve = waiting.shift();
    if (resolve) resolve(event);
    else queued.push(event);
  });
  return {
    next: () =>
      queued.length > 0
        ? Promise.resolve(queued.shift() as ServerEvent)
        : new Promise<ServerEvent>((resolve) => waiting.push(resolve))
  };
}

async function openSocket(url: string, token: string): Promise<WebSocket> {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

describe("agent host WebSocket transport", () => {
  it("authenticates a host and replays unacknowledged mailbox messages", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-ws-"));
    directories.push(dataDirectory);
    const database = await startPlanweaveServer({
      dataDirectory,
      databasePath: join(dataDirectory, "server.sqlite"),
      busyTimeoutMs: 5000
    });
    databases.push(database);
    const coordination = createDistributedCoordination(database.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete: async () => {}, fail: async () => {} }
    });
    const registration = coordination.hosts.register("Remote Linux Host");

    const httpServer = createServer();
    httpServers.push(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected an HTTP port.");
    const transport = attachAgentHostWebSocketServer({
      server: httpServer,
      hosts: coordination.hosts,
      mailbox: coordination.mailbox,
      dispatches: coordination.dispatches,
      heartbeatIntervalMs: 30_000,
      leaseDurationMs: 60_000,
      allowInsecureTransport: true
    });
    webSocketServers.push(transport);
    const url = `ws://127.0.0.1:${address.port}/agent-hosts/${registration.host.id}/connect`;

    const firstSocket = await openSocket(url, registration.token);
    const firstEvents = eventStream(firstSocket);
    firstSocket.send(
      JSON.stringify({
        type: "host.hello",
        protocolVersion: 1,
        lastAcknowledgedSequence: 0,
        capabilities: ["linux", "node-22"],
        capacity: 1
      })
    );
    await expect(firstEvents.next()).resolves.toMatchObject({ type: "host.welcome" });

    const dispatch = coordination.dispatches.dispatchBlock({
      projectId: "project-ws",
      blockRef: "T-001#B-001",
      packageRef: "package://project-ws/v1",
      requiredCapabilities: ["linux"]
    });
    const firstDelivery = await firstEvents.next();
    expect(firstDelivery).toMatchObject({
      type: "mailbox.message",
      command: { type: "execute_block", dispatchId: dispatch.id }
    });
    if (firstDelivery.type !== "mailbox.message") throw new Error("Expected mailbox message.");
    firstSocket.close();
    await new Promise<void>((resolve) => firstSocket.once("close", () => resolve()));

    const secondSocket = await openSocket(url, registration.token);
    const secondEvents = eventStream(secondSocket);
    secondSocket.send(
      JSON.stringify({
        type: "host.hello",
        protocolVersion: 1,
        lastAcknowledgedSequence: 0,
        capabilities: ["linux", "node-22"],
        capacity: 1
      })
    );
    await expect(secondEvents.next()).resolves.toMatchObject({ type: "host.welcome" });
    await expect(secondEvents.next()).resolves.toMatchObject({
      type: "mailbox.message",
      sequence: firstDelivery.sequence,
      messageId: firstDelivery.messageId
    });

    secondSocket.send(
      JSON.stringify({
        type: "mailbox.ack",
        messageId: "ack-1",
        sequence: firstDelivery.sequence
      })
    );
    await expect(secondEvents.next()).resolves.toEqual({
      type: "host.event_ack",
      messageId: "ack-1"
    });
    expect(coordination.hosts.getRequired(registration.host.id).lastAcknowledgedSequence).toBe(
      firstDelivery.sequence
    );
  });
});

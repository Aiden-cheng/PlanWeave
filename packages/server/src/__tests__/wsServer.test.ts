import { createServer, type Server as HttpServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createRemoteBlockRuntimePort, type PlanPackageManifest } from "@planweave-ai/runtime";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import { RemoteRuntimePortRegistry } from "../remoteRuntimeLocator.js";
import { HostEnrollmentService } from "../hostEnrollment.js";
import { hashOperatorToken, OperatorTokenRegistry } from "../operatorAuth.js";
import { RemoteControlService } from "../remoteControlService.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { serverEventSchema, type ServerEvent } from "../protocol.js";
import { attachAgentHostWebSocketServer, type AgentHostWebSocketServer } from "../wsServer.js";
import {
  createTestWorkspace,
  basicManifest
} from "../../../runtime/src/__tests__/promptTestHelpers.js";

const directories: string[] = [];
const databases: PlanweaveServer[] = [];
const httpServers: HttpServer[] = [];
const webSocketServers: AgentHostWebSocketServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

function remoteManifest(): PlanPackageManifest {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" }
    }
  };
  return manifest;
}

async function createWsCoordination() {
  const workspace = await createTestWorkspace(remoteManifest());
  directories.push(workspace.home, workspace.root);
  const dataDirectory = join(workspace.root, "server-data");
  const database = await startPlanweaveServer({
    dataDirectory,
    databasePath: join(dataDirectory, "server.sqlite"),
    busyTimeoutMs: 5000
  });
  databases.push(database);
  const locator = { projectId: workspace.init.workspace.id, canvasId: "default" };
  const registry = new RemoteRuntimePortRegistry();
  registry.bind(locator, createRemoteBlockRuntimePort({ projectRoot: workspace.root }));
  const coordination = createRemoteBlockCoordination(
    database.database,
    {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeResolver: registry,
      inputArtifacts: {
        materialize: async (candidate) => {
          if (candidate.inputArtifacts.length > 0) throw new Error("unexpected_test_artifact");
        }
      },
      artifactContent: { readReport: async () => new Uint8Array() }
    },
    { serverInstanceOwnerToken: database.serverInstanceOwnerToken }
  );
  return { database, coordination, locator };
}

describe("agent host WebSocket transport", () => {
  it("disconnects a server-revoked Host, rejects its old credential, and fences dispatch", async () => {
    const { database, coordination, locator } = await createWsCoordination();
    const registration = coordination.hosts.register("Revocation Host");
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
      acpEvents: coordination.acpEvents,
      interactions: coordination.interactions,
      actions: coordination.actions,
      heartbeatIntervalMs: 30_000,
      leaseDurationMs: 60_000,
      allowInsecureTransport: true
    });
    webSocketServers.push(transport);
    const url = `ws://127.0.0.1:${address.port}/agent-hosts/${registration.host.id}/connect`;
    const socket = await openSocket(url, registration.token);
    const events = eventStream(socket);
    socket.send(
      JSON.stringify({
        type: "host.hello",
        protocolVersion: 1,
        lastAcknowledgedSequence: 0,
        capabilities: ["acp.codex"],
        capacity: 1
      })
    );
    await expect(events.next()).resolves.toMatchObject({ type: "host.welcome" });

    const operatorToken = "operator_revoke_test_token_1234567890";
    const authorization = new OperatorTokenRegistry([
      {
        operatorId: "operator-revoke",
        tokenSha256: hashOperatorToken(operatorToken),
        projectIds: [],
        serverAdmin: true
      }
    ]);
    const principal = authorization.authenticate(`Bearer ${operatorToken}`);
    if (!principal) throw new Error("Expected operator principal.");
    const control = new RemoteControlService({
      authorization,
      enrollments: new HostEnrollmentService(database.database),
      hosts: coordination.hosts,
      operations: coordination.operations,
      dispatches: coordination.dispatches,
      coordinator: coordination.coordinator,
      events: coordination.acpEvents,
      interactions: coordination.interactions,
      disconnectHost: transport.disconnectHost
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    expect(control.revokeHost(principal, registration.host.id)).toMatchObject({
      id: registration.host.id,
      online: false,
      revokedAt: expect.any(String)
    });
    await expect(closed).resolves.toEqual({ code: 4003, reason: "host revoked" });

    const reconnect = new WebSocket(url, {
      headers: { Authorization: `Bearer ${registration.token}` }
    });
    sockets.push(reconnect);
    reconnect.on("error", () => {});
    const rejectedStatus = await new Promise<number>((resolve) => {
      reconnect.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      reconnect.once("open", () => resolve(101));
    });
    expect(rejectedStatus).toBe(401);
    const afterRevoke = await coordination.coordinator.dispatch({
      ...locator,
      blockRef: "T-001#B-001",
      idempotencyKey: "revoked-host-dispatch",
      requestedHostId: registration.host.id
    });
    expect(afterRevoke).toMatchObject({
      status: "awaiting_host",
      operation: { attempt: { hostId: undefined } }
    });
    expect(coordination.mailbox.listAfter(registration.host.id, 0)).toEqual([]);
  });

  it("settles fresh-lease resume acceptance and terminalizes cancellation after load interruption", async () => {
    const { coordination, locator } = await createWsCoordination();
    const registration = coordination.hosts.register("Action Lifecycle Host");
    const httpServer = createServer();
    httpServers.push(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected an HTTP port.");
    webSocketServers.push(
      attachAgentHostWebSocketServer({
        server: httpServer,
        hosts: coordination.hosts,
        mailbox: coordination.mailbox,
        dispatches: coordination.dispatches,
        acpEvents: coordination.acpEvents,
        interactions: coordination.interactions,
        actions: coordination.actions,
        heartbeatIntervalMs: 30_000,
        leaseDurationMs: 60_000,
        allowInsecureTransport: true
      })
    );
    const socket = await openSocket(
      `ws://127.0.0.1:${address.port}/agent-hosts/${registration.host.id}/connect`,
      registration.token
    );
    const events = eventStream(socket);
    socket.send(
      JSON.stringify({
        type: "host.hello",
        protocolVersion: 1,
        lastAcknowledgedSequence: 0,
        capabilities: ["acp.codex"],
        capacity: 1
      })
    );
    await events.next();
    const outcome = await coordination.coordinator.dispatch({
      ...locator,
      blockRef: "T-001#B-001",
      idempotencyKey: "ws-action-lifecycle"
    });
    const execute = await events.next();
    if (execute.type !== "mailbox.message") throw new Error("Expected execute mailbox message.");
    const dispatch = coordination.dispatches.getRequired(outcome.operation.dispatchId);
    const resumeActionId = "resume-action-ws-lifecycle";
    coordination.actions.record({
      actionId: resumeActionId,
      operationId: outcome.operation.id,
      dispatchId: dispatch.id,
      executionAttemptId: dispatch.executionAttemptId,
      expectedAttemptVersion: outcome.operation.attempt.stateVersion,
      kind: "resume_same_session",
      priorLeaseId: "lease-prior-ws-lifecycle",
      leaseId: dispatch.leaseId,
      leaseExpiresAt: dispatch.leaseExpiresAt,
      recovery: { acpSessionId: "session-ws-lifecycle", recoveryId: "recovery-ws-lifecycle" },
      reason: "resume lifecycle transport fixture"
    });
    coordination.actions.transition(resumeActionId, "delivered");
    const resume = coordination.mailbox.enqueueOnce(resumeActionId, registration.host.id, {
      type: "resume_execution",
      protocolVersion: 1,
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      priorRecovery: {
        acpSessionId: "session-ws-lifecycle",
        recoveryId: "recovery-ws-lifecycle"
      },
      leaseExpiresAt: dispatch.leaseExpiresAt
    }).message;
    coordination.mailbox.publish(resume);
    coordination.mailbox.markPublished(resume.messageId);
    const resumeDelivery = await events.next();
    if (resumeDelivery.type !== "mailbox.message") {
      throw new Error("Expected resume mailbox message.");
    }
    for (const message of [execute, resumeDelivery]) {
      socket.send(
        JSON.stringify({
          type: "mailbox.ack",
          protocolVersion: 1,
          messageId: `ack-${message.sequence}`,
          sequence: message.sequence
        })
      );
      await events.next();
    }
    expect(coordination.actions.getRequired(resumeActionId).state).toBe("acknowledged");
    socket.send(
      JSON.stringify({
        type: "dispatch.accepted",
        protocolVersion: 1,
        messageId: "action-accepted",
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId
      })
    );
    await expect(events.next()).resolves.toMatchObject({
      type: "host.event_ack",
      messageId: "action-accepted"
    });
    expect(coordination.dispatches.getRequired(dispatch.id).status).toBe("running");
    expect(coordination.actions.getRequired(resumeActionId).state).toBe("settled");
    await coordination.coordinator.requestCancel(outcome.operation.id, "operator cancelled");
    const cancel = await events.next();
    if (cancel.type !== "mailbox.message") throw new Error("Expected cancel mailbox message.");
    expect(coordination.actions.getRequired(cancel.messageId).state).toBe("delivered");
    socket.send(
      JSON.stringify({
        type: "mailbox.ack",
        protocolVersion: 1,
        messageId: `ack-${cancel.sequence}`,
        sequence: cancel.sequence
      })
    );
    await events.next();
    expect(coordination.actions.getRequired(cancel.messageId).state).toBe("acknowledged");
    socket.send(
      JSON.stringify({
        type: "dispatch.interrupted",
        protocolVersion: 1,
        messageId: "cancel-crash-interrupted",
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        reason: "acp_session_lost",
        resumable: false
      })
    );
    await expect(events.next()).resolves.toMatchObject({
      type: "host.event_ack",
      messageId: "cancel-crash-interrupted"
    });
    expect(coordination.dispatches.getRequired(dispatch.id)).toMatchObject({
      status: "interrupted",
      interruption: { reason: "acp_session_lost", resumable: false }
    });
    socket.send(
      JSON.stringify({
        type: "dispatch.failed",
        protocolVersion: 1,
        messageId: "cancel-terminal",
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        failure: { code: "execution_cancelled", message: "Cancelled.", retryable: false }
      })
    );
    await events.next();
    expect(coordination.actions.getRequired(cancel.messageId).state).toBe("settled");
    expect(coordination.dispatches.getRequired(dispatch.id).status).toBe("cancelled");
  });

  it("authenticates a host and replays unacknowledged mailbox messages", async () => {
    const { database, coordination, locator } = await createWsCoordination();
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
      acpEvents: coordination.acpEvents,
      interactions: coordination.interactions,
      actions: coordination.actions,
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
        capabilities: ["acp.codex"],
        capacity: 1
      })
    );
    await expect(firstEvents.next()).resolves.toMatchObject({ type: "host.welcome" });

    const outcome = await coordination.coordinator.dispatch({
      ...locator,
      blockRef: "T-001#B-001",
      idempotencyKey: "ws-replay"
    });
    const dispatch = coordination.dispatches.getRequired(outcome.operation.dispatchId);
    const firstDelivery = await firstEvents.next();
    expect(firstDelivery).toMatchObject({
      type: "mailbox.message",
      previousSequence: 0,
      command: { type: "execute_block", dispatchId: dispatch.id }
    });
    if (firstDelivery.type !== "mailbox.message") throw new Error("Expected mailbox message.");
    firstSocket.send(
      JSON.stringify({
        type: "dispatch.accepted",
        protocolVersion: 1,
        messageId: "accepted-observations",
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId
      })
    );
    await expect(firstEvents.next()).resolves.toMatchObject({
      type: "host.event_ack",
      messageId: "accepted-observations"
    });
    firstSocket.send(
      JSON.stringify({
        type: "acp.events",
        protocolVersion: 1,
        messageId: "acp-observation-1",
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        acpSessionId: "session-observation-1",
        afterCursor: 0,
        cursor: 1,
        events: [{ cursor: 1, kind: "agent_message", text: "Remote progress" }]
      })
    );
    await expect(firstEvents.next()).resolves.toMatchObject({
      type: "host.event_ack",
      messageId: "acp-observation-1"
    });
    firstSocket.send(
      JSON.stringify({
        type: "interaction.permission_requested",
        protocolVersion: 1,
        messageId: "permission-observation-1",
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        actionId: "permission-observation-1",
        acpSessionId: "session-observation-1",
        expiresAt: "2030-01-01T00:00:00.000Z",
        title: "Permission",
        description: "Allow the tool?"
      })
    );
    await expect(firstEvents.next()).resolves.toMatchObject({
      type: "host.event_ack",
      messageId: "permission-observation-1"
    });
    expect(coordination.acpEvents.replay(dispatch.executionAttemptId, 0).events).toEqual([
      expect.objectContaining({ cursor: 1, kind: "agent_message" })
    ]);
    expect(coordination.interactions.listPending(outcome.operation.id)).toHaveLength(1);
    database.database
      .prepare("UPDATE remote_interactions SET expires_at=? WHERE action_id=?")
      .run("2020-01-01T00:00:00.000Z", "permission-observation-1");
    firstSocket.send(
      JSON.stringify({
        type: "host.heartbeat",
        protocolVersion: 1,
        messageId: "heartbeat-expire-observation",
        activeLeases: [
          {
            dispatchId: dispatch.id,
            leaseId: dispatch.leaseId,
            executionAttemptId: dispatch.executionAttemptId
          }
        ]
      })
    );
    await expect(firstEvents.next()).resolves.toMatchObject({
      type: "mailbox.message",
      command: { type: "interaction.permission_response", decision: "deny" }
    });
    await expect(firstEvents.next()).resolves.toMatchObject({ type: "lease.renewed" });
    await expect(firstEvents.next()).resolves.toMatchObject({
      type: "host.event_ack",
      messageId: "heartbeat-expire-observation"
    });
    firstSocket.close();
    await new Promise<void>((resolve) => firstSocket.once("close", () => resolve()));

    const secondSocket = await openSocket(url, registration.token);
    const secondEvents = eventStream(secondSocket);
    secondSocket.send(
      JSON.stringify({
        type: "host.hello",
        protocolVersion: 1,
        lastAcknowledgedSequence: 0,
        capabilities: ["acp.codex"],
        capacity: 1
      })
    );
    await expect(secondEvents.next()).resolves.toMatchObject({ type: "host.welcome" });
    await expect(secondEvents.next()).resolves.toMatchObject({
      type: "mailbox.message",
      sequence: firstDelivery.sequence,
      previousSequence: 0,
      messageId: firstDelivery.messageId
    });
    await expect(secondEvents.next()).resolves.toMatchObject({
      type: "mailbox.message",
      command: { type: "interaction.permission_response", decision: "deny" }
    });

    secondSocket.send(
      JSON.stringify({
        type: "mailbox.ack",
        protocolVersion: 1,
        messageId: "ack-1",
        sequence: firstDelivery.sequence
      })
    );
    await expect(secondEvents.next()).resolves.toEqual({
      type: "host.event_ack",
      protocolVersion: 1,
      messageId: "ack-1"
    });
    expect(coordination.hosts.getRequired(registration.host.id).lastAcknowledgedSequence).toBe(
      firstDelivery.sequence
    );
  });

  it("expires an offline interaction on reconnect heartbeat and replays its unacknowledged cancel", async () => {
    const { database, coordination, locator } = await createWsCoordination();
    const registration = coordination.hosts.register("Reconnect Expiry Host");
    const httpServer = createServer();
    httpServers.push(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected an HTTP port.");
    webSocketServers.push(
      attachAgentHostWebSocketServer({
        server: httpServer,
        hosts: coordination.hosts,
        mailbox: coordination.mailbox,
        dispatches: coordination.dispatches,
        acpEvents: coordination.acpEvents,
        interactions: coordination.interactions,
        actions: coordination.actions,
        heartbeatIntervalMs: 30_000,
        leaseDurationMs: 60_000,
        allowInsecureTransport: true
      })
    );
    const url = `ws://127.0.0.1:${address.port}/agent-hosts/${registration.host.id}/connect`;
    const first = await openSocket(url, registration.token);
    const firstEvents = eventStream(first);
    first.send(
      JSON.stringify({
        type: "host.hello",
        protocolVersion: 1,
        lastAcknowledgedSequence: 0,
        capabilities: ["acp.codex"],
        capacity: 1
      })
    );
    await firstEvents.next();
    const outcome = await coordination.coordinator.dispatch({
      ...locator,
      blockRef: "T-001#B-001",
      idempotencyKey: "ws-offline-expiry"
    });
    const dispatch = coordination.dispatches.getRequired(outcome.operation.dispatchId);
    await firstEvents.next();
    first.send(
      JSON.stringify({
        type: "dispatch.accepted",
        protocolVersion: 1,
        messageId: "offline-expiry-accepted",
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId
      })
    );
    await firstEvents.next();
    first.send(
      JSON.stringify({
        type: "interaction.elicitation_requested",
        protocolVersion: 1,
        messageId: "offline-expiry-request",
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        actionId: "offline-expiry-action",
        acpSessionId: "offline-expiry-session",
        expiresAt: "2030-01-01T00:00:00.000Z",
        prompt: "Choose",
        options: ["one"]
      })
    );
    await firstEvents.next();
    first.close();
    await new Promise<void>((resolve) => first.once("close", () => resolve()));
    database.database
      .prepare("UPDATE remote_interactions SET expires_at=? WHERE action_id=?")
      .run("2020-01-01T00:00:00.000Z", "offline-expiry-action");

    const second = await openSocket(url, registration.token);
    const secondEvents = eventStream(second);
    second.send(
      JSON.stringify({
        type: "host.hello",
        protocolVersion: 1,
        lastAcknowledgedSequence: 0,
        capabilities: ["acp.codex"],
        capacity: 1
      })
    );
    await secondEvents.next();
    await secondEvents.next();
    second.send(
      JSON.stringify({
        type: "host.heartbeat",
        protocolVersion: 1,
        messageId: "offline-expiry-heartbeat",
        activeLeases: [
          {
            dispatchId: dispatch.id,
            leaseId: dispatch.leaseId,
            executionAttemptId: dispatch.executionAttemptId
          }
        ]
      })
    );
    const expiryDelivery = await secondEvents.next();
    expect(expiryDelivery).toMatchObject({
      type: "mailbox.message",
      command: { type: "interaction.elicitation_response", outcome: "cancelled" }
    });
    await secondEvents.next();
    await secondEvents.next();
    second.close();
    await new Promise<void>((resolve) => second.once("close", () => resolve()));

    const third = await openSocket(url, registration.token);
    const thirdEvents = eventStream(third);
    third.send(
      JSON.stringify({
        type: "host.hello",
        protocolVersion: 1,
        lastAcknowledgedSequence: 0,
        capabilities: ["acp.codex"],
        capacity: 1
      })
    );
    await thirdEvents.next();
    await thirdEvents.next();
    await expect(thirdEvents.next()).resolves.toMatchObject({
      type: "mailbox.message",
      messageId: expiryDelivery.type === "mailbox.message" ? expiryDelivery.messageId : undefined,
      command: { type: "interaction.elicitation_response", outcome: "cancelled" }
    });
  });

  it("persists interruption before ACK and rejects unsupported live events without ACK", async () => {
    const { database, coordination, locator } = await createWsCoordination();
    const registration = coordination.hosts.register("Interruption Host");
    const httpServer = createServer();
    httpServers.push(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected an HTTP port.");
    webSocketServers.push(
      attachAgentHostWebSocketServer({
        server: httpServer,
        hosts: coordination.hosts,
        mailbox: coordination.mailbox,
        dispatches: coordination.dispatches,
        acpEvents: coordination.acpEvents,
        interactions: coordination.interactions,
        actions: coordination.actions,
        heartbeatIntervalMs: 30_000,
        leaseDurationMs: 60_000,
        allowInsecureTransport: true
      })
    );
    const socket = await openSocket(
      `ws://127.0.0.1:${address.port}/agent-hosts/${registration.host.id}/connect`,
      registration.token
    );
    const events = eventStream(socket);
    socket.send(
      JSON.stringify({
        type: "host.hello",
        protocolVersion: 1,
        lastAcknowledgedSequence: 0,
        capabilities: ["acp.codex"],
        capacity: 1
      })
    );
    await expect(events.next()).resolves.toMatchObject({ type: "host.welcome" });
    const outcome = await coordination.coordinator.dispatch({
      ...locator,
      blockRef: "T-001#B-001",
      idempotencyKey: "ws-interruption"
    });
    const dispatch = coordination.dispatches.getRequired(outcome.operation.dispatchId);
    await expect(events.next()).resolves.toMatchObject({ type: "mailbox.message" });
    socket.send(
      JSON.stringify({
        type: "dispatch.accepted",
        protocolVersion: 1,
        messageId: "accepted-interruption",
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId
      })
    );
    await expect(events.next()).resolves.toMatchObject({
      type: "host.event_ack",
      messageId: "accepted-interruption"
    });

    socket.send(
      JSON.stringify({
        type: "dispatch.interrupted",
        protocolVersion: 1,
        messageId: "interrupted-1",
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        reason: "host_restart",
        resumable: true,
        recovery: { acpSessionId: "session-1", recoveryId: "recovery-1" }
      })
    );
    await expect(events.next()).resolves.toMatchObject({
      type: "host.event_ack",
      messageId: "interrupted-1"
    });
    expect(coordination.dispatches.getRequired(dispatch.id)).toMatchObject({
      status: "interrupted",
      interruption: {
        reason: "host_restart",
        resumable: true,
        recovery: { acpSessionId: "session-1", recoveryId: "recovery-1" }
      }
    });
    expect(
      database.database
        .prepare(
          "SELECT type FROM dispatch_events WHERE dispatch_id=? ORDER BY sequence DESC LIMIT 1"
        )
        .get(dispatch.id)?.type
    ).toBe("dispatch.interrupted");

    const rawDiagnostic = `/Users/private/server.sqlite token=server-secret-value ${"x".repeat(20_000)}`;
    vi.spyOn(coordination.dispatches, "recordProgress").mockImplementationOnce(() => {
      throw new Error(rawDiagnostic);
    });
    socket.send(
      JSON.stringify({
        type: "dispatch.progress",
        protocolVersion: 1,
        messageId: "adversarial-progress",
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        percent: 50
      })
    );
    const rejection = await events.next();
    expect(rejection).toEqual({
      type: "protocol.error",
      protocolVersion: 1,
      code: "event_rejected",
      message: "The server rejected the host event."
    });
    expect(JSON.stringify(rejection)).not.toContain("server.sqlite");
    expect(JSON.stringify(rejection)).not.toContain("server-secret-value");

    socket.send(
      JSON.stringify({
        type: "host.heartbeat",
        protocolVersion: 1,
        messageId: "heartbeat-after-adversarial-error",
        activeLeases: []
      })
    );
    await expect(events.next()).resolves.toMatchObject({
      type: "host.event_ack",
      messageId: "heartbeat-after-adversarial-error"
    });

    const unsupportedEvents = [
      {
        type: "lease.renew",
        messageId: "unsupported-renewal"
      },
      {
        type: "acp.events",
        messageId: "unsupported-acp",
        afterCursor: 0,
        cursor: 1,
        events: [{ cursor: 1, kind: "agent_message", text: "recovered" }]
      },
      {
        type: "interaction.permission_requested",
        messageId: "unsupported-permission",
        actionId: "permission-1",
        title: "Permission",
        description: "Allow this operation?"
      },
      {
        type: "interaction.elicitation_requested",
        messageId: "unsupported-elicitation",
        actionId: "elicitation-1",
        prompt: "Choose",
        options: ["one"]
      },
      {
        type: "interaction.authentication_required",
        messageId: "unsupported-authentication",
        actionId: "authentication-1",
        agentProfileId: "acp.codex",
        hostInstruction: "Sign in locally."
      }
    ];
    for (const [index, unsupported] of unsupportedEvents.entries()) {
      socket.send(
        JSON.stringify({
          protocolVersion: 1,
          dispatchId: dispatch.id,
          leaseId: dispatch.leaseId,
          executionAttemptId: dispatch.executionAttemptId,
          ...unsupported
        })
      );
      await expect(events.next()).resolves.toMatchObject({
        type: "protocol.error",
        code: "event_rejected",
        message: "The server rejected the host event."
      });
      const heartbeatMessageId = `heartbeat-after-rejection-${index}`;
      socket.send(
        JSON.stringify({
          type: "host.heartbeat",
          protocolVersion: 1,
          messageId: heartbeatMessageId,
          activeLeases: []
        })
      );
      await expect(events.next()).resolves.toMatchObject({
        type: "host.event_ack",
        messageId: heartbeatMessageId
      });
    }
  });
});

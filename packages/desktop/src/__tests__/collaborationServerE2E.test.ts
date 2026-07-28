import { createServer, type Server as HttpServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { PlanPackageManifest } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  CollaborationClient,
  type CollaborationObserverHandlers,
  type CollaborationWebSocketConstructor
} from "../main/collaboration/CollaborationClient.js";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { parseServerConfig } from "../../../server/src/config.js";
import { hashOperatorToken } from "../../../server/src/operatorAuth.js";
import { seedOperatorSessions } from "../../../server/src/__tests__/support/operatorAuthFixture.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../../../server/src/serverComposition.js";

const directories: string[] = [];
const servers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const clients: CollaborationClient[] = [];
const hostSockets: WebSocket[] = [];
const compositionAdminToken = `pw_operator_${"D".repeat(43)}`;

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
  for (const socket of hostSockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  }
  for (const composition of compositions.splice(0)) await composition.close();
  await Promise.all(
    servers
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
    "codex-acp": {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" }
    }
  };
  return manifest;
}

async function setup() {
  const workspace = await createTestWorkspace(remoteManifest());
  directories.push(workspace.home, workspace.root);
  const projectId = workspace.init.workspace.id;
  const httpServer = createServer();
  servers.push(httpServer);
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7_443 },
    publicUrl: "http://127.0.0.1:7443",
    allowInsecureDevelopment: true,
    dataDirectory: join(workspace.root, "server-data"),
    trustedProjects: [{ projectId, canvasId: "default", projectRoot: workspace.root }],
    operatorCredentials: [
      {
        operatorId: "desktop-e2e-admin",
        tokenSha256: hashOperatorToken(compositionAdminToken),
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
  return { projectId, origin: `http://127.0.0.1:${address.port}`, adminToken: compositionAdminToken };
}

function clientFor(origin: string, projectId: string, token?: string): CollaborationClient {
  const client = new CollaborationClient({
    profile: {
      profileId: `desktop-e2e-${token ? "authenticated" : "anonymous"}`,
      displayName: "Desktop E2E",
      serverBaseUrl: `${origin}/`,
      projectId,
      allowInsecureTransport: true
    },
    credential: { getDeviceToken: () => token },
    WebSocketImpl: WebSocket as unknown as CollaborationWebSocketConstructor
  });
  clients.push(client);
  return client;
}

function nextHostMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("host_message_timeout")), 5_000);
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    socket.once("error", onError);
    socket.once("message", (data) => {
      clearTimeout(timer);
      socket.off("error", onError);
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function connectEnrolledHost(origin: string, adminToken: string) {
  const grantResponse = await fetch(`${origin}/api/v1/host-enrollments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      credentialExpiresAt: new Date(Date.now() + 3_600_000).toISOString()
    })
  });
  expect(grantResponse.status).toBe(201);
  const grant = (await grantResponse.json()) as { enrollmentCode: string; workspaceId: string };
  const credentialToken = `pw_host_${"D".repeat(43)}`;
  const enrollmentRequest = {
    type: "host.enrollment.request",
    protocolVersion: 1,
    enrollmentCode: grant.enrollmentCode,
    enrollmentAttemptId: "desktop-e2e-host-enrollment",
    credentialToken,
    displayName: "Desktop E2E Host",
    capabilities: ["acp.codex", "acp.session.load"],
    capacity: 1
  };
  const exchangeResponse = await fetch(`${origin}/agent-hosts/enrollments/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(enrollmentRequest)
  });
  expect(exchangeResponse.status).toBe(200);
  const exchange = (await exchangeResponse.json()) as { hostId: string };
  const socket = new WebSocket(
    `${origin.replace(/^http:/, "ws:")}/agent-hosts/${exchange.hostId}/connect?workspaceId=${encodeURIComponent(grant.workspaceId)}`,
    { headers: { Authorization: `Bearer ${credentialToken}` } }
  );
  hostSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const welcomePromise = nextHostMessage(socket);
  socket.send(
    JSON.stringify({
      type: "host.hello",
      protocolVersion: 1,
      lastAcknowledgedSequence: 0,
      capabilities: enrollmentRequest.capabilities,
      capacity: 1
    })
  );
  await expect(welcomePromise).resolves.toMatchObject({ type: "host.welcome" });
  return {
    socket,
    hostId: exchange.hostId,
    workspaceId: grant.workspaceId,
    next: () => nextHostMessage(socket)
  };
}

function startObserverAndWait(
  client: CollaborationClient,
  handlers: CollaborationObserverHandlers = {},
  options?: { cursor?: number }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("observer_status_timeout")), 5_000);
    client.startObserver({
      ...handlers,
      onStatus: (status) => {
        handlers.onStatus?.(status);
        if (status.state === "connected") {
          clearTimeout(timer);
          resolve();
        } else if (status.state === "auth_expired" || status.state === "failed") {
          clearTimeout(timer);
          reject(new Error(`observer_${status.state}_${status.code}`));
        }
      }
    }, options);
  });
}

async function createIdentityFixture() {
  const fixture = await setup();
  const anonymous = clientFor(fixture.origin, fixture.projectId);
  const ownerBootstrap = await anonymous.bootstrapOwner({
      displayName: "Desktop Owner",
      humanPrincipalId: "desktop-e2e-owner"
  });
  if (!ownerBootstrap.deviceToken) throw new Error("owner_bootstrap_missing_device_token");
  const owner = clientFor(fixture.origin, fixture.projectId, ownerBootstrap.deviceToken);
  const invitation = await owner.createInvitation();
  const memberBootstrap = await anonymous.consumeInvitation({
    invitationToken: invitation.invitationToken,
    displayName: "Desktop Member"
  });
  const member = clientFor(fixture.origin, fixture.projectId, memberBootstrap.deviceToken);
  return { fixture, anonymous, owner, member, ownerBootstrap, memberBootstrap };
}

const blockWorkItem = {
  kind: "block" as const,
  canvasId: "default",
  blockRef: "T-001#B-001"
};

describe("Desktop CollaborationClient against the Server composition", () => {
  it("covers identity, membership, assignment, and comment mutations", async () => {
    const { owner, member, ownerBootstrap, memberBootstrap } = await createIdentityFixture();

    const revocableInvitation = await owner.createInvitation();
    const openInvitations = await owner.listInvitations({ openOnly: true });
    expect(openInvitations.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ invitationId: revocableInvitation.invitation.invitationId })
      ])
    );
    const revokedInvitation = await owner.revokeInvitation(
      revocableInvitation.invitation.invitationId
    );
    expect(revokedInvitation.revokedAt).toBeDefined();

    expect((await member.listMembers()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ humanPrincipalId: memberBootstrap.principal.humanPrincipalId })
      ])
    );
    expect((await owner.listMembers()).items.map((item) => item.humanPrincipalId)).toEqual(
      expect.arrayContaining([
        ownerBootstrap.principal.humanPrincipalId,
        memberBootstrap.principal.humanPrincipalId
      ])
    );
    const projectDevices = await owner.listDevices({ scope: "project" });
    expect(projectDevices.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deviceCredentialId: memberBootstrap.device.deviceCredentialId })
      ])
    );
    await owner.revokeDevice(memberBootstrap.device.deviceCredentialId);
    expect(
      (await owner.listDevices({ scope: "project" })).items.find(
        (device) => device.deviceCredentialId === memberBootstrap.device.deviceCredentialId
      )?.revokedAt
    ).toBeDefined();
    await expect(member.listAssignments({ canvasId: "default" })).rejects.toMatchObject({
      kind: "auth",
      code: "work_auth_unauthenticated",
      httpStatus: 401
    });

    const assignment = await owner.updateAssignment({
      workItem: blockWorkItem,
      target: { kind: "human", humanPrincipalId: memberBootstrap.principal.humanPrincipalId },
      expectedRevision: 0,
      reason: "Desktop network assignment"
    });
    expect(assignment.revision).toBe(1);
    expect((await owner.getAssignment(blockWorkItem)).target).toEqual(assignment.target);
    expect((await owner.listAssignments({ canvasId: "default" })).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ workItem: blockWorkItem, revision: 1 })])
    );
    expect((await owner.listEligibleAssignees(blockWorkItem)).humans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          humanPrincipalId: memberBootstrap.principal.humanPrincipalId,
          membershipActive: true
        })
      ])
    );
    await expect(
      owner.updateAssignment({
        workItem: blockWorkItem,
        target: { kind: "unassigned" },
        expectedRevision: 0
      })
    ).rejects.toMatchObject({ kind: "conflict", httpStatus: 409 });

    const comment = await owner.createComment({
      workItem: blockWorkItem,
      body: "Desktop network comment"
    });
    const edited = await owner.editComment({
      commentId: comment.commentId,
      body: "Desktop edited comment",
      expectedRevision: 1
    });
    expect(edited.revision).toBe(2);
    expect(edited.body).toBe("Desktop edited comment");
    const tombstoned = await owner.tombstoneComment({
      commentId: comment.commentId,
      expectedRevision: 2,
      reason: "Desktop test tombstone"
    });
    expect(tombstoned.tombstoned).toBe(true);
    expect((await owner.listComments({ workItem: blockWorkItem, limit: 50 })).items).toEqual([]);
    expect(
      (await owner.listComments({
        workItem: blockWorkItem,
        limit: 50,
        includeTombstoned: true
      })).items
    ).toEqual(expect.arrayContaining([expect.objectContaining({ tombstoned: true })]));
    expect((await owner.listActivity({ workItem: blockWorkItem, limit: 50 })).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "comment_tombstoned",
          summary: expect.objectContaining({ commentId: comment.commentId })
        })
      ])
    );

    await owner.promoteOwner(memberBootstrap.principal.humanPrincipalId);
    expect(
      (await owner.listMembers()).items.find(
        (item) => item.humanPrincipalId === memberBootstrap.principal.humanPrincipalId
      )?.role
    ).toBe("owner");
    await owner.demoteOwner(memberBootstrap.principal.humanPrincipalId);
    expect(
      (await owner.listMembers()).items.find(
        (item) => item.humanPrincipalId === memberBootstrap.principal.humanPrincipalId
      )?.role
    ).toBe("member");
    await owner.removeMember(memberBootstrap.principal.humanPrincipalId);
    expect((await owner.listMembers()).items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ humanPrincipalId: memberBootstrap.principal.humanPrincipalId })
      ])
    );
  });

  it("maps remote action, event, interaction, and error routes through the client", async () => {
    const { fixture, owner } = await createIdentityFixture();
    const host = await connectEnrolledHost(fixture.origin, fixture.adminToken);
    const executionTarget = await owner.updateExecutionTarget({
      schemaVersion: "execution-target/v1",
      scope: {
        kind: "block",
        workspaceId: host.workspaceId,
        projectId: fixture.projectId,
        canvasId: blockWorkItem.canvasId,
        blockRef: blockWorkItem.blockRef
      },
      target: { kind: "exact_host", hostId: host.hostId },
      expectedRevision: 0
    });
    const remoteDispatch = owner.dispatchRemoteOperation({
      schemaVersion: "remote-run/v2",
      projectId: fixture.projectId,
      canvasId: blockWorkItem.canvasId,
      blockRef: blockWorkItem.blockRef,
      idempotencyKey: "desktop-e2e-remote-operation",
      expectedResponsibilityRevision: 0,
      expectedReviewerRevision: 0,
      expectedExecutionTargetRevision: executionTarget.revision
    });
    const execute = await host.next();
    expect(execute.type).toBe("mailbox.message");
    const command = execute.command as {
      dispatchId: string;
      leaseId: string;
      executionAttemptId: string;
    };
    const sequence = execute.sequence as number;
    host.socket.send(
      JSON.stringify({
        type: "mailbox.ack",
        protocolVersion: 1,
        messageId: "desktop-e2e-mailbox-ack",
        sequence
      })
    );
    await expect(host.next()).resolves.toMatchObject({ type: "host.event_ack" });
    host.socket.send(
      JSON.stringify({
        type: "dispatch.accepted",
        protocolVersion: 1,
        messageId: "desktop-e2e-dispatch-accepted",
        dispatchId: command.dispatchId,
        leaseId: command.leaseId,
        executionAttemptId: command.executionAttemptId
      })
    );
    await expect(host.next()).resolves.toMatchObject({ type: "host.event_ack" });
    host.socket.send(
      JSON.stringify({
        type: "acp.events",
        protocolVersion: 1,
        messageId: "desktop-e2e-acp-events",
        dispatchId: command.dispatchId,
        leaseId: command.leaseId,
        executionAttemptId: command.executionAttemptId,
        acpSessionId: "desktop-e2e-acp-session",
        afterCursor: 0,
        cursor: 1,
        events: [{ cursor: 1, kind: "agent_message", text: "desktop e2e event" }]
      })
    );
    await expect(host.next()).resolves.toMatchObject({ type: "host.event_ack" });
    const remote = await remoteDispatch;
    expect((await owner.observeRemoteOperation(remote.operationId)).operationId).toBe(
      remote.operationId
    );

    const replayedEvents = await owner.replayRemoteOperationEvents(remote.operationId, {
      afterCursor: 0
    });
    expect(replayedEvents.afterCursor).toBe(0);
    expect(replayedEvents.cursor).toBe(1);
    expect(replayedEvents.highWatermark).toBe(1);
    expect(replayedEvents.events).toEqual([
      expect.objectContaining({
        cursor: 1,
        kind: "agent_message",
        text: "desktop e2e event"
      })
    ]);
    const events = await owner.replayRemoteOperationEvents(remote.operationId, { afterCursor: 1 });
    expect(events).toMatchObject({ afterCursor: 1, cursor: 1, events: [], hasMore: false });
    const interactions = await owner.listRemoteOperationInteractions(remote.operationId, {
      cursor: 0,
      limit: 50
    });
    expect(interactions).toEqual({ items: [], nextCursor: null });

    await expect(
      owner.executeRemoteOperationAction(remote.operationId, {
        kind: "cancel",
        actionId: "desktop-e2e-cancel",
        operationId: remote.operationId,
        dispatchId: remote.dispatchId,
        executionAttemptId: remote.executionAttemptId,
        expectedAttemptVersion: remote.attempt.stateVersion,
        leaseId: "desktop-e2e-stale-lease",
        reason: "No active host lease in composition fixture"
      })
    ).rejects.toMatchObject({ kind: "conflict", httpStatus: 409 });
    await expect(
      owner.settleRemoteOperationInteraction(remote.operationId, {
        type: "interaction.authentication_action",
        action: "cancel",
        actionId: "desktop-e2e-interaction",
        dispatchId: remote.dispatchId,
        executionAttemptId: remote.executionAttemptId,
        leaseId: "desktop-e2e-stale-lease",
        acpSessionId: "desktop-e2e-acp-session"
      })
    ).rejects.toMatchObject({ kind: "not_found", httpStatus: 404 });
    await expect(owner.observeRemoteOperation("missing-operation")).rejects.toMatchObject({
      kind: "not_found",
      httpStatus: 404
    });
  });

  it("replays only disconnected observer events and reports catchup before refetch", async () => {
    const { owner } = await createIdentityFixture();
    await startObserverAndWait(owner);
    const cursorBeforeDisconnect = owner.lastObserverCursor();
    owner.stopObserver();

    const disconnectedComment = await owner.createComment({
      workItem: blockWorkItem,
      body: "Desktop disconnected observer comment"
    });
    const replayedEvents: Array<{
      cursor: number;
      previousCursor: number;
      kind: string;
      commentId?: string;
    }> = [];
    let replayResolve: ((events: typeof replayedEvents) => void) | undefined;
    let replayTimer: ReturnType<typeof setTimeout> | undefined;
    const replayPromise = new Promise<typeof replayedEvents>((resolve, reject) => {
      replayResolve = resolve;
      replayTimer = setTimeout(() => reject(new Error("observer_replay_timeout")), 5_000);
    });
    await startObserverAndWait(
      owner,
      {
        onEvent: (event) => {
          replayedEvents.push(event);
          if (replayedEvents.length === 2) {
            if (replayTimer) clearTimeout(replayTimer);
            replayResolve?.(replayedEvents);
          }
        }
      },
      { cursor: cursorBeforeDisconnect }
    );
    const replay = await replayPromise;
    expect(replay.map((event) => event.cursor)).toEqual([
      cursorBeforeDisconnect + 1,
      cursorBeforeDisconnect + 2
    ]);
    expect(replay.map((event) => event.previousCursor)).toEqual([
      cursorBeforeDisconnect,
      cursorBeforeDisconnect + 1
    ]);
    expect(replay.every((event) => event.commentId === disconnectedComment.commentId)).toBe(true);
    owner.stopObserver();

    const catchupPromise = new Promise<{
      reason: string;
      resumeCursor: number;
    }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("observer_catchup_timeout")), 5_000);
      owner.startObserver(
        {
          onCatchupRequired: (message) => {
            clearTimeout(timer);
            resolve(message);
          },
          onStatus: (status) => {
            if (status.state === "auth_expired" || status.state === "failed") {
              clearTimeout(timer);
              reject(new Error(`observer_${status.state}_${status.code}`));
            }
          }
        },
        { cursor: owner.lastObserverCursor() + 100 }
      );
    });
    const catchup = await catchupPromise;
    expect(catchup.reason).toBe("cursor_ahead");
    owner.stopObserver();

    const comments = await owner.listComments({ workItem: blockWorkItem, limit: 50 });
    expect(comments.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ commentId: disconnectedComment.commentId })])
    );
    const activity = await owner.listActivity({ workItem: blockWorkItem, limit: 50 });
    expect(activity.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "comment_created",
          summary: expect.objectContaining({ commentId: disconnectedComment.commentId })
        })
      ])
    );
  });
});

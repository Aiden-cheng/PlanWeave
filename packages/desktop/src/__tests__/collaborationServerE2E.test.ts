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
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../../../server/src/serverComposition.js";

const directories: string[] = [];
const servers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const clients: CollaborationClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
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
  const composition = await createDistributedServerComposition({
    httpServer,
    config: parseServerConfig({
      version: "server-config/v1",
      bind: { host: "127.0.0.1", port: 7_443 },
      publicUrl: "http://127.0.0.1:7443",
      allowInsecureDevelopment: true,
      dataDirectory: join(workspace.root, "server-data"),
      trustedProjects: [{ projectId, canvasId: "default", projectRoot: workspace.root }],
      operatorCredentials: [
        {
          operatorId: "desktop-e2e-admin",
          tokenSha256: hashOperatorToken(
            "desktop_e2e_admin_token_abcdefghijklmnopqrstuvwxyz"
          ),
          projectIds: [],
          serverAdmin: true
        }
      ]
    })
  });
  compositions.push(composition);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Expected HTTP address");
  return { projectId, origin: `http://127.0.0.1:${address.port}` };
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

function startObserverAndWait(
  client: CollaborationClient,
  handlers: CollaborationObserverHandlers = {}
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
    });
  });
}

describe("Desktop CollaborationClient against the Server composition", () => {
  it("covers human, assignment, comment, observer, and remote-operation routes", async () => {
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
    expect((await member.listMembers()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ humanPrincipalId: memberBootstrap.principal.humanPrincipalId })
      ])
    );
    const members = await owner.listMembers();
    expect(members.items.map((member) => member.humanPrincipalId)).toEqual(
      expect.arrayContaining([
        ownerBootstrap.principal.humanPrincipalId,
        memberBootstrap.principal.humanPrincipalId
      ])
    );

    const workItem = {
      kind: "block" as const,
      canvasId: "default",
      blockRef: "T-001#B-001"
    };
    const assignment = await owner.updateAssignment({
      workItem,
      target: { kind: "human", humanPrincipalId: memberBootstrap.principal.humanPrincipalId },
      expectedRevision: 0,
      reason: "Desktop network assignment"
    });
    expect(assignment.revision).toBe(1);
    expect((await owner.getAssignment(workItem)).target).toEqual(assignment.target);
    expect((await owner.listAssignments({ canvasId: "default" })).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ workItem, revision: 1 })])
    );
    expect((await owner.listEligibleAssignees(workItem)).humans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          humanPrincipalId: memberBootstrap.principal.humanPrincipalId,
          membershipActive: true
        })
      ])
    );

    const comment = await owner.createComment({
      workItem,
      body: "Desktop network comment"
    });
    expect((await owner.listComments({ workItem, limit: 50 })).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ commentId: comment.commentId })])
    );
    expect((await owner.listActivity({ workItem, limit: 50 })).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "comment_created",
          summary: expect.objectContaining({ commentId: comment.commentId })
        })
      ])
    );

    let resolveEvent: ((event: unknown) => void) | undefined;
    let eventTimer: ReturnType<typeof setTimeout> | undefined;
    const eventPromise = new Promise<unknown>((resolve, reject) => {
      resolveEvent = (event) => {
        if (eventTimer) clearTimeout(eventTimer);
        resolve(event);
      };
      eventTimer = setTimeout(() => reject(new Error("observer_event_timeout")), 5_000);
    });
    await startObserverAndWait(owner, {
      onEvent: (event) => {
        if (event.kind === "comment") resolveEvent?.(event);
      }
    });
    const observedComment = await owner.createComment({
      workItem,
      body: "Desktop observer invalidation"
    });
    const observerEvent = (await eventPromise) as {
      type: string;
      kind: string;
      commentId?: string;
      workItem?: typeof workItem;
    };
    expect(observerEvent).toMatchObject({
      type: "human.observer.event",
      kind: "comment",
      commentId: observedComment.commentId,
      workItem
    });

    const remote = await owner.dispatchRemoteOperation({
      canvasId: "default",
      blockRef: "T-001#B-001",
      idempotencyKey: "desktop-e2e-remote-operation",
      allowHumanOverride: true
    });
    expect((await owner.observeRemoteOperation(remote.operationId)).operationId).toBe(
      remote.operationId
    );
    await expect(owner.observeRemoteOperation("missing-operation")).rejects.toMatchObject({
      kind: "not_found",
      httpStatus: 404
    });
  });
});

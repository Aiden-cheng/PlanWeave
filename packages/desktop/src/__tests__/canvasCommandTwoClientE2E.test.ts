import { createServer, type Server as HttpServer } from "node:http";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  CANVAS_COMMAND_PROTOCOL_VERSION,
  exampleHumanDeviceToken
} from "@planweave-ai/collaboration-contracts";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { parseServerConfig } from "../../../server/src/config.js";
import { hashOperatorToken } from "../../../server/src/operatorAuth.js";
import { legacyWorkspaceIdForProject } from "../../../server/src/__tests__/support/legacyWorkspaceId.js";
import { seedOperatorSessions } from "../../../server/src/__tests__/support/operatorAuthFixture.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "../../../server/src/serverComposition.js";
import {
  CollaborationClient,
  type CollaborationWebSocketConstructor
} from "../main/collaboration/CollaborationClient.js";
import {
  CanvasCommandController,
  type CanvasCommandBridge,
  type CanvasCommandLabels
} from "../renderer/collaboration/CanvasCommandController.js";

const directories: string[] = [];
const servers: HttpServer[] = [];
const compositions: DistributedServerComposition[] = [];
const clients: CollaborationClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose();
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

const labels: CanvasCommandLabels = {
  staleRevision: (expected, authoritative) => `stale:${expected}->${authoritative}`,
  rejected: (code) => `rejected:${code}`,
  reconnectFailed: (code) => `reconnect:${code}`,
  notConnected: "not-connected"
};

async function setup() {
  const workspace = await createTestWorkspace(basicManifest());
  directories.push(workspace.home, workspace.root);
  const projectId = workspace.init.workspace.id;
  const httpServer = createServer();
  servers.push(httpServer);
  const adminToken = `pw_operator_${"C".repeat(43)}`;
  const config = parseServerConfig({
    version: "server-config/v1",
    bind: { host: "127.0.0.1", port: 7_445 },
    publicUrl: "http://127.0.0.1:7445",
    allowInsecureDevelopment: true,
    dataDirectory: join(workspace.root, "server-data"),
    trustedProjects: [
      {
        workspaceId: legacyWorkspaceIdForProject(projectId),
        projectId,
        canvasId: "default",
        projectRoot: workspace.root
      }
    ],
    operatorCredentials: [
      {
        operatorId: "canvas-cmd-e2e-admin",
        tokenSha256: hashOperatorToken(adminToken),
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
    projectId,
    projectRoot: workspace.root,
    packageDir: workspace.init.workspace.packageDir
  };
}

async function bootstrap(origin: string, projectId: string, displayName: string) {
  const response = await fetch(`${origin}/api/v1/projects/${projectId}/human/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName })
  });
  const body = await response.text();
  expect(response.status, body).toBe(201);
  return JSON.parse(body) as { deviceToken: string; principal: { id: string } };
}

function createClient(origin: string, projectId: string, profileId: string, token: string) {
  const client = new CollaborationClient({
    profile: {
      profileId,
      displayName: profileId,
      serverBaseUrl: `${origin}/`,
      projectId,
      allowInsecureTransport: true
    },
    credential: { getDeviceToken: () => token },
    WebSocketImpl: WebSocket as unknown as CollaborationWebSocketConstructor,
    limits: { requestTimeoutMs: 5_000, jsonBodyMaxBytes: 256_000 }
  });
  clients.push(client);
  return client;
}

function bridgeFor(client: CollaborationClient): CanvasCommandBridge {
  return {
    submitCollaborationCanvasCommand: async (input) => {
      const outcome = await client.submitCanvasCommand({
        canvasId: input.canvasId,
        operationId: input.operationId ?? `op-${Math.random().toString(36).slice(2, 12)}`,
        intent: input.intent,
        expectedRevision: input.expectedRevision
      });
      return { outcome, session: client.canvasCommandSession() };
    },
    reconnectCollaborationCanvas: async (input) => {
      const result = await client.reconnectCanvasCommands({
        canvasId: input.canvasId,
        afterRevision: input.afterRevision,
        afterContentDigest: input.afterContentDigest
      });
      return {
        response: result.response,
        entriesToApply: result.entriesToApply,
        snapshotRequired: result.snapshotRequired,
        session: result.session
      };
    },
    bindCollaborationCanvasCommandSession: async ({ canvasId }) => {
      client.bindCanvasCommandSession(canvasId);
      return client.canvasCommandSession();
    },
    getCollaborationCanvasCommandSession: async () => client.canvasCommandSession()
  };
}

describe("Desktop canvas command dual-client E2E (OSS-004 B-003)", () => {
  it("orders dual-client history, is idempotent, surfaces stale, reconnects, and rejects unauthorized/forbidden", async () => {
    const fixture = await setup();
    const owner = await bootstrap(fixture.origin, fixture.projectId, "Canvas Owner");
    expect(owner.deviceToken).not.toBe(exampleHumanDeviceToken);

    const clientA = createClient(fixture.origin, fixture.projectId, "profile-a", owner.deviceToken);
    const clientB = createClient(fixture.origin, fixture.projectId, "profile-b", owner.deviceToken);
    const controllerA = new CanvasCommandController({ api: bridgeFor(clientA), labels });
    const controllerB = new CanvasCommandController({ api: bridgeFor(clientB), labels });

    await controllerA.bind({ canvasId: "default" });
    await controllerB.bind({ canvasId: "default" });
    expect(controllerA.getSnapshot().session?.revision).toBe(0);
    expect(controllerB.getSnapshot().session?.revision).toBe(0);

    const first = await controllerA.submit({
      operationId: "op-shared-001",
      intent: {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# dual client first\n"
      },
      expectedRevision: 0
    });
    expect(first.outcome.type).toBe("canvas.command.accepted");
    if (first.outcome.type !== "canvas.command.accepted") throw new Error("expected accept");
    expect(first.outcome.revision).toBe(1);
    expect(first.outcome.idempotentReplay).toBe(false);

    // Duplicate operationId is idempotent (no second apply).
    const replay = await controllerA.submit({
      operationId: "op-shared-001",
      intent: {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# dual client first\n"
      },
      expectedRevision: 0
    });
    expect(replay.outcome.type).toBe("canvas.command.accepted");
    if (replay.outcome.type !== "canvas.command.accepted") throw new Error("expected replay");
    expect(replay.outcome.idempotentReplay).toBe(true);
    expect(replay.outcome.revision).toBe(1);

    // Stale revision is surfaced without guessing.
    const stale = await controllerB.submit({
      operationId: "op-shared-stale",
      intent: {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# stale attempt\n"
      },
      expectedRevision: 0
    });
    expect(stale.outcome.type).toBe("canvas.command.rejected");
    if (stale.outcome.type !== "canvas.command.rejected") throw new Error("expected reject");
    expect(stale.outcome.code).toBe("stale_revision");
    expect(stale.outcome.conflict?.authoritativeRevision).toBe(1);
    expect(controllerB.getSnapshot().lastStaleConflict?.authoritativeRevision).toBe(1);
    expect(controllerB.getSnapshot().lastError).toContain("stale:0->1");
    expect(controllerB.getSnapshot().session?.revision).toBe(0);

    // Client B reconnects and converges on ordered history.
    const reconnect = await controllerB.reconnect({ canvasId: "default" });
    expect(reconnect.response.type).toBe("canvas.reconnect.delta");
    if (reconnect.response.type !== "canvas.reconnect.delta") throw new Error("expected delta");
    expect(reconnect.response.headRevision).toBe(1);
    expect(reconnect.response.entries.map((entry) => entry.operationId)).toEqual(["op-shared-001"]);
    expect(controllerB.getSnapshot().session?.revision).toBe(1);

    // Client B continues ordered history from authoritative revision.
    const second = await controllerB.submit({
      operationId: "op-shared-002",
      intent: {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# dual client second\n"
      },
      expectedRevision: 1
    });
    expect(second.outcome.type).toBe("canvas.command.accepted");
    if (second.outcome.type !== "canvas.command.accepted") throw new Error("expected accept");
    expect(second.outcome.revision).toBe(2);

    const reconnectA = await controllerA.reconnect({ canvasId: "default", afterRevision: 1 });
    expect(reconnectA.response.type).toBe("canvas.reconnect.delta");
    if (reconnectA.response.type !== "canvas.reconnect.delta") throw new Error("expected delta");
    expect(reconnectA.response.entries.map((entry) => entry.operationId)).toEqual(["op-shared-002"]);
    expect(controllerA.getSnapshot().session?.revision).toBe(2);

    // Unauthorized cannot mutate or read reconnect snapshots.
    const unauth = createClient(
      fixture.origin,
      fixture.projectId,
      "profile-unauth",
      "pw_hdev_invalidtoken000000000000000000000000000"
    );
    const unauthMutate = await unauth.submitCanvasCommand({
      canvasId: "default",
      operationId: "op-unauth",
      intent: {
        kind: "update_task_prompt",
        taskId: "T-001",
        promptMarkdown: "# no\n"
      },
      expectedRevision: 0
    });
    expect(unauthMutate.type).toBe("canvas.command.rejected");
    if (unauthMutate.type === "canvas.command.rejected") {
      expect(unauthMutate.code).toBe("unauthorized");
    }
    await expect(
      unauth.reconnectCanvasCommands({
        canvasId: "default",
        afterRevision: 0
      })
    ).rejects.toThrow();

    // Forbidden directory/watch/upload/download/sync under canvas namespace are rejected.
    // routeCanvasCommandHttp owns these paths and must fail closed with exact 404 + detail.
    for (const path of [
      `/api/v1/projects/${fixture.projectId}/fs/list`,
      `/api/v1/projects/${fixture.projectId}/files`,
      `/api/v1/projects/${fixture.projectId}/sync`,
      `/api/v1/projects/${fixture.projectId}/upload`,
      `/api/v1/projects/${fixture.projectId}/download`,
      `/api/v1/projects/${fixture.projectId}/directory`,
      `/api/v1/projects/${fixture.projectId}/watch`,
      `/api/v1/billing/plans`,
      `/api/v1/ssh/exec`
    ]) {
      const response = await fetch(`${fixture.origin}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${owner.deviceToken}`,
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(response.status, path).toBe(404);
      const body = (await response.json()) as { detail?: string; error?: string };
      expect(body.detail, path).toBe("canvas_feature_not_supported");
      expect(body.error, path).toBe("not_found");
    }

    // Presence remains independent: command protocol version constant is stable.
    expect(CANVAS_COMMAND_PROTOCOL_VERSION).toBe(1);

    await controllerA.unbind();
    await controllerB.unbind();
  });
});

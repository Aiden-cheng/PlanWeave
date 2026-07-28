import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import {
  exampleAssignmentProjection,
  exampleBootstrapResponse,
  exampleHumanDeviceToken,
  exampleMemberPage,
  exampleObserverCatchupRequired,
  exampleObserverEvent,
  exampleObserverWelcome,
  exampleSecretsForRedaction,
  accessCapabilityFlags,
  HUMAN_OBSERVER_PROTOCOL_VERSION
} from "@planweave-ai/collaboration-contracts";
import {
  CollaborationClient,
  CollaborationClientError,
  redactCollaborationText
} from "../main/collaboration/index.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

async function listen(handler: Handler): Promise<{
  server: Server;
  origin: string;
  close: () => Promise<void>;
}> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "test_handler_failed" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}/`;
  return {
    server,
    origin,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength
  });
  res.end(bytes);
}

describe("CollaborationClient", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const close = cleanups.pop();
      if (close) await close();
    }
  });

  function clientFor(
    origin: string,
    overrides: {
      token?: string | undefined;
      limits?: ConstructorParameters<typeof CollaborationClient>[0]["limits"];
      WebSocketImpl?: ConstructorParameters<typeof CollaborationClient>[0]["WebSocketImpl"];
    } = {}
  ) {
    return new CollaborationClient({
      profile: {
        profileId: "profile-test",
        displayName: "Test",
        serverBaseUrl: origin,
        projectId: "project-demo-001",
        allowInsecureTransport: true
      },
      credential: {
        getDeviceToken: () => overrides.token
      },
      limits: {
        requestTimeoutMs: 2_000,
        jsonBodyMaxBytes: 4_096,
        observerMaxPayloadBytes: 4_096,
        reconnectInitialDelayMs: 10,
        reconnectMaxDelayMs: 20,
        ...overrides.limits
      },
      WebSocketImpl: overrides.WebSocketImpl,
      random: () => 0
    });
  }

  it("lists members through application-shaped methods and validates responses", async () => {
    const fixture = await listen(async (req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${exampleHumanDeviceToken}`);
      expect(req.url).toContain("/human/members");
      json(res, 200, exampleMemberPage);
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });
    const page = await client.listMembers({ cursor: 0, limit: 50 });
    expect(page.items[0]?.role).toBe("owner");
    client.dispose();
  });

  it("uses device-authenticated current-canvas access transport and preserves CAS conflicts", async () => {
    const scope = {
      scopeKind: "canvas" as const,
      workspaceId: "workspace-demo-001",
      projectId: "project-demo-001",
      canvasId: "canvas-demo-001"
    };
    const accessView = {
      scope,
      projectVisibility: "shared" as const,
      canvasVisibility: "private" as const,
      projectAclRevision: 7,
      canvasAclRevision: 7,
      project: {
        scope: { ...scope, scopeKind: "project" as const, canvasId: null },
        aclRevision: 7,
        effectiveRole: "owner" as const,
        roleSource: "scope_owner" as const,
        capabilities: accessCapabilityFlags("owner"),
        disabledReason: null
      },
      canvas: {
        scope,
        aclRevision: 7,
        effectiveRole: "owner" as const,
        roleSource: "scope_owner" as const,
        capabilities: accessCapabilityFlags("owner"),
        disabledReason: null
      },
      people: [
        {
          humanPrincipalId: "human-owner-001",
          displayName: "Owner",
          membership: "active" as const,
          effectiveRole: "owner" as const,
          capabilities: accessCapabilityFlags("owner"),
          disabledReason: null,
          grants: []
        }
      ]
    };
    let postBody: unknown = null;
    const fixture = await listen(async (req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${exampleHumanDeviceToken}`);
      expect(req.url).toBe("/api/v1/projects/project-demo-001/canvases/canvas-demo-001/access");
      if (req.method === "GET") {
        json(res, 200, accessView);
        return;
      }
      postBody = JSON.parse((await readBody(req)).toString("utf8"));
      json(res, 409, { status: "conflict", reason: "acl_revision_conflict", aclRevision: 8 });
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });

    await expect(client.getCurrentCanvasAccess(scope.canvasId)).resolves.toEqual(accessView);
    await expect(
      client.mutateCurrentCanvasAccess({
        canvasId: scope.canvasId,
        request: {
          operation: "grant",
          scope,
          expectedAclRevision: 7,
          humanPrincipalId: "human-editor-001",
          role: "editor"
        }
      })
    ).resolves.toEqual({ status: "conflict", reason: "acl_revision_conflict", aclRevision: 8 });
    expect(postBody).toMatchObject({ operation: "grant", expectedAclRevision: 7, scope });
    client.dispose();
  });

  it("maps auth expiry HTTP responses to typed boundary errors", async () => {
    const fixture = await listen((_req, res) => {
      json(res, 401, { error: "human_auth_unauthenticated" });
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });
    await expect(client.listMembers()).rejects.toMatchObject({
      name: "CollaborationClientError",
      kind: "auth",
      code: "human_auth_unauthenticated",
      httpStatus: 401
    });
    client.dispose();
  });

  it("rejects malformed JSON responses", async () => {
    const fixture = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not-json");
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });
    await expect(client.listMembers()).rejects.toMatchObject({
      kind: "protocol",
      code: "collaboration_malformed_json"
    });
    client.dispose();
  });

  it("rejects oversized responses", async () => {
    const fixture = await listen((_req, res) => {
      const payload = JSON.stringify({ items: [], nextCursor: null, pad: "x".repeat(8_000) });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      });
      res.end(payload);
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, {
      token: exampleHumanDeviceToken,
      limits: { jsonBodyMaxBytes: 1_024 }
    });
    await expect(client.listMembers()).rejects.toMatchObject({
      kind: "payload_too_large",
      code: "collaboration_response_too_large"
    });
    client.dispose();
  });

  it("reads valid pages above 16 KiB and fails closed above the response budget", async () => {
    const responseBudgetBytes = 4 * 1_024 * 1_024;
    const template = exampleMemberPage.items[0];
    if (!template) throw new Error("member fixture is empty");
    const largePage = {
      items: Array.from({ length: 100 }, (_, index) => ({
        ...template,
        membershipId: `membership-${String(index).padStart(3, "0")}`,
        humanPrincipalId: `human-owner-${String(index).padStart(3, "0")}`
      })),
      nextCursor: null
    };
    const largePayload = JSON.stringify(largePage);
    expect(Buffer.byteLength(largePayload)).toBeGreaterThan(16 * 1_024);
    expect(Buffer.byteLength(largePayload)).toBeLessThan(responseBudgetBytes);
    const oversizedPayload = JSON.stringify({
      ...largePage,
      pad: "x".repeat(responseBudgetBytes)
    });
    let requestCount = 0;
    const fixture = await listen((_req, res) => {
      requestCount += 1;
      if (requestCount === 1) {
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(largePayload)
        });
        res.end(largePayload);
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(oversizedPayload)
      });
      res.end(oversizedPayload);
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, {
      token: exampleHumanDeviceToken,
      limits: { jsonBodyMaxBytes: responseBudgetBytes }
    });
    await expect(client.listMembers({ limit: 100 })).resolves.toMatchObject({
      items: expect.any(Array),
      nextCursor: null
    });
    await expect(client.listMembers({ limit: 100 })).rejects.toMatchObject({
      kind: "payload_too_large",
      code: "collaboration_response_too_large"
    });
    client.dispose();
  });

  it("rejects schema-invalid assignment projections", async () => {
    const fixture = await listen((_req, res) => {
      json(res, 200, { ...exampleAssignmentProjection, revision: -1 });
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });
    await expect(
      client.getAssignment({ kind: "task", canvasId: "canvas-1", taskId: "task-1" })
    ).rejects.toMatchObject({
      kind: "protocol",
      code: "collaboration_response_invalid"
    });
    client.dispose();
  });

  it("maps conflict and rate-limit errors", async () => {
    let n = 0;
    const fixture = await listen((_req, res) => {
      n += 1;
      if (n === 1) json(res, 409, { error: "work_revision_conflict" });
      else json(res, 429, { error: "human_rate_limited" });
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });
    await expect(
      client.updateAssignment({
        workItem: { kind: "task", canvasId: "canvas-1", taskId: "task-1" },
        target: { kind: "unassigned" },
        expectedRevision: 1
      })
    ).rejects.toMatchObject({ kind: "conflict", code: "work_revision_conflict" });
    await expect(client.listMembers()).rejects.toMatchObject({
      kind: "rate_limited",
      retryable: true
    });
    client.dispose();
  });

  it("aborts in-flight requests on dispose", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await listen(async (_req, res) => {
      await gate;
      json(res, 200, exampleMemberPage);
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });
    const pending = client.listMembers();
    client.dispose();
    await expect(pending).rejects.toBeInstanceOf(CollaborationClientError);
    release();
  });

  it("bootstraps without Authorization and redacts secrets in logs", async () => {
    const fixture = await listen(async (req, res) => {
      expect(req.headers.authorization).toBeUndefined();
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      expect(body.displayName).toBe("Owner");
      json(res, 201, exampleBootstrapResponse);
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: undefined });
    const result = await client.bootstrapOwner({ displayName: "Owner" });
    expect(result.deviceToken).toBe(exampleHumanDeviceToken);
    expect(redactCollaborationText(exampleSecretsForRedaction.authorizationHeader)).toBe(
      "Bearer [REDACTED]"
    );
    expect(redactCollaborationText(JSON.stringify(result))).not.toContain(exampleHumanDeviceToken);
    client.dispose();
  });

  it("subscribes to human observer, advances cursor, and handles catch-up", async () => {
    const http = await listen((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    cleanups.push(http.close);

    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise((resolve, reject) => {
          wss.close((error) => (error ? reject(error) : resolve()));
        })
    );

    http.server.on("upgrade", (request, socket, head) => {
      if (!request.url?.includes("/human/observe")) {
        socket.destroy();
        return;
      }
      expect(request.headers.origin).toBe(new URL(http.origin).origin);
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", (raw) => {
          const message = JSON.parse(String(raw));
          expect(message.type).toBe("human.observer.hello");
          expect(message.lastCursor).toBe(0);
          ws.send(JSON.stringify(exampleObserverWelcome));
          ws.send(JSON.stringify(exampleObserverEvent));
          ws.send(JSON.stringify(exampleObserverCatchupRequired));
        });
      });
    });

    const events: string[] = [];
    const statuses: string[] = [];
    const client = clientFor(http.origin, {
      token: exampleHumanDeviceToken,
      WebSocketImpl: WebSocket as unknown as ConstructorParameters<
        typeof CollaborationClient
      >[0]["WebSocketImpl"]
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("observer timeout")), 3_000);
      client.startObserver({
        onEvent: (event) => {
          events.push(event.kind);
        },
        onCatchupRequired: (message) => {
          events.push(message.reason);
          expect(client.lastObserverCursor()).toBe(100);
          clearTimeout(timer);
          resolve();
        },
        onStatus: (status) => {
          statuses.push(status.state);
        }
      });
    });

    expect(events).toEqual(["assignment", "retention_gap"]);
    expect(statuses).toContain("connected");
    expect(statuses).toContain("catching_up");
    client.dispose();
  });

  it("reconnects observer after socket close and preserves cursor", async () => {
    const http = await listen((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    cleanups.push(http.close);
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise((resolve, reject) => {
          wss.close((error) => (error ? reject(error) : resolve()));
        })
    );

    let connections = 0;
    http.server.on("upgrade", (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        connections += 1;
        if (connections === 1) {
          ws.send(
            JSON.stringify({
              type: "human.observer.welcome",
              protocolVersion: HUMAN_OBSERVER_PROTOCOL_VERSION,
              projectId: "project-demo-001",
              serverTime: "2030-01-01T00:00:00.000Z",
              cursor: 5
            })
          );
          setTimeout(() => ws.close(4002, "forced"), 20);
        } else {
          ws.on("message", (raw) => {
            const hello = JSON.parse(String(raw));
            expect(hello.lastCursor).toBe(5);
            ws.send(
              JSON.stringify({
                type: "human.observer.welcome",
                protocolVersion: HUMAN_OBSERVER_PROTOCOL_VERSION,
                projectId: "project-demo-001",
                serverTime: "2030-01-01T00:00:01.000Z",
                cursor: 5
              })
            );
          });
        }
      });
    });

    const client = clientFor(http.origin, {
      token: exampleHumanDeviceToken,
      WebSocketImpl: WebSocket as unknown as ConstructorParameters<
        typeof CollaborationClient
      >[0]["WebSocketImpl"]
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("reconnect timeout")), 3_000);
      let sawReconnect = false;
      client.startObserver({
        onStatus: (status) => {
          if (status.state === "reconnecting") sawReconnect = true;
          if (status.state === "connected" && sawReconnect && connections >= 2) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });

    expect(client.lastObserverCursor()).toBe(5);
    client.dispose();
  });

  it("rejects observer events that do not continue from the validated cursor", async () => {
    const http = await listen((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    cleanups.push(http.close);
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise((resolve, reject) => {
          wss.close((error) => (error ? reject(error) : resolve()));
        })
    );

    const protocolClose = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("observer cursor validation timeout")),
        2_000
      );
      http.server.on("upgrade", (request, socket, head) => {
        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.on("message", () => {
            ws.send(
              JSON.stringify({
                ...exampleObserverWelcome,
                cursor: 5
              })
            );
            ws.send(
              JSON.stringify({
                ...exampleObserverEvent,
                cursor: 7,
                previousCursor: 6
              })
            );
          });
          ws.on("close", (code) => {
            clearTimeout(timer);
            expect(code).toBe(4000);
            resolve();
          });
        });
      });
    });

    const onEvent = () => {
      throw new Error("discontinuous observer event must not be delivered");
    };
    const client = clientFor(http.origin, {
      token: exampleHumanDeviceToken,
      WebSocketImpl: WebSocket as unknown as ConstructorParameters<
        typeof CollaborationClient
      >[0]["WebSocketImpl"]
    });
    client.startObserver({ onEvent });

    await protocolClose;
    expect(client.lastObserverCursor()).toBe(5);
    client.dispose();
  });

  it("handles observer auth expiry without reconnect loop", async () => {
    const http = await listen((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    cleanups.push(http.close);
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise((resolve, reject) => {
          wss.close((error) => (error ? reject(error) : resolve()));
        })
    );
    http.server.on("upgrade", (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.send(
          JSON.stringify({
            type: "human.observer.auth_expired",
            protocolVersion: HUMAN_OBSERVER_PROTOCOL_VERSION,
            code: "human_device_revoked"
          })
        );
      });
    });

    const client = clientFor(http.origin, {
      token: exampleHumanDeviceToken,
      WebSocketImpl: WebSocket as unknown as ConstructorParameters<
        typeof CollaborationClient
      >[0]["WebSocketImpl"]
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("auth expiry timeout")), 2_000);
      client.startObserver({
        onAuthExpired: (message) => {
          expect(message.code).toBe("human_device_revoked");
        },
        onStatus: (status) => {
          if (status.state === "auth_expired") {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });

    await new Promise((r) => setTimeout(r, 40));
    expect(client.observerState().state).toBe("auth_expired");
    client.dispose();
  });

  it("does not expose raw request(path) or socket accessors", () => {
    const client = clientFor("http://127.0.0.1:9/", { token: exampleHumanDeviceToken });
    expect("request" in client).toBe(false);
    expect("socket" in client).toBe(false);
    client.dispose();
  });

  it("observes remote operations and replays events through process-level HTTP fixture", async () => {
    const observation = {
      operationId: "op-process-1",
      projectId: "project-demo-001",
      canvasId: "default",
      blockRef: "T-1#B-1",
      state: "running",
      dispatchId: "dispatch-process-1",
      executionAttemptId: "attempt-process-1",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:01:00.000Z",
      attempt: {
        executionAttemptId: "attempt-process-1",
        dispatchId: "dispatch-process-1",
        status: "running",
        hostId: "host-1",
        leaseId: "lease-1",
        leaseExpiresAt: "2030-01-01T01:00:00.000Z",
        stateVersion: 1
      },
      dispatchStatus: "running",
      runtime: { ref: "T-1#B-1", status: "in_progress" }
    };
    const fixture = await listen(async (req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${exampleHumanDeviceToken}`);
      const url = req.url ?? "";
      if (req.method === "GET" && url.includes("/remote-operations/op-process-1/events")) {
        json(res, 200, {
          executionAttemptId: "attempt-process-1",
          afterCursor: 0,
          cursor: 1,
          highWatermark: 1,
          hasMore: false,
          events: [{ cursor: 1, kind: "agent_message", text: "process fixture" }]
        });
        return;
      }
      if (req.method === "GET" && url.includes("/remote-operations/op-process-1")) {
        json(res, 200, observation);
        return;
      }
      if (req.method === "POST" && url.endsWith("/remote-operations")) {
        const body = JSON.parse((await readBody(req)).toString("utf8")) as {
          blockRef: string;
          canvasId: string;
          idempotencyKey: string;
        };
        expect(body.blockRef).toBe("T-1#B-1");
        json(res, 202, observation);
        return;
      }
      if (req.method === "POST" && url.includes("/actions")) {
        const body = JSON.parse((await readBody(req)).toString("utf8")) as { kind: string };
        expect(body.kind).toBe("cancel");
        json(res, 200, {
          request: body,
          state: "recorded",
          createdAt: "2030-01-01T00:02:00.000Z"
        });
        return;
      }
      json(res, 404, { error: "not_found" });
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });

    const observed = await client.observeRemoteOperation("op-process-1");
    expect(observed.operationId).toBe("op-process-1");
    expect(observed.attempt.leaseId).toBe("lease-1");

    const events = await client.replayRemoteOperationEvents("op-process-1", { afterCursor: 0 });
    expect(events.events[0]).toMatchObject({ cursor: 1, kind: "agent_message" });

    const dispatched = await client.dispatchRemoteOperation({
      canvasId: "default",
      blockRef: "T-1#B-1",
      idempotencyKey: "idem-process-1"
    });
    expect(dispatched.dispatchId).toBe("dispatch-process-1");

    const action = await client.executeRemoteOperationAction("op-process-1", {
      kind: "cancel",
      actionId: "action-1",
      operationId: "op-process-1",
      dispatchId: "dispatch-process-1",
      executionAttemptId: "attempt-process-1",
      expectedAttemptVersion: 1,
      leaseId: "lease-1",
      reason: "process fixture cancel"
    });
    expect(action.state).toBe("recorded");
    client.dispose();
  });
});

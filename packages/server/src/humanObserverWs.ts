import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  humanObserverClientMessageSchema,
  humanObserverServerMessageSchema
} from "@planweave-ai/collaboration-protocol/activity/observer";
import { WebSocket, WebSocketServer } from "ws";
import {
  authenticateCollaborationForProject,
  authenticateCollaborationForScope,
  hasAuthenticatedCollaborationDevice,
  humanTransportAllowed,
  type HumanIdentityRepository,
  type HumanProjectAuthority
} from "./identity/index.js";
import type { TransportAdmissionPolicy } from "./insecureTransport.js";
import { isAllowedClientOrigin } from "./clientOrigin.js";
import type { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import type { HumanObserverJournal, HumanObserverScope } from "./humanObserverJournal.js";
import type { ProjectAccessRepository } from "./projectAccessRepository.js";
import type { WebSocketUpgradeRouter } from "./webSocketUpgradeRouter.js";

export type HumanObserverWebSocketOptions = {
  upgradeRouter: WebSocketUpgradeRouter;
  journal: HumanObserverJournal;
  repository: HumanIdentityRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  projectAccess: ProjectAccessRepository;
  projectAuthority: HumanProjectAuthority;
  maxPayloadBytes: number;
  shutdownTimeoutMs: number;
  transportAdmission: TransportAdmissionPolicy;
  allowedClientOrigins?: readonly string[];
  clock?: () => Date;
};

export type HumanObserverWebSocketServer = {
  close(): Promise<void>;
};

function projectIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /^\/api\/v1\/projects\/([^/]+)\/human\/observe(?:\?.*)?$/.exec(url);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(humanObserverServerMessageSchema.parse(message)));
}

export function attachHumanObserverWebSocketServer(
  options: HumanObserverWebSocketOptions
): HumanObserverWebSocketServer {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes
  });
  const sessions = new Set<WebSocket>();
  const clock = options.clock ?? (() => new Date());

  const authenticateScope = (authorization: string | string[] | undefined, projectId: string) => {
    const authenticated = authenticateCollaborationForScope(
      options.repository,
      options.workspaceIdentity,
      options.projectAuthority,
      authorization,
      projectId
    );
    if (!authenticated) return undefined;
    try {
      options.projectAccess.policy.assertCapability({
        workspaceId: authenticated.workspaceId,
        projectId,
        actor: { kind: "human", id: authenticated.actor.humanPrincipalId },
        capability: "read"
      });
      return authenticated;
    } catch {
      return undefined;
    }
  };

  const handleConnection = (
    socket: WebSocket,
    scope: HumanObserverScope,
    authorization: string | string[] | undefined
  ) => {
    sessions.add(socket);
    let initialized = false;
    let authorizationExpired = false;
    let unsubscribe = () => {};
    const stillAuthorized = () =>
      authenticateScope(authorization, scope.projectId)?.workspaceId === scope.workspaceId;
    const expireAuthorization = () => {
      if (authorizationExpired) return;
      authorizationExpired = true;
      send(socket, {
        type: "human.observer.auth_expired",
        protocolVersion: 1,
        code: "human_auth_unauthenticated"
      });
      socket.close(4001, "auth expired");
    };
    const authTimer = setInterval(() => {
      if (!stillAuthorized()) expireAuthorization();
    }, 250);
    const helloTimer = setTimeout(() => socket.close(4002, "observer hello required"), 10_000);

    socket.on("message", (data, isBinary) => {
      try {
        if (isBinary) throw new Error("human_observer_binary_message");
        if (!stillAuthorized()) {
          expireAuthorization();
          return;
        }
        const message = humanObserverClientMessageSchema.parse(JSON.parse(data.toString()));
        if (!initialized) {
          if (message.type !== "human.observer.hello" || message.projectId !== scope.projectId) {
            throw new Error("human_observer_hello_invalid");
          }
          initialized = true;
          clearTimeout(helloTimer);
          unsubscribe = options.journal.subscribe(scope, (event) => {
            if (!stillAuthorized()) {
              expireAuthorization();
              return;
            }
            send(socket, event);
          });
          const replay = options.journal.replay(scope, message.lastCursor);
          if (replay.kind === "gap") {
            send(socket, {
              type: "human.observer.catchup_required",
              protocolVersion: 1,
              reason: replay.reason,
              resumeCursor: replay.headCursor,
              ...(replay.droppedThroughCursor === undefined
                ? {}
                : { droppedThroughCursor: replay.droppedThroughCursor })
            });
            return;
          }
          for (const event of replay.events) send(socket, event);
          send(socket, {
            type: "human.observer.welcome",
            protocolVersion: 1,
            projectId: scope.projectId,
            serverTime: clock().toISOString(),
            cursor: replay.headCursor
          });
          return;
        }
        if (message.type !== "human.observer.ping") {
          throw new Error("human_observer_message_invalid");
        }
        send(socket, {
          type: "human.observer.pong",
          protocolVersion: 1,
          serverTime: clock().toISOString()
        });
      } catch {
        socket.close(4000, "protocol error");
      }
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      clearInterval(authTimer);
      unsubscribe();
      sessions.delete(socket);
    });
  };

  const unregister = options.upgradeRouter.register({
    matches: (request) => projectIdFromUrl(request.url) !== undefined,
    handle: (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const projectId = projectIdFromUrl(request.url);
      if (!projectId) {
        reject(socket, 403, "Forbidden");
        return;
      }
      if (!humanTransportAllowed(request.socket, options.transportAdmission)) {
        reject(socket, 426, "Upgrade Required");
        return;
      }
      if (!isAllowedClientOrigin(request.headers, options.allowedClientOrigins)) {
        reject(socket, 403, "Forbidden");
        return;
      }
      const authenticated = authenticateScope(request.headers.authorization, projectId);
      if (!authenticated) {
        const credentialActor = authenticateCollaborationForProject(
          options.repository,
          options.workspaceIdentity,
          request.headers.authorization,
          projectId
        );
        const hasDevice =
          credentialActor !== undefined ||
          hasAuthenticatedCollaborationDevice(
            options.repository,
            options.workspaceIdentity,
            request.headers.authorization
          );
        reject(socket, hasDevice ? 403 : 401, hasDevice ? "Forbidden" : "Unauthorized");
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) =>
        handleConnection(
          webSocket,
          { workspaceId: authenticated.workspaceId, projectId },
          request.headers.authorization
        )
      );
    }
  });

  let closePromise: Promise<void> | undefined;
  return {
    close() {
      closePromise ??= (async () => {
        unregister();
        for (const socket of sessions) socket.close(1001, "server shutdown");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const graceful = new Promise<void>((resolve, rejectClose) => {
          webSocketServer.close((error) => (error ? rejectClose(error) : resolve()));
        });
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            for (const socket of sessions) socket.terminate();
            resolve();
          }, options.shutdownTimeoutMs);
        });
        await Promise.race([graceful, timeout]);
        if (timer) clearTimeout(timer);
        for (const socket of sessions) socket.terminate();
        await graceful;
      })();
      return closePromise;
    }
  };
}

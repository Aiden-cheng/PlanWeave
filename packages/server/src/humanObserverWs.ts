import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  humanObserverClientMessageSchema,
  humanObserverServerMessageSchema
} from "@planweave-ai/collaboration-contracts";
import { WebSocket, WebSocketServer } from "ws";
import {
  authenticateHumanForProject,
  humanTransportAllowed,
  type HumanIdentityRepository,
  type HumanProjectAuthority
} from "./identity/index.js";
import type { HumanObserverJournal } from "./humanObserverJournal.js";
import type { WebSocketUpgradeRouter } from "./webSocketUpgradeRouter.js";

export type HumanObserverWebSocketOptions = {
  upgradeRouter: WebSocketUpgradeRouter;
  journal: HumanObserverJournal;
  repository: HumanIdentityRepository;
  projectAuthority: HumanProjectAuthority;
  maxPayloadBytes: number;
  shutdownTimeoutMs: number;
  allowInsecureTransport?: boolean;
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
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: options.maxPayloadBytes });
  const sessions = new Set<WebSocket>();
  const clock = options.clock ?? (() => new Date());

  const handleConnection = (
    socket: WebSocket,
    projectId: string,
    authorization: string | string[] | undefined
  ) => {
    sessions.add(socket);
    let initialized = false;
    let authorizationExpired = false;
    let unsubscribe = () => {};
    const stillAuthorized = () =>
      authenticateHumanForProject(options.repository, authorization, projectId) !== undefined;
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
          if (message.type !== "human.observer.hello" || message.projectId !== projectId) {
            throw new Error("human_observer_hello_invalid");
          }
          initialized = true;
          clearTimeout(helloTimer);
          unsubscribe = options.journal.subscribe(projectId, (event) => {
            if (!stillAuthorized()) {
              expireAuthorization();
              return;
            }
            send(socket, event);
          });
          const replay = options.journal.replay(projectId, message.lastCursor);
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
            projectId,
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
      if (!projectId || !options.projectAuthority.hasProject(projectId)) {
        reject(socket, 403, "Forbidden");
        return;
      }
      if (!humanTransportAllowed(request.socket, options.allowInsecureTransport)) {
        reject(socket, 426, "Upgrade Required");
        return;
      }
      if (
        !authenticateHumanForProject(options.repository, request.headers.authorization, projectId)
      ) {
        reject(socket, 401, "Unauthorized");
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) =>
        handleConnection(webSocket, projectId, request.headers.authorization)
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

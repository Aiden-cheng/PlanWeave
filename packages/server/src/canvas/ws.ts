import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  CANVAS_COMMAND_MAX_FRAME_BYTES,
  CANVAS_COMMAND_PROTOCOL_VERSION
} from "@planweave-ai/collaboration-protocol/core/limits";
import {
  canvasCommandClientMessageSchema,
  canvasCommandOperationIdSchema,
  canvasCommandServerMessageSchema,
  type CanvasCommandServerMessage
} from "@planweave-ai/collaboration-protocol/canvas/commands";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  authenticateCollaborationForScope,
  authenticateCollaborationForProject,
  humanTransportAllowed,
  type HumanIdentityRepository,
  type HumanProjectAuthority
} from "../identity/index.js";
import type { TransportAdmissionPolicy } from "../insecureTransport.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { WebSocketUpgradeRouter } from "../webSocketUpgradeRouter.js";
import { isAllowedClientOrigin } from "../clientOrigin.js";
import { CanvasCommandService } from "./service.js";

const COMMAND_PATH_PATTERN =
  /^\/api\/v1\/projects\/([^/]+)\/canvases\/([^/]+)\/human\/commands(?:\?.*)?$/;

export type CanvasCommandWebSocketOptions = {
  upgradeRouter: WebSocketUpgradeRouter;
  service: CanvasCommandService;
  repository: HumanIdentityRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  projectAuthority: HumanProjectAuthority;
  maxPayloadBytes: number;
  shutdownTimeoutMs: number;
  transportAdmission: TransportAdmissionPolicy;
  allowedClientOrigins?: readonly string[];
  clock?: () => Date;
  authCheckIntervalMs?: number;
};

export type CanvasCommandWebSocketServer = {
  close(): Promise<void>;
};

type CommandRoute = { projectId: string; canvasId: string };

function routeFromUrl(url: string | undefined): CommandRoute | undefined {
  if (!url) return undefined;
  const match = COMMAND_PATH_PATTERN.exec(url);
  if (!match) return undefined;
  try {
    return {
      projectId: decodeURIComponent(match[1] ?? ""),
      canvasId: decodeURIComponent(match[2] ?? "")
    };
  } catch {
    return undefined;
  }
}

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function send(socket: WebSocket, message: CanvasCommandServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(canvasCommandServerMessageSchema.parse(message)));
}

function parseFrame(data: RawData): unknown {
  const text = data.toString();
  if (Buffer.byteLength(text, "utf8") > CANVAS_COMMAND_MAX_FRAME_BYTES) {
    throw new Error("frame_too_large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("invalid_message");
  }
}

/**
 * Durable Canvas command WebSocket channel — independent from presence hub.
 * Presence frames are not accepted; mutations never read presence state.
 */
export function attachCanvasCommandWebSocketServer(
  options: CanvasCommandWebSocketOptions
): CanvasCommandWebSocketServer {
  const maxPayloadBytes = Math.min(options.maxPayloadBytes, CANVAS_COMMAND_MAX_FRAME_BYTES);
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < 1) {
    throw new Error("canvas_command_websocket_payload_invalid");
  }
  if (!Number.isSafeInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs < 100) {
    throw new Error("canvas_command_websocket_shutdown_timeout_invalid");
  }
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: maxPayloadBytes });
  const sessions = new Set<WebSocket>();
  const clock = options.clock ?? (() => new Date());
  const authCheckIntervalMs = options.authCheckIntervalMs ?? 250;

  const unregister = options.upgradeRouter.register({
    matches(request) {
      return routeFromUrl(request.url) !== undefined;
    },
    handle(request, socket, head) {
      void handleUpgrade(request, socket, head);
    }
  });

  async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const route = routeFromUrl(request.url);
    if (!route) {
      reject(socket, 404, "Not Found");
      return;
    }
    if (!humanTransportAllowed(request.socket, options.transportAdmission)) {
      reject(socket, 400, "Bad Request");
      return;
    }
    if (!isAllowedClientOrigin(request.headers, options.allowedClientOrigins)) {
      reject(socket, 403, "Forbidden");
      return;
    }
    const authenticated = authenticateCollaborationForScope(
      options.repository,
      options.workspaceIdentity,
      options.projectAuthority,
      request.headers.authorization,
      route.projectId,
      route.canvasId
    );
    if (!authenticated) {
      const credentialActor = authenticateCollaborationForProject(
        options.repository,
        options.workspaceIdentity,
        request.headers.authorization,
        route.projectId
      );
      reject(socket, credentialActor ? 404 : 401, credentialActor ? "Not Found" : "Unauthorized");
      return;
    }
    const context = authenticated.actor;

    webSocketServer.handleUpgrade(request, socket, head, (ws) => {
      sessions.add(ws);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        sessions.delete(ws);
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000);
        }
      };

      const authTimer = setInterval(() => {
        const still = authenticateCollaborationForScope(
          options.repository,
          options.workspaceIdentity,
          options.projectAuthority,
          request.headers.authorization,
          route.projectId,
          route.canvasId
        );
        if (!still) {
          ws.close(4001, "revoked");
          close();
        }
      }, authCheckIntervalMs);

      ws.on("message", (data) => {
        void (async () => {
          try {
            const raw = parseFrame(data);
            // Reject presence or any non-command durable frames on this channel.
            if (
              raw &&
              typeof raw === "object" &&
              "type" in raw &&
              String((raw as { type: unknown }).type).startsWith("canvas.presence.")
            ) {
              send(ws, {
                type: "canvas.command.rejected",
                protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
                schemaVersion: "canvas-command/v1",
                projectId: route.projectId,
                canvasId: route.canvasId,
                operationId: canvasCommandOperationIdSchema.parse("presence-rejected"),
                code: "invalid_command",
                detail: "presence_not_accepted_on_command_channel"
              });
              return;
            }
            const message = canvasCommandClientMessageSchema.parse(raw);
            if (message.projectId !== route.projectId || message.canvasId !== route.canvasId) {
              send(ws, {
                type: "canvas.command.rejected",
                protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
                schemaVersion: "canvas-command/v1",
                projectId: route.projectId,
                canvasId: route.canvasId,
                operationId:
                  message.type === "canvas.command.submit"
                    ? message.operationId
                    : canvasCommandOperationIdSchema.parse("cross-scope"),
                code: "cross_scope"
              });
              return;
            }
            if (message.type === "canvas.command.submit") {
              const outcome = await options.service.submit(context, message);
              send(ws, outcome);
              return;
            }
            const reconnect = await options.service.reconnect(context, message);
            send(ws, reconnect);
          } catch {
            send(ws, {
              type: "canvas.command.rejected",
              protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
              schemaVersion: "canvas-command/v1",
              projectId: route.projectId,
              canvasId: route.canvasId,
              operationId: canvasCommandOperationIdSchema.parse("invalid-frame"),
              code: "invalid_command"
            });
          }
        })();
      });

      ws.on("close", () => {
        clearInterval(authTimer);
        close();
      });
      ws.on("error", () => {
        clearInterval(authTimer);
        close();
      });
    });
  }

  return {
    async close() {
      unregister();
      const deadline = clock().getTime() + options.shutdownTimeoutMs;
      for (const session of sessions) {
        try {
          session.close(1001, "shutdown");
        } catch {
          // ignore
        }
      }
      while (sessions.size > 0 && clock().getTime() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    }
  };
}

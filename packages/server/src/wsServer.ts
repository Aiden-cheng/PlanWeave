import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { DispatchService } from "./dispatches.js";
import { AgentHostRepository } from "./hosts.js";
import { DurableMailbox, type MailboxMessage } from "./mailbox.js";
import {
  agentHostProtocolVersion,
  hostEventSchema,
  hostHelloSchema,
  serverEventSchema,
  type HostEvent,
  type ServerEvent
} from "./protocol.js";

export type AgentHostWebSocketOptions = {
  server: HttpServer;
  hosts: AgentHostRepository;
  mailbox: DurableMailbox;
  dispatches: DispatchService;
  heartbeatIntervalMs: number;
  leaseDurationMs: number;
  maxPayloadBytes?: number;
  allowInsecureTransport?: boolean;
};

export type AgentHostWebSocketServer = {
  close(): Promise<void>;
};

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(header ?? "");
  return match?.[1];
}

function hostIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /^\/agent-hosts\/([^/]+)\/connect(?:\?.*)?$/.exec(url);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function sendEvent(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(serverEventSchema.parse(event)));
}

function sendMailboxMessage(socket: WebSocket, message: MailboxMessage): void {
  sendEvent(socket, {
    type: "mailbox.message",
    sequence: message.sequence,
    messageId: message.messageId,
    command: message.command
  });
}

export function attachAgentHostWebSocketServer(
  options: AgentHostWebSocketOptions
): AgentHostWebSocketServer {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? 256 * 1024
  });
  const sessions = new Map<string, WebSocket>();

  const handleConnection = (socket: WebSocket, hostId: string) => {
    const prior = sessions.get(hostId);
    if (prior && prior.readyState === WebSocket.OPEN) prior.close(4001, "superseded");
    sessions.set(hostId, socket);

    let initialized = false;
    let alive = true;
    let unsubscribe = () => {};
    let processing = Promise.resolve();
    const helloTimeout = setTimeout(() => socket.close(4002, "host.hello required"), 10_000);
    const pingTimer = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, options.heartbeatIntervalMs);

    socket.on("pong", () => {
      alive = true;
    });

    const handleHostEvent = async (event: HostEvent): Promise<void> => {
      switch (event.type) {
        case "mailbox.ack":
          options.mailbox.acknowledge(hostId, event.messageId, event.sequence);
          break;
        case "host.heartbeat": {
          const renewed = options.dispatches.heartbeat(hostId, event.messageId, event.activeLeases);
          for (const lease of renewed) sendEvent(socket, { type: "lease.renewed", ...lease });
          break;
        }
        case "dispatch.accepted":
          options.dispatches.accept(hostId, event.messageId, event.dispatchId, event.leaseId);
          break;
        case "dispatch.progress":
          options.dispatches.recordProgress(hostId, event.messageId, event);
          break;
        case "dispatch.completed":
          await options.dispatches.complete(
            hostId,
            event.messageId,
            event.dispatchId,
            event.leaseId,
            event.result
          );
          break;
        case "dispatch.failed":
          await options.dispatches.fail(
            hostId,
            event.messageId,
            event.dispatchId,
            event.leaseId,
            event.failure
          );
          break;
      }
      sendEvent(socket, { type: "host.event_ack", messageId: event.messageId });
    };

    socket.on("message", (data, isBinary) => {
      processing = processing
        .then(async () => {
          if (isBinary) throw new Error("binary_messages_not_supported");
          let input: unknown;
          try {
            input = JSON.parse(data.toString());
          } catch {
            throw new Error("invalid_json");
          }
          if (!initialized) {
            const hello = hostHelloSchema.parse(input);
            const storedHost = options.hosts.getRequired(hostId);
            if (hello.lastAcknowledgedSequence > storedHost.lastAcknowledgedSequence) {
              throw new Error("mailbox_cursor_not_acknowledged");
            }
            options.hosts.reportOnline(hostId, hello.capabilities, hello.capacity);
            initialized = true;
            clearTimeout(helloTimeout);
            unsubscribe = options.mailbox.subscribe(hostId, (message) =>
              sendMailboxMessage(socket, message)
            );
            sendEvent(socket, {
              type: "host.welcome",
              protocolVersion: agentHostProtocolVersion,
              serverTime: new Date().toISOString(),
              heartbeatIntervalMs: options.heartbeatIntervalMs,
              leaseDurationMs: options.leaseDurationMs
            });
            for (const message of options.mailbox.listAfter(
              hostId,
              hello.lastAcknowledgedSequence
            )) {
              sendMailboxMessage(socket, message);
            }
            return;
          }
          await handleHostEvent(hostEventSchema.parse(input));
        })
        .catch((error: unknown) => {
          sendEvent(socket, {
            type: "protocol.error",
            code: "event_rejected",
            message: error instanceof Error ? error.message : "Unknown protocol error."
          });
        });
    });

    socket.on("close", () => {
      clearTimeout(helloTimeout);
      clearInterval(pingTimer);
      unsubscribe();
      if (sessions.get(hostId) === socket) sessions.delete(hostId);
    });
  };

  const upgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const hostId = hostIdFromUrl(request.url);
    if (!hostId) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (request.headers.origin) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const encrypted = "encrypted" in request.socket && request.socket.encrypted === true;
    if (!encrypted && !options.allowInsecureTransport) {
      rejectUpgrade(socket, 426, "Upgrade Required");
      return;
    }
    const authorization = request.headers.authorization;
    const token = bearerToken(Array.isArray(authorization) ? authorization[0] : authorization);
    if (!token || !options.hosts.authenticate(hostId, token)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      handleConnection(webSocket, hostId);
    });
  };

  options.server.on("upgrade", upgradeListener);

  return {
    close: async () => {
      options.server.off("upgrade", upgradeListener);
      for (const socket of sessions.values()) socket.close(1001, "server shutdown");
      await new Promise<void>((resolve, reject) => {
        webSocketServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}

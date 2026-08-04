import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ServerConfig } from "../config.js";
import type { TransportAdmissionPolicy } from "../insecureTransport.js";
import type { WebSocketUpgradeRouter } from "../webSocketUpgradeRouter.js";

const webSocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const readinessPath = "/readyz/ws";

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function validWebSocketKey(value: string | string[] | undefined): value is string {
  if (!value || Array.isArray(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.byteLength === 16 && decoded.toString("base64") === value;
  } catch {
    return false;
  }
}

function connectionRequestsUpgrade(request: IncomingMessage): boolean {
  const connection = request.headers.connection;
  return (
    request.method === "GET" &&
    request.headers.upgrade?.toLowerCase() === "websocket" &&
    typeof connection === "string" &&
    connection.split(",").some((token) => token.trim().toLowerCase() === "upgrade") &&
    request.headers["sec-websocket-version"] === "13" &&
    validWebSocketKey(request.headers["sec-websocket-key"])
  );
}

export function attachTailscaleWebSocketReadiness(options: {
  config: ServerConfig;
  upgradeRouter: WebSocketUpgradeRouter;
  transportAdmission: TransportAdmissionPolicy;
}): void {
  if (options.config.transport.mode !== "tailscale_https") return;
  const advertisedOrigin = new URL(options.config.transport.advertisedOrigin).origin;
  options.upgradeRouter.register({
    matches: (request) => request.url === readinessPath,
    handle: (request, socket) => {
      if (!options.transportAdmission.allowsNetworkTransport(request.socket)) {
        reject(socket, 426, "Upgrade Required");
        return;
      }
      if (request.headers.origin !== advertisedOrigin) {
        reject(socket, 403, "Forbidden");
        return;
      }
      if (!connectionRequestsUpgrade(request)) {
        reject(socket, 400, "Bad Request");
        return;
      }
      const key = request.headers["sec-websocket-key"];
      if (!validWebSocketKey(key)) {
        reject(socket, 400, "Bad Request");
        return;
      }
      const accept = createHash("sha1").update(`${key}${webSocketGuid}`).digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      socket.end(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
    }
  });
}

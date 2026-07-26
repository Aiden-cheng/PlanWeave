import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

export type WebSocketUpgradeHandler = {
  matches(request: IncomingMessage): boolean;
  handle(request: IncomingMessage, socket: Duplex, head: Buffer): void;
};

function rejectUpgrade(socket: Duplex): void {
  socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  socket.destroy();
}

export class WebSocketUpgradeRouter {
  private readonly handlers = new Set<WebSocketUpgradeHandler>();
  private closed = false;
  private readonly listener = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (this.closed) {
      rejectUpgrade(socket);
      return;
    }
    const matches = [...this.handlers].filter((handler) => handler.matches(request));
    if (matches.length !== 1) {
      rejectUpgrade(socket);
      return;
    }
    matches[0]?.handle(request, socket, head);
  };

  constructor(private readonly server: HttpServer) {
    server.on("upgrade", this.listener);
  }

  register(handler: WebSocketUpgradeHandler): () => void {
    if (this.closed) throw new Error("websocket_upgrade_router_closed");
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.off("upgrade", this.listener);
    this.handlers.clear();
  }
}

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { RequestOptions } from "node:https";
import { describe, expect, it, vi } from "vitest";
import { createTailscaleWebSocketProbe } from "../exposure/tailscaleWebSocketProbe.js";

const webSocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

describe("Tailscale WebSocket probe", () => {
  it("owns errors from the upgraded TCP socket after closing the probe", async () => {
    const requestEvents = new EventEmitter();
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    let requestOptions: RequestOptions | undefined;
    const requestHttps = ((_url: URL, options: RequestOptions) => {
      requestOptions = options;
      return Object.assign(requestEvents, {
        end: () => {
          const headers = requestOptions?.headers as Record<string, string>;
          const key = headers["Sec-WebSocket-Key"];
          requestEvents.emit(
            "upgrade",
            {
              statusCode: 101,
              headers: {
                upgrade: "websocket",
                connection: "Upgrade",
                "sec-websocket-accept": createHash("sha1")
                  .update(`${key}${webSocketGuid}`)
                  .digest("base64")
              }
            },
            socket
          );
        }
      });
    }) as unknown as typeof import("node:https").request;
    const probe = createTailscaleWebSocketProbe(requestHttps);

    await expect(
      probe("wss://planweave.example.ts.net/readyz/ws", {
        origin: "https://planweave.example.ts.net/",
        signal: new AbortController().signal
      })
    ).resolves.toBeUndefined();

    expect(socket.destroy).toHaveBeenCalledOnce();
    expect(socket.listenerCount("error")).toBe(1);
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(() => socket.emit("error", reset)).not.toThrow();
  });
});

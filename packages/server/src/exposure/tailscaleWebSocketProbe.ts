import { createHash, randomBytes } from "node:crypto";
import { request } from "node:https";

const webSocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function connectionAccepted(value: string | string[] | undefined): boolean {
  return (
    typeof value === "string" &&
    value.split(",").some((token) => token.trim().toLowerCase() === "upgrade")
  );
}

export type TailscaleWebSocketProbe = (
  url: string,
  options: { origin: string; signal: AbortSignal }
) => Promise<void>;

export const probeTailscaleWebSocketUpgrade: TailscaleWebSocketProbe = (url, { origin, signal }) =>
  new Promise((resolve, reject) => {
    const requestUrl = new URL(url);
    if (requestUrl.protocol !== "wss:") {
      throw new Error("tailscale_websocket_probe_url_invalid");
    }
    requestUrl.protocol = "https:";
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1").update(`${key}${webSocketGuid}`).digest("base64");
    const probe = request(
      requestUrl,
      {
        method: "GET",
        signal,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          Origin: origin,
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13"
        }
      },
      (response) => {
        response.resume();
        reject(new Error(`tailscale_websocket_probe_status:${response.statusCode ?? "missing"}`));
      }
    );
    probe.once("upgrade", (response, socket) => {
      socket.destroy();
      if (
        response.statusCode === 101 &&
        response.headers.upgrade?.toLowerCase() === "websocket" &&
        connectionAccepted(response.headers.connection) &&
        response.headers["sec-websocket-accept"] === expectedAccept
      ) {
        resolve();
        return;
      }
      reject(new Error(`tailscale_websocket_probe_status:${response.statusCode}`));
    });
    probe.once("error", reject);
    probe.end();
  });

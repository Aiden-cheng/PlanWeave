import type { IncomingMessage } from "node:http";
import { AgentHostRepository, type AgentHost } from "./hosts.js";

export type HostTransportAuthentication =
  | { ok: true; host: AgentHost }
  | { ok: false; status: 401 | 403 | 426; message: string };

function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(value ?? "");
  return match?.[1];
}

export function authenticateAgentHostRequest(
  request: IncomingMessage,
  hosts: AgentHostRepository,
  hostId: string,
  allowInsecureTransport: boolean
): HostTransportAuthentication {
  if (request.headers.origin) return { ok: false, status: 403, message: "Forbidden" };
  const encrypted = "encrypted" in request.socket && request.socket.encrypted === true;
  if (!encrypted && !allowInsecureTransport) {
    return { ok: false, status: 426, message: "Upgrade Required" };
  }
  const token = bearerToken(request.headers.authorization);
  const host = token ? hosts.authenticate(hostId, token) : undefined;
  return host ? { ok: true, host } : { ok: false, status: 401, message: "Unauthorized" };
}

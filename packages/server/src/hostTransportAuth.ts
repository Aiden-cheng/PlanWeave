import type { IncomingMessage } from "node:http";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { AgentHostRepository, type AgentHost } from "./hosts.js";
import {
  humanNetworkTransportAllowed,
  type TransportAdmissionPolicy
} from "./insecureTransport.js";

export type HostTransportAuthentication =
  | { ok: true; host: AgentHost }
  | {
      ok: false;
      status: 401 | 403 | 426;
      message: string;
      reason?: "workspace_mismatch";
    };

function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(value ?? "");
  return match?.[1];
}

function workspaceScope(request: IncomingMessage): string | undefined {
  const rawUrl = request.url;
  if (!rawUrl) return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl, "http://planweave.invalid");
  } catch {
    return undefined;
  }
  const values = url.searchParams.getAll("workspaceId");
  if (values.length !== 1) return undefined;
  return opaqueIdentifierSchema.safeParse(values[0]).success ? values[0] : undefined;
}

function hasWorkspaceScopeParameter(request: IncomingMessage): boolean {
  if (!request.url) return false;
  try {
    return new URL(request.url, "http://planweave.invalid").searchParams.has("workspaceId");
  } catch {
    return true;
  }
}

export function authenticateAgentHostRequest(
  request: IncomingMessage,
  hosts: AgentHostRepository,
  hostId: string,
  transportAdmission: TransportAdmissionPolicy,
  expectedWorkspaceId?: string
): HostTransportAuthentication {
  if (request.headers.origin) return { ok: false, status: 403, message: "Forbidden" };
  if (!humanNetworkTransportAllowed(request.socket, transportAdmission)) {
    return { ok: false, status: 426, message: "Upgrade Required" };
  }
  const requestedWorkspaceId = workspaceScope(request);
  if (
    (requestedWorkspaceId && expectedWorkspaceId && requestedWorkspaceId !== expectedWorkspaceId) ||
    (!requestedWorkspaceId && (hasWorkspaceScopeParameter(request) || !expectedWorkspaceId))
  ) {
    return { ok: false, status: 403, message: "Workspace scope required" };
  }
  const workspaceId = requestedWorkspaceId ?? expectedWorkspaceId;
  if (!workspaceId) return { ok: false, status: 403, message: "Workspace scope required" };
  const token = bearerToken(request.headers.authorization);
  // Require a single authoritative binding before checking the requested scope. A
  // workspace-specific match alone would accept an ambiguously bound Host.
  const host = token ? hosts.authenticate(hostId, token) : undefined;
  const scopedHost = host && token ? hosts.authenticate(hostId, token, workspaceId) : undefined;
  if (scopedHost) return { ok: true, host: scopedHost };
  return host
    ? { ok: false, status: 401, message: "Unauthorized", reason: "workspace_mismatch" }
    : { ok: false, status: 401, message: "Unauthorized" };
}

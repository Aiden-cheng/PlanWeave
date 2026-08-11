import type { IncomingMessage, ServerResponse } from "node:http";
import {
  hostCredentialRenewalErrorSchema,
  hostCredentialRenewalStatusSchema,
  hostCredentialRotationRequestSchema,
  hostCredentialRotationResponseSchema,
  type HostCredentialRenewalErrorCode
} from "@planweave-ai/agent-host-protocol";
import { AgentHostRepository } from "./hosts.js";
import { authenticateAgentHostRequest } from "./hostTransportAuth.js";
import type { TransportAdmissionPolicy } from "./insecureTransport.js";

const MAX_BODY_BYTES = 8_192;

function respond(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "cache-control": "no-store"
  });
  response.end(bytes);
}

function reject(
  response: ServerResponse,
  status: number,
  error: HostCredentialRenewalErrorCode
): void {
  respond(response, status, hostCredentialRenewalErrorSchema.parse({ error }));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
    throw new Error("credential_renewal_content_type_invalid");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("credential_renewal_body_too_large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function hostIdFromPath(pathname: string): string | undefined {
  const match = /^\/agent-hosts\/([^/]+)\/credential-renewal$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

export type HostCredentialRenewalHttpOptions = {
  hosts: AgentHostRepository;
  transportAdmission: TransportAdmissionPolicy;
  clock?: () => Date;
};

export async function handleHostCredentialRenewalRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: HostCredentialRenewalHttpOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://planweave.invalid");
  const hostId = hostIdFromPath(url.pathname);
  if (!hostId) return false;
  if (request.method !== "GET" && request.method !== "POST") {
    request.resume();
    reject(response, 400, "malformed");
    return true;
  }
  const authentication = authenticateAgentHostRequest(
    request,
    options.hosts,
    hostId,
    options.transportAdmission
  );
  if (!authentication.ok || authentication.credentialKind === "previous") {
    request.resume();
    reject(
      response,
      authentication.ok ? 401 : authentication.status,
      authentication.ok
        ? "credential_rejected"
        : authentication.status === 426
          ? "insecure_transport"
          : "credential_rejected"
    );
    return true;
  }
  try {
    if (url.searchParams.size > (url.searchParams.has("workspaceId") ? 1 : 0)) {
      throw new Error("credential_renewal_query_invalid");
    }
    if (request.method === "GET") {
      const state = options.hosts.credentialRenewalState(hostId);
      respond(
        response,
        200,
        hostCredentialRenewalStatusSchema.parse({
          ...state,
          serverTime: (options.clock?.() ?? new Date()).toISOString()
        })
      );
      return true;
    }
    const rotation = hostCredentialRotationRequestSchema.parse(await readJson(request));
    respond(
      response,
      200,
      hostCredentialRotationResponseSchema.parse(
        options.hosts.registerCredentialRotation(
          hostId,
          rotation.rotationId,
          rotation.nextCredentialToken
        )
      )
    );
  } catch (error) {
    const code =
      error instanceof Error && error.message === "agent_host_credential_renewal_not_configured"
        ? "renewal_not_configured"
        : error instanceof Error && error.message === "agent_host_credential_expired"
          ? "credential_expired"
          : error instanceof Error && error.message === "agent_host_credential_rotation_conflict"
            ? "rotation_conflict"
            : "malformed";
    reject(
      response,
      code === "credential_expired" ? 410 : code === "rotation_conflict" ? 409 : 400,
      code
    );
  }
  return true;
}

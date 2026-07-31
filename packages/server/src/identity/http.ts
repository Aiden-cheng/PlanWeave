import type { IncomingMessage, ServerResponse } from "node:http";
import { opaqueIdentifierSchema } from "@planweave-ai/distributed-protocol";
import { z } from "zod";
import { humanNetworkTransportAllowed, isLoopbackAddress } from "../insecureTransport.js";
import { authenticateHumanForProject } from "./auth.js";
import {
  HUMAN_AUTH_ERROR_MESSAGES,
  humanAuthErrorCodeSchema,
  type HumanAuthErrorCode
} from "./errors.js";
import { HumanIdentityRepository } from "./repository.js";
import {
  HumanMembershipService,
  HumanMembershipServiceError,
  type HumanProjectAuthority
} from "./service.js";
import {
  HUMAN_DEVICE_TOKEN_PREFIX,
  HUMAN_TOKEN_SECRET_CHAR_LENGTH,
  PROJECT_INVITATION_TOKEN_PREFIX
} from "./limits.js";

const MAX_HUMAN_BODY_BYTES = 16_384;
/** Soft admission limit for human auth-sensitive routes (per remote address). */
const HUMAN_RATE_WINDOW_MS = 60_000;
const HUMAN_RATE_MAX_REQUESTS = 60;
/** Bounds untrusted remote-address/project pairs retained by the in-process limiter. */
export const HUMAN_RATE_MAX_BUCKETS = 1_000;

export type HumanHttpOptions = {
  service: HumanMembershipService;
  repository: HumanIdentityRepository;
  projectAuthority: HumanProjectAuthority;
  allowInsecureDevelopment?: boolean;
  clock?: () => Date;
};

type HumanRoute =
  | { kind: "bootstrap"; projectId: string }
  | { kind: "consume_invitation"; projectId: string }
  | { kind: "create_invitation"; projectId: string }
  | { kind: "list_invitations"; projectId: string }
  | { kind: "revoke_invitations"; projectId: string }
  | { kind: "revoke_invitation"; projectId: string; invitationId: string }
  | { kind: "list_members"; projectId: string }
  | { kind: "remove_member"; projectId: string; humanPrincipalId: string }
  | { kind: "promote_owner"; projectId: string; humanPrincipalId: string }
  | { kind: "demote_owner"; projectId: string; humanPrincipalId: string }
  | { kind: "list_devices"; projectId: string }
  | { kind: "revoke_device"; projectId: string; deviceCredentialId: string };

type RateBucket = { windowStartedAt: number; count: number };
const rateBuckets = new Map<string, RateBucket>();

function decodeIdentifier(value: string): string | undefined {
  try {
    return opaqueIdentifierSchema.parse(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

function route(request: IncomingMessage, pathname: string): HumanRoute | undefined {
  const projectMatch = /^\/api\/v1\/projects\/([^/]+)\/human(\/.*)?$/.exec(pathname);
  if (!projectMatch) return undefined;
  const projectId = decodeIdentifier(projectMatch[1]);
  if (!projectId) return undefined;
  const rest = projectMatch[2] ?? "";

  if (request.method === "POST" && rest === "/bootstrap") {
    return { kind: "bootstrap", projectId };
  }
  if (request.method === "POST" && rest === "/invitations/consume") {
    return { kind: "consume_invitation", projectId };
  }
  if (request.method === "POST" && rest === "/invitations") {
    return { kind: "create_invitation", projectId };
  }
  if (request.method === "GET" && rest === "/invitations") {
    return { kind: "list_invitations", projectId };
  }
  if (request.method === "POST" && rest === "/invitations/revoke-batch") {
    return { kind: "revoke_invitations", projectId };
  }
  const revokeInvitation = /^\/invitations\/([^/]+)\/revoke$/.exec(rest);
  if (request.method === "POST" && revokeInvitation) {
    const invitationId = decodeIdentifier(revokeInvitation[1]);
    if (!invitationId) return undefined;
    return { kind: "revoke_invitation", projectId, invitationId };
  }
  if (request.method === "GET" && rest === "/members") {
    return { kind: "list_members", projectId };
  }
  const memberAction = /^\/members\/([^/]+)\/(remove|promote|demote)$/.exec(rest);
  if (request.method === "POST" && memberAction) {
    const humanPrincipalId = decodeIdentifier(memberAction[1]);
    if (!humanPrincipalId) return undefined;
    if (memberAction[2] === "remove") {
      return { kind: "remove_member", projectId, humanPrincipalId };
    }
    if (memberAction[2] === "promote") {
      return { kind: "promote_owner", projectId, humanPrincipalId };
    }
    return { kind: "demote_owner", projectId, humanPrincipalId };
  }
  if (request.method === "GET" && rest === "/devices") {
    return { kind: "list_devices", projectId };
  }
  const revokeDevice = /^\/devices\/([^/]+)\/revoke$/.exec(rest);
  if (request.method === "POST" && revokeDevice) {
    const deviceCredentialId = decodeIdentifier(revokeDevice[1]);
    if (!deviceCredentialId) return undefined;
    return { kind: "revoke_device", projectId, deviceCredentialId };
  }
  return undefined;
}

function isHumanApiCandidate(pathname: string): boolean {
  return pathname.startsWith("/api/v1/projects/") && pathname.includes("/human");
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "cache-control": "no-store"
  });
  response.end(bytes);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
    throw new HumanMembershipServiceError("human_input_invalid", "JSON content type required.");
  }
  const declaredLength = request.headers["content-length"];
  if (Array.isArray(declaredLength)) {
    throw new HumanMembershipServiceError("human_input_invalid", "Invalid content length.");
  }
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_HUMAN_BODY_BYTES)
  ) {
    const error = new Error("human_body_too_large");
    throw error;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_HUMAN_BODY_BYTES) throw new Error("human_body_too_large");
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HumanMembershipServiceError("human_input_invalid", "Malformed JSON body.");
  }
}

function query(url: URL, allowed: readonly string[]): Record<string, string | undefined> {
  const allowedKeys = new Set(allowed);
  const result: Record<string, string | undefined> = {};
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new HumanMembershipServiceError("human_input_invalid", "Invalid query parameters.");
    }
    result[key] = url.searchParams.get(key) ?? undefined;
  }
  return result;
}

export function humanTransportAllowed(
  socket: { encrypted?: boolean; remoteAddress?: string },
  allowInsecureDevelopment = false
): boolean {
  return humanNetworkTransportAllowed(socket, allowInsecureDevelopment);
}

/**
 * Local administrative boundary for owner bootstrap: only loopback clients may mint the
 * first project owner. This is not a network bearer and not Host/operator auth.
 */
export function humanLocalAdminBoundaryAllowed(socket: { remoteAddress?: string }): boolean {
  return isLoopbackAddress(socket.remoteAddress);
}

function rateLimitKey(request: IncomingMessage, projectId: string): string {
  return `${request.socket.remoteAddress ?? "unknown"}:${projectId}`;
}

function checkRateLimit(request: IncomingMessage, projectId: string, now: number): boolean {
  const key = rateLimitKey(request, projectId);
  const bucket = rateBuckets.get(key);
  if (bucket && now - bucket.windowStartedAt < HUMAN_RATE_WINDOW_MS) {
    if (bucket.count >= HUMAN_RATE_MAX_REQUESTS) return false;
    bucket.count += 1;
    return true;
  }

  for (const [candidateKey, candidate] of rateBuckets) {
    if (now - candidate.windowStartedAt >= HUMAN_RATE_WINDOW_MS) {
      rateBuckets.delete(candidateKey);
    }
  }
  if (rateBuckets.size >= HUMAN_RATE_MAX_BUCKETS) {
    const oldestKey = rateBuckets.keys().next().value;
    if (oldestKey !== undefined) rateBuckets.delete(oldestKey);
  }

  rateBuckets.set(key, { windowStartedAt: now, count: 1 });
  return true;
}

/** Test helper to clear in-memory rate limit state. */
export function resetHumanHttpRateLimits(): void {
  rateBuckets.clear();
}

function httpStatusForCode(code: HumanAuthErrorCode): number {
  switch (code) {
    case "human_auth_unauthenticated":
      return 401;
    case "human_auth_forbidden":
    case "human_auth_project_mismatch":
    case "human_membership_required":
    case "human_role_insufficient":
    case "human_last_owner_protected":
    case "human_self_target_forbidden":
    case "human_bootstrap_requires_local_admin":
    case "human_invitation_invalid":
    case "human_invitation_expired":
    case "human_invitation_revoked":
    case "human_invitation_consumed":
    case "human_invitation_role_forbidden":
    case "human_device_revoked":
    case "human_device_expired":
    case "human_device_not_owner":
    case "human_credential_kind_mismatch":
    case "human_cross_project_forbidden":
    case "human_identity_workspace_mismatch":
      return 403;
    case "human_bootstrap_conflict":
    case "human_limit_exceeded":
      return 409;
    case "human_input_invalid":
      return 400;
    default: {
      const _exhaustive: never = code;
      return 500;
    }
  }
}

function safeError(error: unknown): { status: number; code: string } {
  if (error instanceof z.ZodError) {
    return { status: 400, code: "human_input_invalid" };
  }
  if (error instanceof HumanMembershipServiceError) {
    const code = humanAuthErrorCodeSchema.parse(error.code);
    return { status: httpStatusForCode(code), code };
  }
  if (error instanceof Error) {
    if (error.message === "human_body_too_large") {
      return { status: 413, code: "human_body_too_large" };
    }
    if (error.message === "human_rate_limited") {
      return { status: 429, code: "human_rate_limited" };
    }
  }
  return { status: 500, code: "human_request_failed" };
}

/**
 * Redact secrets from accidental error surfaces. Public error bodies only use stable codes.
 */
function publicErrorBody(code: string): { error: string } {
  // Never echo token-shaped strings.
  if (
    code.includes(HUMAN_DEVICE_TOKEN_PREFIX) ||
    code.includes(PROJECT_INVITATION_TOKEN_PREFIX) ||
    code.length > HUMAN_TOKEN_SECRET_CHAR_LENGTH + 16
  ) {
    return { error: "human_request_failed" };
  }
  return { error: code };
}

function requireHumanContext(
  options: HumanHttpOptions,
  request: IncomingMessage,
  projectId: string
) {
  const context = authenticateHumanForProject(
    options.repository,
    request.headers.authorization,
    projectId
  );
  if (!context) {
    throw new HumanMembershipServiceError("human_auth_unauthenticated");
  }
  return context;
}

export async function handleHumanHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: HumanHttpOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://planweave.invalid");
  const matched = route(request, url.pathname);
  if (!matched) {
    if (isHumanApiCandidate(url.pathname)) {
      respond(response, 404, { error: "route_not_found" });
      return true;
    }
    return false;
  }

  try {
    if (!humanTransportAllowed(request.socket, options.allowInsecureDevelopment)) {
      request.resume();
      respond(response, 426, { error: "human_insecure_transport" });
      return true;
    }

    if (!options.projectAuthority.hasProject(matched.projectId)) {
      request.resume();
      respond(response, 403, { error: "human_cross_project_forbidden" });
      return true;
    }

    const now = (options.clock ?? (() => new Date()))().getTime();
    if (!checkRateLimit(request, matched.projectId, now)) {
      request.resume();
      respond(response, 429, { error: "human_rate_limited" });
      return true;
    }

    switch (matched.kind) {
      case "bootstrap": {
        if (!humanLocalAdminBoundaryAllowed(request.socket)) {
          request.resume();
          respond(response, 403, {
            error: "human_bootstrap_requires_local_admin",
            message: HUMAN_AUTH_ERROR_MESSAGES.human_bootstrap_requires_local_admin
          });
          return true;
        }
        query(url, []);
        const body = await readJson(request);
        const result = options.service.bootstrapOwner(matched.projectId, body);
        respond(response, result.created ? 201 : 200, result);
        break;
      }
      case "consume_invitation": {
        query(url, []);
        const body = await readJson(request);
        const result = options.service.consumeInvitation(matched.projectId, body);
        respond(response, 201, result);
        break;
      }
      case "create_invitation": {
        query(url, []);
        const context = requireHumanContext(options, request, matched.projectId);
        const body = await readJson(request);
        const result = options.service.createInvitation(context, matched.projectId, body);
        respond(response, 201, result);
        break;
      }
      case "list_invitations": {
        const context = requireHumanContext(options, request, matched.projectId);
        const parameters = query(url, ["cursor", "limit", "openOnly"]);
        respond(
          response,
          200,
          options.service.listInvitations(context, matched.projectId, parameters)
        );
        break;
      }
      case "revoke_invitation": {
        query(url, []);
        const context = requireHumanContext(options, request, matched.projectId);
        request.resume();
        respond(
          response,
          200,
          options.service.revokeInvitation(context, matched.projectId, matched.invitationId)
        );
        break;
      }
      case "revoke_invitations": {
        query(url, []);
        const context = requireHumanContext(options, request, matched.projectId);
        const body = await readJson(request);
        respond(response, 200, options.service.revokeInvitations(context, matched.projectId, body));
        break;
      }
      case "list_members": {
        const context = requireHumanContext(options, request, matched.projectId);
        const parameters = query(url, ["cursor", "limit"]);
        respond(response, 200, options.service.listMembers(context, matched.projectId, parameters));
        break;
      }
      case "remove_member": {
        query(url, []);
        const context = requireHumanContext(options, request, matched.projectId);
        request.resume();
        respond(
          response,
          200,
          options.service.removeMember(context, matched.projectId, matched.humanPrincipalId)
        );
        break;
      }
      case "promote_owner": {
        query(url, []);
        const context = requireHumanContext(options, request, matched.projectId);
        request.resume();
        respond(
          response,
          200,
          options.service.promoteOwner(context, matched.projectId, matched.humanPrincipalId)
        );
        break;
      }
      case "demote_owner": {
        query(url, []);
        const context = requireHumanContext(options, request, matched.projectId);
        request.resume();
        respond(
          response,
          200,
          options.service.demoteOwner(context, matched.projectId, matched.humanPrincipalId)
        );
        break;
      }
      case "list_devices": {
        const context = requireHumanContext(options, request, matched.projectId);
        const parameters = query(url, ["cursor", "limit", "scope"]);
        respond(response, 200, options.service.listDevices(context, matched.projectId, parameters));
        break;
      }
      case "revoke_device": {
        query(url, []);
        const context = requireHumanContext(options, request, matched.projectId);
        request.resume();
        respond(
          response,
          200,
          options.service.revokeDevice(context, matched.projectId, matched.deviceCredentialId)
        );
        break;
      }
      default: {
        const _exhaustive: never = matched;
        respond(response, 404, { error: "route_not_found" });
      }
    }
  } catch (error) {
    const safe = safeError(error);
    request.resume();
    if (!response.headersSent) respond(response, safe.status, publicErrorBody(safe.code));
    else response.destroy();
  }
  return true;
}

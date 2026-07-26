import type { IncomingMessage, ServerResponse } from "node:http";
import { opaqueIdentifierSchema } from "@planweave-ai/distributed-protocol";
import { z } from "zod";
import { OperatorTokenRegistry, type OperatorPrincipal } from "./operatorAuth.js";
import { serverReadinessSchema, type ServerReadiness } from "./readiness.js";
import { DispatchAssignmentError } from "./work/dispatchIntegration.js";

const MAX_OPERATOR_BODY_BYTES = 64 * 1024;

const healthResponseSchema = z.object({ status: z.literal("ok") }).strict();
const versionResponseSchema = z
  .object({
    serverVersion: z.string().min(1).max(64),
    protocolVersion: z.literal(1),
    limits: z
      .object({
        maxArtifactBytes: z.number().int().positive(),
        maxWebSocketPayloadBytes: z.number().int().positive()
      })
      .strict()
  })
  .strict();

export type OperatorHttpOptions = {
  authorization: OperatorTokenRegistry;
  service: OperatorControlPort;
  readiness(): ServerReadiness;
  serverVersion: string;
  limits: {
    maxArtifactBytes: number;
    maxWebSocketPayloadBytes: number;
  };
  allowInsecureDevelopment?: boolean;
};

export type OperatorControlPort = {
  createEnrollmentGrant(principal: OperatorPrincipal, request: unknown): unknown;
  listHosts(principal: OperatorPrincipal, query: unknown): unknown;
  getHost(principal: OperatorPrincipal, hostId: string): unknown;
  revokeHost(principal: OperatorPrincipal, hostId: string): unknown;
  dispatch(principal: OperatorPrincipal, request: unknown): Promise<unknown>;
  observeOperation(principal: OperatorPrincipal, operationId: string): Promise<unknown>;
  executeAction(
    principal: OperatorPrincipal,
    operationId: string,
    request: unknown
  ): Promise<unknown>;
  replayEvents(principal: OperatorPrincipal, operationId: string, afterCursor: unknown): unknown;
  listPendingInteractions(
    principal: OperatorPrincipal,
    operationId: string,
    query: unknown
  ): unknown;
  settleInteraction(principal: OperatorPrincipal, operationId: string, request: unknown): unknown;
};

type OperatorRoute =
  | { kind: "health" }
  | { kind: "readiness" }
  | { kind: "version" }
  | { kind: "create_enrollment" }
  | { kind: "list_hosts" }
  | { kind: "get_host" | "revoke_host"; hostId: string }
  | { kind: "dispatch" }
  | {
      kind: "get_operation" | "action" | "events" | "interactions" | "settle_interaction";
      operationId: string;
    };

function decodeIdentifier(value: string): string | undefined {
  try {
    return opaqueIdentifierSchema.parse(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

function route(request: IncomingMessage, pathname: string): OperatorRoute | undefined {
  if (request.method === "GET" && pathname === "/healthz") return { kind: "health" };
  if (request.method === "GET" && pathname === "/readyz") return { kind: "readiness" };
  if (request.method === "GET" && pathname === "/version") return { kind: "version" };
  if (request.method === "POST" && pathname === "/api/v1/host-enrollments") {
    return { kind: "create_enrollment" };
  }
  if (request.method === "GET" && pathname === "/api/v1/hosts") {
    return { kind: "list_hosts" };
  }
  if (request.method === "POST" && pathname === "/api/v1/remote-operations") {
    return { kind: "dispatch" };
  }
  const host = /^\/api\/v1\/hosts\/([^/]+)(\/revoke)?$/.exec(pathname);
  if (host) {
    const hostId = decodeIdentifier(host[1]);
    if (!hostId) return undefined;
    if (request.method === "GET" && !host[2]) return { kind: "get_host", hostId };
    if (request.method === "POST" && host[2]) return { kind: "revoke_host", hostId };
  }
  const operation =
    /^\/api\/v1\/remote-operations\/([^/]+)(?:\/(actions|events|interactions)(\/respond)?)?$/.exec(
      pathname
    );
  if (!operation) return undefined;
  const operationId = decodeIdentifier(operation[1]);
  if (!operationId) return undefined;
  if (request.method === "GET" && !operation[2]) return { kind: "get_operation", operationId };
  if (request.method === "POST" && operation[2] === "actions" && !operation[3]) {
    return { kind: "action", operationId };
  }
  if (request.method === "GET" && operation[2] === "events" && !operation[3]) {
    return { kind: "events", operationId };
  }
  if (request.method === "GET" && operation[2] === "interactions" && !operation[3]) {
    return { kind: "interactions", operationId };
  }
  if (request.method === "POST" && operation[2] === "interactions" && operation[3] === "/respond") {
    return { kind: "settle_interaction", operationId };
  }
  return undefined;
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
    throw new Error("operator_content_type_invalid");
  }
  const declaredLength = request.headers["content-length"];
  if (Array.isArray(declaredLength)) throw new Error("operator_content_length_invalid");
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_OPERATOR_BODY_BYTES)
  ) {
    throw new Error("operator_body_too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_OPERATOR_BODY_BYTES) throw new Error("operator_body_too_large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("operator_json_invalid");
  }
}

function query(url: URL, allowed: readonly string[]): Record<string, string | undefined> {
  const allowedKeys = new Set(allowed);
  const result: Record<string, string | undefined> = {};
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new Error("operator_query_invalid");
    }
    result[key] = url.searchParams.get(key) ?? undefined;
  }
  return result;
}

function safeError(error: unknown): { status: number; code: string } {
  if (error instanceof z.ZodError) return { status: 400, code: "operator_request_invalid" };
  if (error instanceof DispatchAssignmentError) {
    if (error.code === "work_revision_conflict" || error.code === "work_dispatch_host_mismatch") {
      return { status: 409, code: error.code };
    }
    if (
      error.code === "work_not_agent_assigned" ||
      error.code === "work_item_kind_target_mismatch" ||
      error.code === "work_item_not_found" ||
      error.code === "work_input_invalid"
    ) {
      return { status: 409, code: error.code };
    }
    return { status: 400, code: error.code };
  }
  if (!(error instanceof Error)) return { status: 500, code: "operator_request_failed" };
  if (
    [
      "operator_body_too_large",
      "operator_content_length_invalid",
      "operator_content_type_invalid",
      "operator_json_invalid",
      "operator_query_invalid"
    ].includes(error.message)
  ) {
    return {
      status: error.message === "operator_body_too_large" ? 413 : 400,
      code: error.message === "operator_body_too_large" ? error.message : "operator_request_invalid"
    };
  }
  if (error.message.startsWith("operator_project_forbidden")) {
    return { status: 403, code: "operator_scope_forbidden" };
  }
  if (error.message === "operator_server_admin_required") {
    return { status: 403, code: "operator_admin_required" };
  }
  if (error.message.includes("not_found"))
    return { status: 404, code: "operator_resource_not_found" };
  if (
    error.message.includes("conflict") ||
    error.message.includes("mismatch") ||
    error.message.includes("stale") ||
    error.message.includes("invalid_state") ||
    error.message.includes("not_interruptible")
  ) {
    return { status: 409, code: "operator_operation_conflict" };
  }
  return { status: 500, code: "operator_request_failed" };
}

function isLoopback(address: string | undefined): boolean {
  return Boolean(
    address === "::1" ||
      address === "127.0.0.1" ||
      address?.startsWith("127.") ||
      address?.startsWith("::ffff:127.")
  );
}

export function operatorTransportAllowed(
  socket: { encrypted?: boolean; remoteAddress?: string },
  allowInsecureDevelopment = false
): boolean {
  return (
    socket.encrypted === true || (allowInsecureDevelopment && isLoopback(socket.remoteAddress))
  );
}

export async function handleOperatorHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: OperatorHttpOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://planweave.invalid");
  const matched = route(request, url.pathname);
  if (!matched) {
    if (
      url.pathname.startsWith("/api/v1/") ||
      ["/healthz", "/readyz", "/version"].includes(url.pathname)
    ) {
      respond(response, 404, { error: "route_not_found" });
      return true;
    }
    return false;
  }
  try {
    if (matched.kind === "health") {
      query(url, []);
      respond(response, 200, healthResponseSchema.parse({ status: "ok" }));
      return true;
    }
    if (matched.kind === "readiness") {
      query(url, []);
      const readiness = serverReadinessSchema.parse(options.readiness());
      respond(response, readiness.status === "ready" ? 200 : 503, readiness);
      return true;
    }
    if (matched.kind === "version") {
      query(url, []);
      respond(
        response,
        200,
        versionResponseSchema.parse({
          serverVersion: options.serverVersion,
          protocolVersion: 1,
          limits: options.limits
        })
      );
      return true;
    }
    if (!operatorTransportAllowed(request.socket, options.allowInsecureDevelopment)) {
      request.resume();
      respond(response, 426, { error: "operator_insecure_transport" });
      return true;
    }
    const principal = options.authorization.authenticate(request.headers.authorization);
    if (!principal) {
      request.resume();
      respond(response, 401, { error: "operator_unauthorized" });
      return true;
    }
    switch (matched.kind) {
      case "create_enrollment":
        query(url, []);
        respond(
          response,
          201,
          options.service.createEnrollmentGrant(principal, await readJson(request))
        );
        break;
      case "list_hosts":
        respond(
          response,
          200,
          options.service.listHosts(principal, query(url, ["cursor", "limit"]))
        );
        break;
      case "get_host":
        query(url, []);
        respond(response, 200, options.service.getHost(principal, matched.hostId));
        break;
      case "revoke_host":
        query(url, []);
        respond(response, 200, options.service.revokeHost(principal, matched.hostId));
        break;
      case "dispatch":
        query(url, []);
        respond(response, 202, await options.service.dispatch(principal, await readJson(request)));
        break;
      case "get_operation":
        query(url, []);
        respond(
          response,
          200,
          await options.service.observeOperation(principal, matched.operationId)
        );
        break;
      case "action":
        query(url, []);
        respond(
          response,
          202,
          await options.service.executeAction(
            principal,
            matched.operationId,
            await readJson(request)
          )
        );
        break;
      case "events": {
        const parameters = query(url, ["afterCursor"]);
        respond(
          response,
          200,
          options.service.replayEvents(principal, matched.operationId, parameters.afterCursor)
        );
        break;
      }
      case "interactions":
        respond(
          response,
          200,
          options.service.listPendingInteractions(
            principal,
            matched.operationId,
            query(url, ["cursor", "limit"])
          )
        );
        break;
      case "settle_interaction":
        query(url, []);
        respond(
          response,
          200,
          options.service.settleInteraction(principal, matched.operationId, await readJson(request))
        );
        break;
    }
  } catch (error) {
    const safe = safeError(error);
    request.resume();
    if (!response.headersSent) respond(response, safe.status, { error: safe.code });
    else response.destroy();
  }
  return true;
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { opaqueIdentifierSchema } from "@planweave-ai/distributed-protocol";
import { z } from "zod";
import {
  authenticateHumanForProject,
  humanTransportAllowed,
  type HumanIdentityRepository,
  type HumanProjectAuthority
} from "./identity/index.js";
import { DispatchAssignmentError } from "./work/dispatchIntegration.js";
import { RemoteExecutionActionRejectedError } from "./remoteExecutionActions.js";
import {
  HumanRemoteControlError,
  type HumanRemoteControlService
} from "./humanRemoteControlService.js";
import type { ServerReadiness } from "./readiness.js";

const MAX_BODY_BYTES = 64 * 1024;

export type HumanRemoteHttpOptions = {
  service: HumanRemoteControlService;
  repository: HumanIdentityRepository;
  projectAuthority: HumanProjectAuthority;
  readiness(): ServerReadiness;
  allowInsecureDevelopment?: boolean;
};

type HumanRemoteRoute =
  | { kind: "dispatch"; projectId: string }
  | {
      kind: "get" | "action" | "events" | "interactions" | "settle_interaction";
      projectId: string;
      operationId: string;
    };

function decodeIdentifier(value: string): string | undefined {
  try {
    return opaqueIdentifierSchema.parse(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

function route(request: IncomingMessage, pathname: string): HumanRemoteRoute | undefined {
  const match = /^\/api\/v1\/projects\/([^/]+)\/remote-operations(?:\/([^/]+)(?:\/(actions|events|interactions)(\/respond)?)?)?$/.exec(
    pathname
  );
  if (!match) return undefined;
  const projectId = decodeIdentifier(match[1]);
  if (!projectId) return undefined;
  if (request.method === "POST" && !match[2]) return { kind: "dispatch", projectId };
  const operationId = match[2] ? decodeIdentifier(match[2]) : undefined;
  if (!operationId) return undefined;
  if (request.method === "GET" && !match[3]) return { kind: "get", projectId, operationId };
  if (request.method === "POST" && match[3] === "actions" && !match[4]) {
    return { kind: "action", projectId, operationId };
  }
  if (request.method === "GET" && match[3] === "events" && !match[4]) {
    return { kind: "events", projectId, operationId };
  }
  if (request.method === "GET" && match[3] === "interactions" && !match[4]) {
    return { kind: "interactions", projectId, operationId };
  }
  if (request.method === "POST" && match[3] === "interactions" && match[4] === "/respond") {
    return { kind: "settle_interaction", projectId, operationId };
  }
  return undefined;
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(bytes);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
    throw new HumanRemoteControlError("human_remote_request_invalid");
  }
  const declaredLength = request.headers["content-length"];
  if (
    Array.isArray(declaredLength) ||
    (declaredLength !== undefined &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES))
  ) {
    throw new HumanRemoteControlError("human_remote_body_too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new HumanRemoteControlError("human_remote_body_too_large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HumanRemoteControlError("human_remote_request_invalid");
  }
}

function query(url: URL, allowed: readonly string[]): Record<string, string | undefined> {
  const allowedKeys = new Set(allowed);
  const result: Record<string, string | undefined> = {};
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new HumanRemoteControlError("human_remote_request_invalid");
    }
    result[key] = url.searchParams.get(key) ?? undefined;
  }
  return result;
}

function safeError(error: unknown): { status: number; code: string } {
  if (error instanceof z.ZodError) return { status: 400, code: "human_remote_request_invalid" };
  if (error instanceof RemoteExecutionActionRejectedError) return { status: 409, code: error.code };
  if (error instanceof DispatchAssignmentError) return { status: 409, code: error.code };
  if (error instanceof HumanRemoteControlError) {
    if (error.code === "human_remote_body_too_large") return { status: 413, code: error.code };
    if (error.code.includes("forbidden") || error.code.includes("project_mismatch")) {
      return { status: 403, code: error.code };
    }
    if (error.code.includes("mismatch")) return { status: 409, code: error.code };
    return { status: 400, code: error.code };
  }
  if (!(error instanceof Error)) return { status: 500, code: "human_remote_request_failed" };
  if (error.message.includes("not_found")) {
    return { status: 404, code: "human_remote_resource_not_found" };
  }
  if (
    error.message.includes("conflict") ||
    error.message.includes("mismatch") ||
    error.message.includes("stale") ||
    error.message.includes("invalid_state") ||
    error.message.includes("not_interruptible")
  ) {
    return { status: 409, code: "human_remote_operation_conflict" };
  }
  return { status: 500, code: "human_remote_request_failed" };
}

export async function handleHumanRemoteHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: HumanRemoteHttpOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://planweave.invalid");
  const matched = route(request, url.pathname);
  if (!matched) {
    if (/^\/api\/v1\/projects\/[^/]+\/remote-operations(?:\/|$)/.test(url.pathname)) {
      request.resume();
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
    if (
      (matched.kind === "dispatch" ||
        matched.kind === "action" ||
        matched.kind === "settle_interaction") &&
      options.readiness().status !== "ready"
    ) {
      request.resume();
      respond(response, 503, { error: "server_not_accepting_mutations" });
      return true;
    }
    const context = authenticateHumanForProject(
      options.repository,
      request.headers.authorization,
      matched.projectId
    );
    if (!context) {
      request.resume();
      respond(response, 401, { error: "human_auth_unauthenticated" });
      return true;
    }

    switch (matched.kind) {
      case "dispatch":
        query(url, []);
        respond(
          response,
          202,
          await options.service.dispatch(context, matched.projectId, await readJson(request))
        );
        break;
      case "get":
        query(url, []);
        respond(
          response,
          200,
          await options.service.observeOperation(
            context,
            matched.projectId,
            matched.operationId
          )
        );
        break;
      case "action":
        query(url, []);
        respond(
          response,
          202,
          await options.service.executeAction(
            context,
            matched.projectId,
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
          options.service.replayEvents(context, matched.projectId, matched.operationId, {
            ...(parameters.afterCursor === undefined
              ? {}
              : { afterCursor: Number(parameters.afterCursor) })
          })
        );
        break;
      }
      case "interactions": {
        const parameters = query(url, ["cursor", "limit"]);
        respond(
          response,
          200,
          options.service.listPendingInteractions(context, matched.projectId, matched.operationId, {
            ...(parameters.cursor === undefined ? {} : { cursor: Number(parameters.cursor) }),
            ...(parameters.limit === undefined ? {} : { limit: Number(parameters.limit) })
          })
        );
        break;
      }
      case "settle_interaction":
        query(url, []);
        respond(
          response,
          200,
          options.service.settleInteraction(
            context,
            matched.projectId,
            matched.operationId,
            await readJson(request)
          )
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

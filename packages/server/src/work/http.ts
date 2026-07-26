import {
  assignmentListQuerySchema,
  assignmentUpdateWireCommandSchema
} from "@planweave-ai/collaboration-contracts";
import { opaqueIdentifierSchema } from "@planweave-ai/distributed-protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  authenticateHumanForProject,
  humanTransportAllowed,
  type HumanIdentityRepository,
  type HumanProjectAuthority
} from "../identity/index.js";
import { WorkAssignmentService, WorkAssignmentServiceError } from "./service.js";
import { workItemRefSchema } from "./schemas.js";

const MAX_ASSIGNMENT_BODY_BYTES = 65_536;
const ASSIGNMENT_RATE_WINDOW_MS = 60_000;
const ASSIGNMENT_RATE_MAX_REQUESTS = 120;
const ASSIGNMENT_RATE_MAX_BUCKETS = 1_000;

type AssignmentRoute = {
  kind: "get" | "list" | "update" | "eligible";
  projectId: string;
};

type RateBucket = { windowStartedAt: number; count: number };
const rateBuckets = new Map<string, RateBucket>();

export type WorkAssignmentHttpOptions = {
  resolveService(projectId: string): WorkAssignmentService | undefined;
  repository: HumanIdentityRepository;
  projectAuthority: HumanProjectAuthority;
  allowInsecureDevelopment?: boolean;
  clock?: () => Date;
};

function decodeIdentifier(value: string): string | undefined {
  try {
    return opaqueIdentifierSchema.parse(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

function route(request: IncomingMessage, pathname: string): AssignmentRoute | undefined {
  const match = /^\/api\/v1\/projects\/([^/]+)\/assignments(\/.*)?$/.exec(pathname);
  if (!match) return undefined;
  const projectId = decodeIdentifier(match[1]);
  if (!projectId) return undefined;
  const rest = match[2] ?? "";
  if (request.method === "GET" && rest === "") return { kind: "get", projectId };
  if (request.method === "GET" && rest === "/list") return { kind: "list", projectId };
  if (request.method === "POST" && rest === "") return { kind: "update", projectId };
  if (request.method === "GET" && rest === "/eligible-assignees") {
    return { kind: "eligible", projectId };
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
    throw new WorkAssignmentServiceError("work_input_invalid", "JSON content type required.");
  }
  const declaredLength = request.headers["content-length"];
  if (
    Array.isArray(declaredLength) ||
    (declaredLength !== undefined &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_ASSIGNMENT_BODY_BYTES))
  ) {
    throw new Error("assignment_body_too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_ASSIGNMENT_BODY_BYTES) throw new Error("assignment_body_too_large");
    chunks.push(bytes);
  }
  try {
    return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WorkAssignmentServiceError("work_input_invalid", "Malformed JSON body.");
  }
}

function query(url: URL, allowed: readonly string[]): Record<string, string | undefined> {
  const allowedKeys = new Set(allowed);
  const result: Record<string, string | undefined> = {};
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new WorkAssignmentServiceError("work_input_invalid", "Invalid query parameters.");
    }
    result[key] = url.searchParams.get(key) ?? undefined;
  }
  return result;
}

function parseJsonParameter(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new WorkAssignmentServiceError("work_input_invalid", "Malformed JSON query parameter.");
  }
}

function rateLimitAllowed(request: IncomingMessage, projectId: string, now: number): boolean {
  const key = `${request.socket.remoteAddress ?? "unknown"}:${projectId}`;
  const current = rateBuckets.get(key);
  if (current && now - current.windowStartedAt < ASSIGNMENT_RATE_WINDOW_MS) {
    if (current.count >= ASSIGNMENT_RATE_MAX_REQUESTS) return false;
    current.count += 1;
    return true;
  }
  for (const [candidateKey, bucket] of rateBuckets) {
    if (now - bucket.windowStartedAt >= ASSIGNMENT_RATE_WINDOW_MS) {
      rateBuckets.delete(candidateKey);
    }
  }
  if (rateBuckets.size >= ASSIGNMENT_RATE_MAX_BUCKETS) {
    const oldestKey = rateBuckets.keys().next().value;
    if (oldestKey !== undefined) rateBuckets.delete(oldestKey);
  }
  rateBuckets.set(key, { windowStartedAt: now, count: 1 });
  return true;
}

function statusFor(error: WorkAssignmentServiceError): number {
  switch (error.code) {
    case "work_auth_unauthenticated":
      return 401;
    case "work_auth_forbidden":
    case "work_auth_project_mismatch":
    case "work_role_insufficient":
    case "work_cross_project_forbidden":
      return 403;
    case "work_item_not_found":
    case "work_host_not_found":
      return 404;
    case "work_revision_conflict":
      return 409;
    case "work_input_invalid":
    case "work_item_kind_target_mismatch":
    case "work_human_not_member":
    case "work_host_revoked":
    case "work_host_not_authorized":
    case "work_host_capability_mismatch":
    case "work_not_agent_assigned":
    case "work_dispatch_host_mismatch":
      return 400;
  }
}

function safeError(error: unknown): { status: number; code: string } {
  if (error instanceof z.ZodError) return { status: 400, code: "work_input_invalid" };
  if (error instanceof WorkAssignmentServiceError) {
    return { status: statusFor(error), code: error.code };
  }
  if (error instanceof Error && error.message === "assignment_body_too_large") {
    return { status: 413, code: "assignment_body_too_large" };
  }
  return { status: 500, code: "assignment_request_failed" };
}

export function resetWorkAssignmentHttpRateLimits(): void {
  rateBuckets.clear();
}

export async function handleWorkAssignmentHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkAssignmentHttpOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://planweave.invalid");
  const matched = route(request, url.pathname);
  if (!matched) {
    if (/^\/api\/v1\/projects\/[^/]+\/assignments(\/|$)/.test(url.pathname)) {
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
      respond(response, 403, { error: "work_cross_project_forbidden" });
      return true;
    }
    const now = (options.clock ?? (() => new Date()))().getTime();
    if (!rateLimitAllowed(request, matched.projectId, now)) {
      request.resume();
      respond(response, 429, { error: "assignment_rate_limited" });
      return true;
    }
    const actor = authenticateHumanForProject(
      options.repository,
      request.headers.authorization,
      matched.projectId
    );
    if (!actor) throw new WorkAssignmentServiceError("work_auth_unauthenticated");
    const service = options.resolveService(matched.projectId);
    if (!service) throw new WorkAssignmentServiceError("work_cross_project_forbidden");

    switch (matched.kind) {
      case "update": {
        query(url, []);
        const body = assignmentUpdateWireCommandSchema.parse(await readJson(request));
        respond(
          response,
          200,
          service.updateAssignment({ ...body, actor, projectId: matched.projectId }).display
        );
        return true;
      }
      case "get": {
        const parameters = query(url, ["workItem"]);
        const workItem = workItemRefSchema.parse(parseJsonParameter(parameters.workItem));
        respond(response, 200, service.getAssignment(actor, matched.projectId, workItem));
        return true;
      }
      case "list": {
        const parameters = query(url, ["canvasId", "workItems", "cursor", "limit"]);
        const parsed = assignmentListQuerySchema.parse({
          ...(parameters.canvasId === undefined ? {} : { canvasId: parameters.canvasId }),
          ...(parameters.workItems === undefined
            ? {}
            : { workItems: parseJsonParameter(parameters.workItems) }),
          ...(parameters.cursor === undefined ? {} : { cursor: Number(parameters.cursor) }),
          ...(parameters.limit === undefined ? {} : { limit: Number(parameters.limit) })
        });
        respond(response, 200, service.listAssignments(actor, matched.projectId, parsed));
        return true;
      }
      case "eligible": {
        const parameters = query(url, [
          "workItem",
          "humanLimit",
          "humanCursor",
          "hostLimit",
          "hostCursor"
        ]);
        const workItem = workItemRefSchema.parse(parseJsonParameter(parameters.workItem));
        const result = service.listEligibleAssignees(actor, matched.projectId, workItem, {
          ...(parameters.humanLimit === undefined
            ? {}
            : { humanLimit: Number(parameters.humanLimit) }),
          ...(parameters.humanCursor === undefined
            ? {}
            : { humanCursor: Number(parameters.humanCursor) }),
          ...(parameters.hostLimit === undefined
            ? {}
            : { hostLimit: Number(parameters.hostLimit) }),
          ...(parameters.hostCursor === undefined
            ? {}
            : { hostCursor: Number(parameters.hostCursor) })
        });
        respond(response, 200, {
          workItem: result.workItem,
          humans: result.humans,
          hosts: result.hosts,
          nextHumanCursor: result.nextHumanCursor,
          nextHostCursor: result.nextHostCursor
        });
        return true;
      }
    }
  } catch (error) {
    const safe = safeError(error);
    request.resume();
    respond(response, safe.status, { error: safe.code });
    return true;
  }
}

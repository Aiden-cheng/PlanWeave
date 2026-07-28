import type { IncomingMessage, ServerResponse } from "node:http";
import {
  WORKSPACE_PICKER_MAX_ITEMS_PER_PAGE,
  humanDeviceTokenSchema,
  workspacePickerPageSchema
} from "@planweave-ai/collaboration-contracts";
import { humanTransportAllowed } from "./http.js";
import { WorkspaceIdentityRepository } from "./workspaceRepository.js";

export type WorkspaceConnectionHttpOptions = {
  workspaceIdentity: WorkspaceIdentityRepository;
  allowInsecureDevelopment?: boolean;
};

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

function pageQuery(url: URL): { cursor: number; limit: number } {
  const allowed = new Set(["cursor", "limit"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new Error("workspace_connection_query_invalid");
    }
  }
  const parse = (key: "cursor" | "limit", fallback: number): number => {
    const value = url.searchParams.get(key);
    if (value === null) return fallback;
    if (!/^\d+$/.test(value)) throw new Error("workspace_connection_query_invalid");
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error("workspace_connection_query_invalid");
    return number;
  };
  const cursor = parse("cursor", 0);
  const limit = parse("limit", WORKSPACE_PICKER_MAX_ITEMS_PER_PAGE);
  if (limit < 1 || limit > WORKSPACE_PICKER_MAX_ITEMS_PER_PAGE) {
    throw new Error("workspace_connection_query_invalid");
  }
  return { cursor, limit };
}

function workspaceDeviceBearer(
  authorization: string | string[] | undefined
): string | undefined {
  if (Array.isArray(authorization) || authorization === undefined) return undefined;
  const match = /^Bearer (.+)$/.exec(authorization);
  if (!match) return undefined;
  const token = match[1]?.trim();
  const parsed = token ? humanDeviceTokenSchema.safeParse(token) : undefined;
  return parsed?.success ? parsed.data : undefined;
}

export async function handleWorkspaceConnectionHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkspaceConnectionHttpOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://planweave.invalid");
  if (url.pathname !== "/api/v1/workspace-connection") return false;
  if (request.method !== "GET") {
    request.resume();
    respond(response, 404, { error: "workspace_connection_not_found" });
    return true;
  }
  if (!humanTransportAllowed(request.socket, options.allowInsecureDevelopment)) {
    request.resume();
    respond(response, 426, { error: "workspace_connection_insecure_transport" });
    return true;
  }
  const token = workspaceDeviceBearer(request.headers.authorization);
  const authenticated = token
    ? options.workspaceIdentity.authenticateWorkspaceDevice(token)
    : undefined;
  if (!authenticated) {
    request.resume();
    respond(response, 401, { error: "workspace_connection_unauthorized" });
    return true;
  }
  try {
    const { cursor, limit } = pageQuery(url);
    const items = options.workspaceIdentity.listActiveWorkspacePickerItems(
      authenticated.humanPrincipalId
    );
    respond(
      response,
      200,
      workspacePickerPageSchema.parse({
        schemaVersion: "workspace-setup/v1",
        items: items.slice(cursor, cursor + limit),
        nextCursor: cursor + limit < items.length ? cursor + limit : null
      })
    );
  } catch (error) {
    request.resume();
    respond(response, 400, {
      error:
        error instanceof Error && error.message === "workspace_connection_query_invalid"
          ? error.message
          : "workspace_connection_request_failed"
    });
  }
  return true;
}

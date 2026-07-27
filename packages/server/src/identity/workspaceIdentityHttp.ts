import type { IncomingMessage, ServerResponse } from "node:http";
import {
  assertWorkspaceIdentityViewRedacted,
  opaqueIdentifierSchema
} from "@planweave-ai/collaboration-contracts";
import { z } from "zod";
import { OperatorTokenRegistry } from "../operatorAuth.js";
import {
  workspaceIdentityReadModelSchema,
  type WorkspaceIdentityReadModel
} from "./dtos.js";
import { WorkspaceIdentityRepository } from "./workspaceRepository.js";

export type WorkspaceIdentityHttpOptions = {
  authorization: OperatorTokenRegistry;
  repository: WorkspaceIdentityRepository;
  allowInsecureDevelopment?: boolean;
};

function isLoopback(address: string | undefined): boolean {
  return Boolean(
    address === "::1" ||
      address === "127.0.0.1" ||
      address?.startsWith("127.") ||
      address?.startsWith("::ffff:127.")
  );
}

function transportAllowed(
  socket: { encrypted?: boolean; remoteAddress?: string },
  allowInsecureDevelopment = false
): boolean {
  return socket.encrypted === true || (allowInsecureDevelopment && isLoopback(socket.remoteAddress));
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

function route(request: IncomingMessage): string | undefined {
  if (request.method !== "GET") return undefined;
  const pathname = new URL(request.url ?? "/", "http://planweave.invalid").pathname;
  const match = /^\/api\/v1\/workspaces\/([^/]+)\/identity$/.exec(pathname);
  if (!match) return undefined;
  try {
    return opaqueIdentifierSchema.parse(decodeURIComponent(match[1]));
  } catch {
    return undefined;
  }
}

function authorizeWorkspace(
  principal: { serverAdmin: boolean; projectIds: string[] },
  workspaceId: string,
  repository: WorkspaceIdentityRepository
): void {
  if (principal.serverAdmin) return;
  if (
    !principal.projectIds.some(
      (projectId) => repository.workspaceForLegacyProject(projectId) === workspaceId
    )
  ) {
    throw new Error("operator_workspace_forbidden");
  }
}

function readModel(
  repository: WorkspaceIdentityRepository,
  workspaceId: string
): WorkspaceIdentityReadModel {
  const model = workspaceIdentityReadModelSchema.parse({
    schemaVersion: "workspace-identity/v1",
    workspace: repository.workspaceView(workspaceId),
    principals: repository.listPrincipalViews(workspaceId),
    memberships: repository.listMembershipViews(workspaceId),
    hosts: repository.listHostViews(workspaceId, 1_000, 0),
    migration: repository.migrationStateView(workspaceId)
  });
  assertWorkspaceIdentityViewRedacted(model);
  return model;
}

function errorStatus(error: unknown): number {
  if (error instanceof z.ZodError) return 400;
  if (!(error instanceof Error)) return 500;
  if (error.message === "operator_workspace_forbidden") return 403;
  if (error.message === "workspace_not_found") return 404;
  if (error.message === "workspace_identity_read_cutover_incomplete") return 409;
  return 500;
}

export async function handleWorkspaceIdentityHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkspaceIdentityHttpOptions
): Promise<boolean> {
  const workspaceId = route(request);
  if (!workspaceId) return false;
  const url = new URL(request.url ?? "/", "http://planweave.invalid");
  if ([...url.searchParams.keys()].length > 0) {
    respond(response, 400, { error: "workspace_identity_query_invalid" });
    return true;
  }
  if (!transportAllowed(request.socket, options.allowInsecureDevelopment)) {
    request.resume();
    respond(response, 426, { error: "workspace_identity_insecure_transport" });
    return true;
  }
  const principal = options.authorization.authenticate(request.headers.authorization);
  if (!principal) {
    request.resume();
    respond(response, 401, { error: "operator_unauthorized" });
    return true;
  }
  try {
    if (!options.repository.workspaceExists(workspaceId)) {
      respond(response, 404, { error: "workspace_not_found" });
      return true;
    }
    authorizeWorkspace(principal, workspaceId, options.repository);
    respond(response, 200, readModel(options.repository, workspaceId));
  } catch (error) {
    request.resume();
    respond(response, errorStatus(error), {
      error:
        error instanceof Error && error.message === "operator_workspace_forbidden"
          ? "operator_workspace_forbidden"
          : error instanceof Error && error.message === "workspace_identity_read_cutover_incomplete"
            ? "workspace_identity_read_cutover_incomplete"
            : "workspace_identity_request_failed"
    });
  }
  return true;
}

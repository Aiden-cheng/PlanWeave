import {
  accessMutationRequestSchema,
  currentCanvasAccessViewSchema,
  effectiveAccessViewSchema
} from "@planweave-ai/collaboration-contracts";
import { opaqueIdentifierSchema } from "@planweave-ai/distributed-protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  authenticateCollaborationForProject,
  humanTransportAllowed,
  type HumanIdentityRepository,
  type HumanProjectAuthority
} from "./identity/index.js";
import type { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import type { ProjectAccessRepository } from "./projectAccessRepository.js";

const MAX_ACCESS_BODY_BYTES = 16 * 1024;

type AccessRoute =
  | { kind: "current"; projectId: string; canvasId: string }
  | { kind: "mutate"; projectId: string; canvasId: string };

export type AccessHttpOptions = {
  access: ProjectAccessRepository;
  repository: HumanIdentityRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  projectAuthority: HumanProjectAuthority;
  allowInsecureDevelopment?: boolean;
};

function decodeIdentifier(value: string): string | undefined {
  try {
    return opaqueIdentifierSchema.parse(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

function route(request: IncomingMessage, pathname: string): AccessRoute | undefined {
  const match = /^\/api\/v1\/projects\/([^/]+)\/canvases\/([^/]+)\/access$/.exec(pathname);
  if (!match) return undefined;
  const projectId = decodeIdentifier(match[1]);
  const canvasId = decodeIdentifier(match[2]);
  if (!projectId || !canvasId) return undefined;
  if (request.method === "GET") return { kind: "current", projectId, canvasId };
  if (request.method === "POST") return { kind: "mutate", projectId, canvasId };
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
    throw new Error("access_content_type_invalid");
  }
  const declaredLength = request.headers["content-length"];
  if (
    Array.isArray(declaredLength) ||
    (declaredLength !== undefined &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_ACCESS_BODY_BYTES))
  ) {
    throw new Error("access_body_too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_ACCESS_BODY_BYTES) throw new Error("access_body_too_large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("access_json_invalid");
  }
}

function workspaceIdFor(
  actor: Awaited<ReturnType<typeof authenticateCollaborationForProject>>,
  workspaceIdentity: WorkspaceIdentityRepository,
  projectId: string
): string | undefined {
  if (!actor) return undefined;
  return "kind" in actor && actor.kind === "workspace_device"
    ? actor.workspaceId
    : workspaceIdentity.workspaceForLegacyProject(projectId);
}

function safeError(error: unknown): { status: number; code: string } {
  if (error instanceof z.ZodError) return { status: 400, code: "access_request_invalid" };
  if (error instanceof Error && error.message === "access_body_too_large") {
    return { status: 413, code: error.message };
  }
  if (
    error instanceof Error &&
    (error.message === "access_content_type_invalid" || error.message === "access_json_invalid")
  ) {
    return { status: 400, code: "access_request_invalid" };
  }
  if (error instanceof Error && error.message === "access_scope_not_found") {
    return { status: 404, code: "access_scope_not_found" };
  }
  return { status: 500, code: "access_request_failed" };
}

/** Typed human-device ACL API. Scope identity is derived from the authenticated workspace. */
export async function handleAccessHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: AccessHttpOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://planweave.invalid");
  const matched = route(request, url.pathname);
  if (!matched) return false;
  try {
    if (!humanTransportAllowed(request.socket, options.allowInsecureDevelopment)) {
      request.resume();
      respond(response, 426, { error: "access_insecure_transport" });
      return true;
    }
    if (!options.projectAuthority.hasProject(matched.projectId)) {
      request.resume();
      respond(response, 404, { error: "access_scope_not_found" });
      return true;
    }
    const actor = authenticateCollaborationForProject(
      options.repository,
      options.workspaceIdentity,
      request.headers.authorization,
      matched.projectId
    );
    const workspaceId = workspaceIdFor(actor, options.workspaceIdentity, matched.projectId);
    if (!actor || !workspaceId) {
      request.resume();
      respond(response, 401, { error: "access_unauthorized" });
      return true;
    }
    const actorRef = { kind: "human" as const, id: actor.humanPrincipalId };
    if (matched.kind === "current") {
      const current = options.access.evaluateEffectiveAccess({
        workspaceId,
        projectId: matched.projectId,
        canvasId: matched.canvasId,
        actor: actorRef
      });
      if (!current.capabilities.read) {
        respond(response, 403, { error: current.disabledReason ?? "capability_denied" });
        return true;
      }
      const project = options.access.project(workspaceId, matched.projectId);
      const canvas = options.access.canvas(workspaceId, matched.projectId, matched.canvasId);
      if (!project || !canvas) throw new Error("access_scope_not_found");
      const people = options.workspaceIdentity.listMembershipViews(workspaceId).map((member) => {
        const membership = member.revokedAt === null ? "active" : "revoked";
        const view = options.access.evaluateEffectiveAccess({
          workspaceId,
          projectId: matched.projectId,
          canvasId: matched.canvasId,
          actor: { kind: "human", id: member.humanPrincipalId },
          session: membership === "active" ? "active" : "revoked"
        });
        return {
          humanPrincipalId: member.humanPrincipalId,
          displayName: member.displayName,
          membership,
          effectiveRole: view.effectiveRole,
          capabilities: view.capabilities,
          disabledReason: view.disabledReason
        };
      });
      respond(
        response,
        200,
        currentCanvasAccessViewSchema.parse({
          scope: { scopeKind: "canvas", workspaceId, projectId: matched.projectId, canvasId: matched.canvasId },
          projectVisibility: project.visibility,
          canvasVisibility: canvas.visibility,
          projectAclRevision: project.acl.revision,
          canvasAclRevision: canvas.acl.revision,
          current,
          people
        })
      );
      return true;
    }
    const mutation = accessMutationRequestSchema.parse(await readJson(request));
    if (
      mutation.scope.workspaceId !== workspaceId ||
      mutation.scope.projectId !== matched.projectId ||
      (mutation.scope.scopeKind === "canvas" && mutation.scope.canvasId !== matched.canvasId)
    ) {
      respond(response, 403, { error: "cross_workspace" });
      return true;
    }
    const result = options.access.compareAndSetAccess({ actor: actorRef, request: mutation });
    respond(response, result.status === "conflict" ? 409 : result.status === "denied" ? 403 : 200, result);
    return true;
  } catch (error) {
    request.resume();
    const safe = safeError(error);
    if (!response.headersSent) respond(response, safe.status, { error: safe.code });
    else response.destroy();
    return true;
  }
}

export { effectiveAccessViewSchema };

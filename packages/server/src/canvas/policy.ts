import type { ActorRef } from "@planweave-ai/collaboration-contracts";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { HumanAuthContext } from "../identity/schemas.js";

export type CanvasWriteAuthorization =
  | {
      ok: true;
      scope: { workspaceId: string; projectId: string; canvasId: string };
      projectRoot: string;
      packageDir: string;
      aclRevision: number;
    }
  | { ok: false; code: "unauthorized" | "forbidden" | "unknown_canvas" | "cross_scope" };

/**
 * OSS-002 ACL + OSS-003 actor/target scope for durable Canvas mutations.
 * Presence access is independent and must not be consulted here.
 */
export function authorizeCanvasWrite(input: {
  actor: HumanAuthContext;
  projectId: string;
  canvasId: string;
  access: ProjectAccessRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
}): CanvasWriteAuthorization {
  if (input.actor.projectId !== input.projectId) {
    return { ok: false, code: "cross_scope" };
  }
  const workspaceId = input.workspaceIdentity.workspaceForLegacyProject(input.projectId);
  if (!workspaceId) return { ok: false, code: "unknown_canvas" };

  const subject: ActorRef = { kind: "human", id: input.actor.humanPrincipalId };
  // Canvas ACL is independent of project visibility (OSS-002). A private project may
  // still expose a canvas editor grant without project-scope access.
  const canvasDecision = input.access.decideCanvasAccess({
    workspaceId,
    projectId: input.projectId,
    canvasId: input.canvasId,
    actor: subject
  });
  if (canvasDecision.decision !== "allow") {
    return {
      ok: false,
      code: canvasDecision.reason === "missing" ? "unknown_canvas" : "forbidden"
    };
  }

  try {
    input.access.policy.assertCanManage({
      workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId,
      actor: subject
    });
  } catch {
    return { ok: false, code: "forbidden" };
  }

  try {
    const location = input.access.resolveAuthorizedCanvas({
      workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId,
      actor: subject
    });
    return {
      ok: true,
      scope: {
        workspaceId,
        projectId: input.projectId,
        canvasId: input.canvasId
      },
      projectRoot: location.projectRoot,
      packageDir: location.packageDir,
      aclRevision: location.aclRevision
    };
  } catch {
    return { ok: false, code: "unknown_canvas" };
  }
}

export function authorizeCanvasRead(input: {
  actor: HumanAuthContext;
  projectId: string;
  canvasId: string;
  access: ProjectAccessRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
}): CanvasWriteAuthorization {
  if (input.actor.projectId !== input.projectId) {
    return { ok: false, code: "cross_scope" };
  }
  const workspaceId = input.workspaceIdentity.workspaceForLegacyProject(input.projectId);
  if (!workspaceId) return { ok: false, code: "unknown_canvas" };
  const subject: ActorRef = { kind: "human", id: input.actor.humanPrincipalId };
  const canvasDecision = input.access.decideCanvasAccess({
    workspaceId,
    projectId: input.projectId,
    canvasId: input.canvasId,
    actor: subject
  });
  if (canvasDecision.decision !== "allow") {
    return {
      ok: false,
      code: canvasDecision.reason === "missing" ? "unknown_canvas" : "forbidden"
    };
  }
  try {
    const location = input.access.resolveAuthorizedCanvas({
      workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId,
      actor: subject
    });
    return {
      ok: true,
      scope: {
        workspaceId,
        projectId: input.projectId,
        canvasId: input.canvasId
      },
      projectRoot: location.projectRoot,
      packageDir: location.packageDir,
      aclRevision: location.aclRevision
    };
  } catch {
    return { ok: false, code: "unknown_canvas" };
  }
}

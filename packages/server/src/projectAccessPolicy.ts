import {
  projectAccessDecisionSchema,
  type ActorRef,
  type ProjectAccessDecision,
  type ProjectAccessRecord,
  type CanvasAccessRecord
} from "@planweave-ai/collaboration-contracts";
import type { SqliteDatabase } from "./sqlite.js";
import {
  activeWorkspacePrincipal,
  canvasAccessRecord,
  type InternalCanvasRecord,
  type InternalProjectRecord,
  projectAccessRecord,
  ProjectRegistryRepository
} from "./projectRegistryRepository.js";
import { z } from "zod";

const pageLimitSchema = z.number().int().min(1).max(100);
const pageOffsetSchema = z.number().int().nonnegative();

function decision(decisionInput: ProjectAccessDecision): ProjectAccessDecision {
  return projectAccessDecisionSchema.parse(decisionInput);
}

function latestProjectGrant(
  database: SqliteDatabase,
  project: InternalProjectRecord,
  principalId: string
): Record<string, unknown> | undefined {
  return database
    .prepare(
      `SELECT role,revoked_at FROM project_access_grants WHERE workspace_id=? AND project_registry_id=? AND scope_kind='project' AND human_principal_id=? ORDER BY acl_revision DESC LIMIT 1`
    )
    .get(project.workspaceId, project.projectRegistryId, principalId);
}

function latestCanvasGrant(
  database: SqliteDatabase,
  canvas: InternalCanvasRecord,
  principalId: string
): Record<string, unknown> | undefined {
  return database
    .prepare(
      `SELECT role,revoked_at FROM project_access_grants WHERE workspace_id=? AND canvas_registry_id=? AND scope_kind='canvas' AND human_principal_id=? ORDER BY acl_revision DESC LIMIT 1`
    )
    .get(canvas.workspaceId, canvas.canvasRegistryId, principalId);
}

function hasActiveEditorGrant(grant: Record<string, unknown> | undefined): boolean {
  return grant?.revoked_at === null && grant.role === "editor";
}

/** ACL decisions are evaluated before the registry exposes any internal path. */
export class ProjectAccessPolicy {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly registry: ProjectRegistryRepository
  ) {}

  decideProject(input: {
    workspaceId: string;
    projectId: string;
    actor: ActorRef;
  }): ProjectAccessDecision {
    const project = this.registry.projectInternal(input.workspaceId, input.projectId);
    if (!project || project.revokedAt !== null)
      return decision({
        decision: "deny",
        reason: "missing",
        aclRevision: project?.aclRevision ?? 0
      });
    if (
      input.actor.kind !== "human" ||
      !activeWorkspacePrincipal(this.database, project.workspaceId, input.actor.id)
    )
      return decision({ decision: "deny", reason: "revoked", aclRevision: project.aclRevision });
    if (project.ownerHumanPrincipalId === input.actor.id || project.visibility === "shared")
      return decision({ decision: "allow", aclRevision: project.aclRevision });
    const grant = latestProjectGrant(this.database, project, input.actor.id);
    return grant && grant.revoked_at === null
      ? decision({ decision: "allow", aclRevision: project.aclRevision })
      : decision({
          decision: "deny",
          reason: grant ? "revoked" : "missing",
          aclRevision: project.aclRevision
        });
  }

  decideCanvas(input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    actor: ActorRef;
  }): ProjectAccessDecision {
    const canvas = this.registry.canvasInternal(input.workspaceId, input.projectId, input.canvasId);
    if (!canvas || canvas.revokedAt !== null)
      return decision({
        decision: "deny",
        reason: "missing",
        aclRevision: canvas?.aclRevision ?? 0
      });
    const project = this.registry.projectInternal(input.workspaceId, input.projectId);
    if (!project || project.revokedAt !== null)
      return decision({ decision: "deny", reason: "revoked", aclRevision: canvas.aclRevision });
    if (
      input.actor.kind !== "human" ||
      !activeWorkspacePrincipal(this.database, canvas.workspaceId, input.actor.id)
    )
      return decision({ decision: "deny", reason: "revoked", aclRevision: canvas.aclRevision });
    // Canvas sharing is independent. A private Project may expose one shared
    // Canvas without granting project or sibling-canvas access.
    if (canvas.ownerHumanPrincipalId === input.actor.id || canvas.visibility === "shared")
      return decision({ decision: "allow", aclRevision: canvas.aclRevision });
    const grant = latestCanvasGrant(this.database, canvas, input.actor.id);
    return grant && grant.revoked_at === null
      ? decision({ decision: "allow", aclRevision: canvas.aclRevision })
      : decision({
          decision: "deny",
          reason: grant ? "revoked" : "missing",
          aclRevision: canvas.aclRevision
        });
  }

  listProjects(input: {
    workspaceId: string;
    actor: ActorRef;
    limit?: number;
    offset?: number;
  }): ProjectAccessRecord[] {
    const limit = pageLimitSchema.parse(input.limit ?? 100);
    const offset = pageOffsetSchema.parse(input.offset ?? 0);
    if (input.actor.kind !== "human") return [];
    const rows = this.database
      .prepare(`
      SELECT p.*
      FROM project_registry p
      WHERE p.workspace_id=?
        AND p.revoked_at IS NULL
        AND p.owner_human_principal_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM workspace_principals wp
          JOIN workspace_memberships wm
            ON wm.workspace_id=wp.workspace_id
           AND wm.human_principal_id=wp.human_principal_id
          WHERE wp.workspace_id=p.workspace_id
            AND wp.human_principal_id=?
            AND wp.revoked_at IS NULL
            AND wm.revoked_at IS NULL
        )
        AND (
          p.owner_human_principal_id=?
          OR p.visibility='shared'
          OR EXISTS (
            SELECT 1 FROM project_access_grants g
            WHERE g.workspace_id=p.workspace_id
              AND g.project_registry_id=p.project_registry_id
              AND g.scope_kind='project'
              AND g.human_principal_id=?
              AND g.revoked_at IS NULL
          )
        )
      ORDER BY p.project_registry_id
      LIMIT ? OFFSET ?
    `)
      .all(
        input.workspaceId,
        input.actor.id,
        input.actor.id,
        input.actor.id,
        limit,
        offset
      ) as Array<Record<string, unknown>>;
    return rows.map((row) => projectAccessRecord(rowToProject(row)));
  }

  listCanvases(input: {
    workspaceId: string;
    projectId: string;
    actor: ActorRef;
    limit?: number;
    offset?: number;
  }): CanvasAccessRecord[] {
    const limit = pageLimitSchema.parse(input.limit ?? 100);
    const offset = pageOffsetSchema.parse(input.offset ?? 0);
    if (input.actor.kind !== "human") return [];
    const rows = this.database
      .prepare(`
      SELECT c.*
      FROM canvas_registry c
      JOIN project_registry p
        ON p.workspace_id=c.workspace_id
       AND p.project_id=c.project_id
       AND p.project_registry_id=c.project_registry_id
      WHERE c.workspace_id=?
        AND c.project_id=?
        AND c.revoked_at IS NULL
        AND p.revoked_at IS NULL
        AND c.owner_human_principal_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM workspace_principals wp
          JOIN workspace_memberships wm
            ON wm.workspace_id=wp.workspace_id
           AND wm.human_principal_id=wp.human_principal_id
          WHERE wp.workspace_id=c.workspace_id
            AND wp.human_principal_id=?
            AND wp.revoked_at IS NULL
            AND wm.revoked_at IS NULL
        )
        AND (
          c.owner_human_principal_id=?
          OR c.visibility='shared'
          OR EXISTS (
            SELECT 1 FROM project_access_grants g
            WHERE g.workspace_id=c.workspace_id
              AND g.canvas_registry_id=c.canvas_registry_id
              AND g.scope_kind='canvas'
              AND g.human_principal_id=?
              AND g.revoked_at IS NULL
          )
        )
      ORDER BY c.canvas_registry_id
      LIMIT ? OFFSET ?
    `)
      .all(
        input.workspaceId,
        input.projectId,
        input.actor.id,
        input.actor.id,
        input.actor.id,
        limit,
        offset
      ) as Array<Record<string, unknown>>;
    return rows.map((row) => canvasAccessRecord(rowToCanvas(row)));
  }

  assertCanManage(input: {
    workspaceId: string;
    projectId: string;
    canvasId?: string;
    actor: ActorRef;
    bootstrap?: boolean;
  }): void {
    if (input.actor.kind === "local_admin") {
      if (input.bootstrap === true) return;
      throw new Error("local_admin_bootstrap_only");
    }
    if (input.actor.kind !== "human") throw new Error("grantor_not_authorized");
    const project = this.registry.projectInternal(input.workspaceId, input.projectId);
    if (
      !project ||
      project.revokedAt !== null ||
      !activeWorkspacePrincipal(this.database, input.workspaceId, input.actor.id)
    )
      throw new Error("grantor_not_authorized");
    if (project.ownerHumanPrincipalId === input.actor.id) return;
    if (!input.canvasId) {
      if (hasActiveEditorGrant(latestProjectGrant(this.database, project, input.actor.id))) return;
      throw new Error("grantor_role_insufficient");
    }
    const canvas = this.registry.canvasInternal(input.workspaceId, input.projectId, input.canvasId);
    if (!canvas || canvas.revokedAt !== null) throw new Error("grantor_not_authorized");
    if (canvas.ownerHumanPrincipalId === input.actor.id) return;
    if (hasActiveEditorGrant(latestCanvasGrant(this.database, canvas, input.actor.id))) return;
    // Project editors manage project-scope grants only; canvas ACLs remain
    // independently owned so a project editor cannot widen a canvas grant.
    throw new Error("grantor_role_insufficient");
  }
}

function rowToProject(row: Record<string, unknown>): InternalProjectRecord {
  return {
    projectRegistryId: String(row.project_registry_id),
    workspaceId: String(row.workspace_id),
    projectId: String(row.project_id),
    projectRoot: row.project_root_internal === null ? null : String(row.project_root_internal),
    visibility: row.visibility as InternalProjectRecord["visibility"],
    ownerHumanPrincipalId:
      row.owner_human_principal_id === null ? null : String(row.owner_human_principal_id),
    aclRevision: Number(row.acl_revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at)
  };
}

function rowToCanvas(row: Record<string, unknown>): InternalCanvasRecord {
  return {
    canvasRegistryId: String(row.canvas_registry_id),
    projectRegistryId: String(row.project_registry_id),
    workspaceId: String(row.workspace_id),
    projectId: String(row.project_id),
    canvasId: String(row.canvas_id),
    packageDir: row.package_dir_internal === null ? null : String(row.package_dir_internal),
    visibility: row.visibility as InternalCanvasRecord["visibility"],
    ownerHumanPrincipalId:
      row.owner_human_principal_id === null ? null : String(row.owner_human_principal_id),
    aclRevision: Number(row.acl_revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at)
  };
}

import { createHash } from "node:crypto";
import {
  aclRevisionSchema,
  actorRefSchema,
  membershipGrantSchema,
  type ActorRef,
  type MembershipGrant,
  type ProjectAccessDecision,
  type ProjectAccessRecord,
  type CanvasAccessRecord
} from "@planweave-ai/collaboration-contracts";
import { z } from "zod";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";
import { ProjectAccessPolicy } from "./projectAccessPolicy.js";
import {
  ProjectRegistryRepository,
  type InternalCanvasRecord,
  type InternalProjectRecord,
  activeWorkspacePrincipal
} from "./projectRegistryRepository.js";

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const grantInputSchema = z
  .object({
    workspaceId: identifierSchema,
    projectId: identifierSchema,
    canvasId: identifierSchema.nullable().default(null),
    humanPrincipalId: identifierSchema,
    role: z.enum(["owner", "editor", "viewer"]),
    grantedBy: actorRefSchema
  })
  .strict();
const revokeInputSchema = z
  .object({
    workspaceId: identifierSchema,
    projectId: identifierSchema,
    canvasId: identifierSchema.nullable().default(null),
    grantId: identifierSchema,
    actor: actorRefSchema,
    expectedAclRevision: aclRevisionSchema
  })
  .strict();

/** Grant/revocation persistence composed with the registry and policy boundaries. */
export class ProjectAccessRepository {
  readonly registry: ProjectRegistryRepository;
  readonly policy: ProjectAccessPolicy;

  constructor(
    private readonly database: SqliteDatabase,
    clock: () => Date = () => new Date()
  ) {
    this.registry = new ProjectRegistryRepository(database, clock);
    this.policy = new ProjectAccessPolicy(database, this.registry);
    this.clock = clock;
  }

  private readonly clock: () => Date;

  registerProjectInternal(input: unknown): InternalProjectRecord {
    return this.registry.registerProjectInternal(input);
  }
  registerCanvasInternal(input: unknown): InternalCanvasRecord {
    return this.registry.registerCanvasInternal(input);
  }
  initializeProjectOwner(
    workspaceId: string,
    projectId: string,
    ownerHumanPrincipalId: string
  ): InternalProjectRecord {
    return this.registry.initializeProjectOwner(workspaceId, projectId, ownerHumanPrincipalId);
  }
  initializeCanvasOwner(
    workspaceId: string,
    projectId: string,
    canvasId: string,
    ownerHumanPrincipalId: string
  ): InternalCanvasRecord {
    return this.registry.initializeCanvasOwner(
      workspaceId,
      projectId,
      canvasId,
      ownerHumanPrincipalId
    );
  }
  registerProject(input: unknown): ProjectAccessRecord | undefined {
    return this.registry.registerProject(input);
  }
  registerCanvas(input: unknown): CanvasAccessRecord | undefined {
    return this.registry.registerCanvas(input);
  }
  project(workspaceId: string, projectId: string): ProjectAccessRecord | undefined {
    return this.registry.project(workspaceId, projectId);
  }
  canvas(workspaceId: string, projectId: string, canvasId: string): CanvasAccessRecord | undefined {
    return this.registry.canvas(workspaceId, projectId, canvasId);
  }
  decideProjectAccess(input: {
    workspaceId: string;
    projectId: string;
    actor: ActorRef;
  }): ProjectAccessDecision {
    return this.policy.decideProject(input);
  }
  decideCanvasAccess(input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    actor: ActorRef;
  }): ProjectAccessDecision {
    return this.policy.decideCanvas(input);
  }
  listAuthorizedProjects(input: {
    workspaceId: string;
    actor: ActorRef;
    limit?: number;
    offset?: number;
  }): ProjectAccessRecord[] {
    return this.policy.listProjects(input);
  }
  listAuthorizedCanvases(input: {
    workspaceId: string;
    projectId: string;
    actor: ActorRef;
    limit?: number;
    offset?: number;
  }): CanvasAccessRecord[] {
    return this.policy.listCanvases(input);
  }
  bindProjectPath(workspaceId: string, projectId: string, projectRoot: string): void {
    this.registry.bindProjectPath(workspaceId, projectId, projectRoot);
  }
  bindCanvasPath(
    workspaceId: string,
    projectId: string,
    canvasId: string,
    packageDir: string
  ): void {
    this.registry.bindCanvasPath(workspaceId, projectId, canvasId, packageDir);
  }
  markCanvasCutover(workspaceId: string, projectId: string, canvasId: string): void {
    this.registry.markCanvasCutover(workspaceId, projectId, canvasId);
  }
  finalizeProjectCutover(workspaceId: string, projectId: string): void {
    this.registry.finalizeProjectCutover(workspaceId, projectId);
  }

  resolveAuthorizedCanvas(input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    actor: ActorRef;
  }): {
    scope: { workspaceId: string; projectId: string; canvasId: string };
    projectRoot: string;
    packageDir: string;
    aclRevision: number;
  } {
    const decision = this.policy.decideCanvas(input);
    if (decision.decision !== "allow") throw new Error(`canvas_access_denied:${decision.reason}`);
    return {
      ...this.registry.resolveCanvasPath({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        canvasId: input.canvasId
      }),
      aclRevision: decision.aclRevision
    };
  }

  grant(rawInput: unknown): MembershipGrant {
    const input = grantInputSchema.parse(rawInput);
    if (input.role === "owner") throw new Error("project_owner_grant_forbidden");
    this.policy.assertCanManage({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId ?? undefined,
      actor: input.grantedBy
    });
    return inWriteTransaction(this.database, () => {
      const project = this.registry.projectInternal(input.workspaceId, input.projectId);
      if (!project || project.revokedAt !== null) throw new Error("project_registry_not_found");
      if (!activeWorkspacePrincipal(this.database, input.workspaceId, input.humanPrincipalId))
        throw new Error("access_grant_principal_not_active");
      const canvas =
        input.canvasId === null
          ? undefined
          : this.registry.canvasInternal(input.workspaceId, input.projectId, input.canvasId);
      if (input.canvasId !== null && !canvas) throw new Error("canvas_registry_not_found");
      const scopeId = canvas?.canvasRegistryId ?? project.projectRegistryId;
      const currentRevision = canvas?.aclRevision ?? project.aclRevision;
      const revision = currentRevision + 1;
      const at = this.clock().toISOString();
      const grantId = `grant-${createHash("sha256")
        .update(
          [
            input.workspaceId,
            input.projectId,
            input.canvasId ?? "",
            input.humanPrincipalId,
            String(revision)
          ].join("\0")
        )
        .digest("hex")
        .slice(0, 32)}`;
      const updatedScope = this.database
        .prepare(
          `UPDATE ${canvas ? "canvas_registry" : "project_registry"} SET acl_revision=?,updated_at=? WHERE ${canvas ? "canvas_registry_id=?" : "project_registry_id=?"} AND acl_revision=?`
        )
        .run(revision, at, scopeId, currentRevision);
      if (updatedScope.changes !== 1) throw new Error("access_grant_stale_revision");
      this.database
        .prepare(
          `INSERT INTO project_access_grants(grant_id,workspace_id,project_registry_id,project_id,canvas_registry_id,canvas_id,scope_kind,human_principal_id,role,acl_revision,granted_by_kind,granted_by_id,granted_at,revoked_at) VALUES(?,?,?,?,?,?,?, ?,?,?, ?,?,?,NULL)`
        )
        .run(
          grantId,
          input.workspaceId,
          project.projectRegistryId,
          input.projectId,
          canvas?.canvasRegistryId ?? null,
          canvas?.canvasId ?? null,
          canvas ? "canvas" : "project",
          input.humanPrincipalId,
          input.role,
          revision,
          input.grantedBy.kind,
          input.grantedBy.id,
          at
        );
      return membershipGrantSchema.parse({
        schemaVersion: "project-access/v1",
        grantId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        humanPrincipalId: input.humanPrincipalId,
        role: input.role,
        aclRevision: revision,
        grantedBy: input.grantedBy,
        grantedAt: at,
        revokedAt: null,
        scopeKind: canvas ? "canvas" : "project",
        canvasId: canvas?.canvasId ?? null
      });
    });
  }

  revoke(rawInput: unknown): MembershipGrant {
    const input = revokeInputSchema.parse(rawInput);
    const id = input.grantId;
    const expected = input.expectedAclRevision;
    return inWriteTransaction(this.database, () => {
      this.policy.assertCanManage({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        canvasId: input.canvasId ?? undefined,
        actor: input.actor
      });
      const row = this.database
        .prepare(`
        SELECT * FROM project_access_grants
        WHERE grant_id=? AND workspace_id=? AND project_id=?
          AND ((scope_kind='project' AND canvas_id IS NULL AND ? IS NULL)
            OR (scope_kind='canvas' AND canvas_id=?))
      `)
        .get(id, input.workspaceId, input.projectId, input.canvasId, input.canvasId) as
        | Record<string, unknown>
        | undefined;
      if (!row) throw new Error("access_grant_not_found");
      const scopeColumn =
        row.scope_kind === "canvas" ? "canvas_registry_id" : "project_registry_id";
      const scopeId = row[scopeColumn];
      const scope = this.database
        .prepare(
          `SELECT acl_revision FROM ${row.scope_kind === "canvas" ? "canvas_registry" : "project_registry"} WHERE ${scopeColumn}=?`
        )
        .get(scopeId) as { acl_revision: number } | undefined;
      if (row.revoked_at !== null) {
        if (
          scope &&
          Number(scope.acl_revision) === Number(row.acl_revision) &&
          (expected === Number(row.acl_revision) || expected + 1 === Number(row.acl_revision))
        )
          return this.grantFromRow(row);
        throw new Error("access_grant_stale_revision");
      }
      if (!scope || Number(scope.acl_revision) !== expected)
        throw new Error("access_grant_stale_revision");
      const at = this.clock().toISOString();
      const nextRevision = expected + 1;
      const updatedScope = this.database
        .prepare(
          `UPDATE ${row.scope_kind === "canvas" ? "canvas_registry" : "project_registry"} SET acl_revision=?,updated_at=? WHERE ${scopeColumn}=? AND acl_revision=?`
        )
        .run(nextRevision, at, scopeId, expected);
      if (updatedScope.changes !== 1) throw new Error("access_grant_stale_revision");
      const revoked = this.database
        .prepare(
          "UPDATE project_access_grants SET revoked_at=?,acl_revision=? WHERE grant_id=? AND revoked_at IS NULL"
        )
        .run(at, nextRevision, id);
      if (revoked.changes !== 1) throw new Error("access_grant_revision_conflict");
      return this.grantFromRow(
        this.database
          .prepare("SELECT * FROM project_access_grants WHERE grant_id=?")
          .get(id) as Record<string, unknown>
      );
    });
  }

  private grantFromRow(row: Record<string, unknown>): MembershipGrant {
    return membershipGrantSchema.parse({
      schemaVersion: "project-access/v1",
      grantId: row.grant_id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      humanPrincipalId: row.human_principal_id,
      role: row.role,
      aclRevision: Number(row.acl_revision),
      grantedBy: { kind: row.granted_by_kind, id: row.granted_by_id },
      grantedAt: row.granted_at,
      revokedAt: row.revoked_at,
      scopeKind: row.scope_kind,
      canvasId: row.canvas_id
    });
  }
}

export { ProjectAccessPolicy } from "./projectAccessPolicy.js";
export { ProjectRegistryRepository } from "./projectRegistryRepository.js";
export type { InternalCanvasRecord, InternalProjectRecord } from "./projectRegistryRepository.js";

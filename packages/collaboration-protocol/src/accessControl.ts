import { z } from "zod";
import {
  aclRevisionSchema,
  canvasAccessRecordSchema,
  membershipGrantSchema,
  projectAccessRecordSchema,
  projectAccessRoleSchema,
  type MembershipGrant,
  type ProjectAccessRole
} from "./projectAccess.js";
import {
  humanPrincipalIdSchema,
  membershipGrantIdSchema,
  timestampSchema,
  workspaceIdSchema
} from "./primitives.js";

export const accessCapabilities = [
  "list",
  "read",
  "persistent_canvas_command",
  "assignment",
  "comment",
  "grant",
  "revoke",
  "administration",
  "visibility"
] as const;

export const accessCapabilitySchema = z.enum(accessCapabilities);
export type AccessCapability = z.infer<typeof accessCapabilitySchema>;

/**
 * The only role-to-capability mapping for human collaboration surfaces. Server
 * authorization and Desktop read models must consume this matrix rather than
 * deriving write access from visibility.
 */
export const accessCapabilityMatrix: Readonly<
  Record<ProjectAccessRole, readonly AccessCapability[]>
> = Object.freeze({
  viewer: Object.freeze(["list", "read"] as const),
  editor: Object.freeze([
    "list",
    "read",
    "persistent_canvas_command",
    "assignment",
    "comment"
  ] as const),
  owner: Object.freeze([...accessCapabilities])
});

export function roleHasAccessCapability(
  role: ProjectAccessRole,
  capability: AccessCapability
): boolean {
  return accessCapabilityMatrix[role].includes(capability);
}

const accessScopeBaseSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    projectId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  })
  .strict();

/** Explicit discriminant prevents an implicit project/canvas scope fallback. */
export const projectAccessScopeSchema = accessScopeBaseSchema
  .extend({ scopeKind: z.literal("project"), canvasId: z.null() })
  .strict();
export const canvasAccessScopeSchema = accessScopeBaseSchema
  .extend({
    scopeKind: z.literal("canvas"),
    canvasId: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  })
  .strict();
export const accessScopeSchema = z.discriminatedUnion("scopeKind", [
  projectAccessScopeSchema,
  canvasAccessScopeSchema
]);
export type AccessScope = z.infer<typeof accessScopeSchema>;

export const accessMembershipStateSchema = z.enum(["active", "missing", "revoked"]);
export type AccessMembershipState = z.infer<typeof accessMembershipStateSchema>;

export const accessSessionStateSchema = z.enum(["active", "missing", "expired", "revoked"]);
export type AccessSessionState = z.infer<typeof accessSessionStateSchema>;

export const effectiveRoleSourceSchema = z.enum([
  "scope_owner",
  "canvas_grant",
  "project_grant",
  "shared_workspace_membership"
]);
export type EffectiveRoleSource = z.infer<typeof effectiveRoleSourceSchema>;

/** Redacted reasons are stable UI/HTTP codes, never storage or credential details. */
export const accessDisabledReasonSchema = z.enum([
  "membership_missing",
  "membership_revoked",
  "session_missing",
  "session_expired",
  "session_revoked",
  "scope_private",
  "grant_revoked",
  "capability_denied",
  "acl_revision_conflict",
  "cross_workspace",
  "cross_project",
  "cross_canvas"
]);
export type AccessDisabledReason = z.infer<typeof accessDisabledReasonSchema>;

export const accessCapabilityFlagsSchema = z
  .object({
    list: z.boolean(),
    read: z.boolean(),
    persistent_canvas_command: z.boolean(),
    assignment: z.boolean(),
    comment: z.boolean(),
    grant: z.boolean(),
    revoke: z.boolean(),
    administration: z.boolean(),
    visibility: z.boolean()
  })
  .strict();
export type AccessCapabilityFlags = z.infer<typeof accessCapabilityFlagsSchema>;

export function accessCapabilityFlags(role: ProjectAccessRole | null): AccessCapabilityFlags {
  return accessCapabilityFlagsSchema.parse({
    list: role !== null && roleHasAccessCapability(role, "list"),
    read: role !== null && roleHasAccessCapability(role, "read"),
    persistent_canvas_command:
      role !== null && roleHasAccessCapability(role, "persistent_canvas_command"),
    assignment: role !== null && roleHasAccessCapability(role, "assignment"),
    comment: role !== null && roleHasAccessCapability(role, "comment"),
    grant: role !== null && roleHasAccessCapability(role, "grant"),
    revoke: role !== null && roleHasAccessCapability(role, "revoke"),
    administration: role !== null && roleHasAccessCapability(role, "administration"),
    visibility: role !== null && roleHasAccessCapability(role, "visibility")
  });
}

function capabilityFlagsMatchRole(
  capabilities: AccessCapabilityFlags,
  role: ProjectAccessRole | null
): boolean {
  return accessCapabilities.every(
    (capability) =>
      capabilities[capability] === (role !== null && roleHasAccessCapability(role, capability))
  );
}

export const effectiveAccessViewSchema = z
  .object({
    scope: accessScopeSchema,
    aclRevision: aclRevisionSchema,
    effectiveRole: projectAccessRoleSchema.nullable(),
    roleSource: effectiveRoleSourceSchema.nullable(),
    capabilities: accessCapabilityFlagsSchema,
    disabledReason: accessDisabledReasonSchema.nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.effectiveRole === null) !== (value.roleSource === null)) {
      ctx.addIssue({ code: "custom", message: "effective_role_source_mismatch" });
    }
    if (value.effectiveRole !== null && value.disabledReason !== null) {
      ctx.addIssue({ code: "custom", message: "authorized_access_must_not_have_disabled_reason" });
    }
    if (!capabilityFlagsMatchRole(value.capabilities, value.effectiveRole)) {
      ctx.addIssue({ code: "custom", message: "effective_role_capability_mismatch" });
    }
  });
export type EffectiveAccessView = z.infer<typeof effectiveAccessViewSchema>;

/**
 * Server-only input for the pure evaluator. Its exact target and the two scoped
 * grants make inheritance explicit: canvas grant, then project grant, then the
 * target scope's shared-membership viewer default.
 */
export const effectiveAccessEvaluationSchema = z
  .object({
    scope: accessScopeSchema,
    humanPrincipalId: humanPrincipalIdSchema,
    membership: accessMembershipStateSchema,
    session: accessSessionStateSchema,
    project: projectAccessRecordSchema,
    canvas: canvasAccessRecordSchema.nullable(),
    projectGrant: membershipGrantSchema.nullable(),
    canvasGrant: membershipGrantSchema.nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    const project = value.project.registry;
    if (
      project.workspaceId !== value.scope.workspaceId ||
      project.projectId !== value.scope.projectId
    ) {
      ctx.addIssue({ code: "custom", message: "cross_project", path: ["project"] });
    }
    if (value.scope.scopeKind === "project" && value.canvas !== null) {
      ctx.addIssue({ code: "custom", message: "project_scope_must_not_supply_canvas" });
    }
    if (value.scope.scopeKind === "canvas") {
      if (value.canvas === null) {
        ctx.addIssue({ code: "custom", message: "canvas_scope_requires_canvas", path: ["canvas"] });
      } else if (
        value.canvas.registry.workspaceId !== value.scope.workspaceId ||
        value.canvas.registry.projectId !== value.scope.projectId ||
        value.canvas.registry.canvasId !== value.scope.canvasId
      ) {
        ctx.addIssue({ code: "custom", message: "cross_canvas", path: ["canvas"] });
      }
    }
    const checkGrant = (grant: MembershipGrant | null, expected: "project" | "canvas") => {
      if (grant === null) return;
      if (
        grant.scopeKind !== expected ||
        grant.workspaceId !== value.scope.workspaceId ||
        grant.projectId !== value.scope.projectId ||
        grant.humanPrincipalId !== value.humanPrincipalId ||
        (expected === "canvas" && grant.canvasId !== value.scope.canvasId)
      ) {
        ctx.addIssue({ code: "custom", message: "grant_scope_mismatch" });
      }
    };
    checkGrant(value.projectGrant, "project");
    checkGrant(value.canvasGrant, "canvas");
    if (value.scope.scopeKind === "project" && value.canvasGrant !== null) {
      ctx.addIssue({ code: "custom", message: "project_scope_must_not_supply_canvas_grant" });
    }
  });
export type EffectiveAccessEvaluation = z.infer<typeof effectiveAccessEvaluationSchema>;

function deniedAccess(
  input: EffectiveAccessEvaluation,
  reason: AccessDisabledReason
): EffectiveAccessView {
  const aclRevision = input.canvas?.acl.revision ?? input.project.acl.revision;
  return effectiveAccessViewSchema.parse({
    scope: input.scope,
    aclRevision,
    effectiveRole: null,
    roleSource: null,
    capabilities: accessCapabilityFlags(null),
    disabledReason: reason
  });
}

/**
 * Evaluate one exact scope. A shared target gives active members viewer only;
 * no visibility state can grant a persistent write capability.
 */
export function evaluateEffectiveAccess(input: EffectiveAccessEvaluation): EffectiveAccessView {
  const parsed = effectiveAccessEvaluationSchema.parse(input);
  if (parsed.membership === "missing") return deniedAccess(parsed, "membership_missing");
  if (parsed.membership === "revoked") return deniedAccess(parsed, "membership_revoked");
  if (parsed.session === "missing") return deniedAccess(parsed, "session_missing");
  if (parsed.session === "expired") return deniedAccess(parsed, "session_expired");
  if (parsed.session === "revoked") return deniedAccess(parsed, "session_revoked");

  const target = parsed.canvas ?? parsed.project;
  let role: ProjectAccessRole | null = null;
  let roleSource: EffectiveRoleSource | null = null;
  if (target.owner === parsed.humanPrincipalId) {
    role = "owner";
    roleSource = "scope_owner";
  } else if (parsed.canvasGrant?.revokedAt === null) {
    role = parsed.canvasGrant.role;
    roleSource = "canvas_grant";
  } else if (parsed.projectGrant?.revokedAt === null) {
    role = parsed.projectGrant.role;
    roleSource = "project_grant";
  } else if (target.visibility === "shared") {
    role = "viewer";
    roleSource = "shared_workspace_membership";
  }

  if (role === null) {
    const grantRevoked =
      (parsed.canvasGrant !== null && parsed.canvasGrant.revokedAt !== null) ||
      (parsed.projectGrant !== null && parsed.projectGrant.revokedAt !== null);
    return deniedAccess(parsed, grantRevoked ? "grant_revoked" : "scope_private");
  }
  return effectiveAccessViewSchema.parse({
    scope: parsed.scope,
    aclRevision: target.acl.revision,
    effectiveRole: role,
    roleSource,
    capabilities: accessCapabilityFlags(role),
    disabledReason: null
  });
}

export const accessMutationKindSchema = z.enum(["grant", "revoke", "visibility"]);
export type AccessMutationKind = z.infer<typeof accessMutationKindSchema>;

export function requiredCapabilityForAccessMutation(kind: AccessMutationKind): AccessCapability {
  if (kind === "grant") return "grant";
  if (kind === "revoke") return "revoke";
  return "visibility";
}

const casAccessMutationBaseSchema = z
  .object({ scope: accessScopeSchema, expectedAclRevision: aclRevisionSchema })
  .strict();

export const accessGrantMutationRequestSchema = casAccessMutationBaseSchema
  .extend({
    operation: z.literal("grant"),
    humanPrincipalId: humanPrincipalIdSchema,
    role: z.enum(["editor", "viewer"])
  })
  .strict();
export type AccessGrantMutationRequest = z.infer<typeof accessGrantMutationRequestSchema>;

export const accessRevokeMutationRequestSchema = casAccessMutationBaseSchema
  .extend({ operation: z.literal("revoke"), grantId: membershipGrantIdSchema })
  .strict();
export type AccessRevokeMutationRequest = z.infer<typeof accessRevokeMutationRequestSchema>;

export const accessVisibilityMutationRequestSchema = casAccessMutationBaseSchema
  .extend({ operation: z.literal("visibility"), visibility: z.enum(["private", "shared"]) })
  .strict();
export type AccessVisibilityMutationRequest = z.infer<typeof accessVisibilityMutationRequestSchema>;

export const accessMutationRequestSchema = z.discriminatedUnion("operation", [
  accessGrantMutationRequestSchema,
  accessRevokeMutationRequestSchema,
  accessVisibilityMutationRequestSchema
]);
export type AccessMutationRequest = z.infer<typeof accessMutationRequestSchema>;

/** Server injects authenticated workspace authority and rejects client scope drift. */
export const serverAccessMutationContextSchema = z
  .object({ authenticatedWorkspaceId: workspaceIdSchema, request: accessMutationRequestSchema })
  .strict()
  .superRefine((value, ctx) => {
    if (value.request.scope.workspaceId !== value.authenticatedWorkspaceId) {
      ctx.addIssue({
        code: "custom",
        message: "cross_workspace",
        path: ["request", "scope", "workspaceId"]
      });
    }
  });
export type ServerAccessMutationContext = z.infer<typeof serverAccessMutationContextSchema>;

export const accessMutationResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("applied"),
      aclRevision: aclRevisionSchema,
      updatedAt: timestampSchema
    })
    .strict(),
  z
    .object({
      status: z.literal("conflict"),
      reason: z.literal("acl_revision_conflict"),
      aclRevision: aclRevisionSchema
    })
    .strict(),
  z
    .object({
      status: z.literal("denied"),
      reason: accessDisabledReasonSchema,
      aclRevision: aclRevisionSchema
    })
    .strict()
]);
export type AccessMutationResult = z.infer<typeof accessMutationResultSchema>;

/** Active grant metadata needed to issue one exact-scope revoke; authority details stay server-side. */
export const activeCanvasPersonGrantSchema = z
  .object({
    grantId: membershipGrantIdSchema,
    scopeKind: z.enum(["project", "canvas"]),
    role: z.enum(["editor", "viewer"])
  })
  .strict();
export type ActiveCanvasPersonGrant = z.infer<typeof activeCanvasPersonGrantSchema>;

/** Renderer-safe current-canvas People row: no token, digest, local path, or session identifier. */
export const canvasPersonAccessViewSchema = z
  .object({
    humanPrincipalId: humanPrincipalIdSchema,
    displayName: z.string().trim().min(1).max(128),
    membership: accessMembershipStateSchema,
    effectiveRole: projectAccessRoleSchema.nullable(),
    capabilities: accessCapabilityFlagsSchema,
    disabledReason: accessDisabledReasonSchema.nullable(),
    grants: z.array(activeCanvasPersonGrantSchema).max(2)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!capabilityFlagsMatchRole(value.capabilities, value.effectiveRole)) {
      ctx.addIssue({ code: "custom", message: "person_effective_role_capability_mismatch" });
    }
    if (value.effectiveRole !== null && value.disabledReason !== null) {
      ctx.addIssue({ code: "custom", message: "authorized_person_must_not_have_disabled_reason" });
    }
    if (new Set(value.grants.map((grant) => grant.scopeKind)).size !== value.grants.length) {
      ctx.addIssue({ code: "custom", message: "duplicate_person_grant_scope" });
    }
  });
export type CanvasPersonAccessView = z.infer<typeof canvasPersonAccessViewSchema>;

export const currentCanvasAccessViewSchema = z
  .object({
    scope: canvasAccessScopeSchema,
    projectVisibility: z.enum(["private", "shared"]),
    canvasVisibility: z.enum(["private", "shared"]),
    projectAclRevision: aclRevisionSchema,
    canvasAclRevision: aclRevisionSchema,
    project: effectiveAccessViewSchema,
    canvas: effectiveAccessViewSchema,
    people: z.array(canvasPersonAccessViewSchema).max(1_000)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.project.scope.scopeKind !== "project" ||
      value.project.scope.workspaceId !== value.scope.workspaceId ||
      value.project.scope.projectId !== value.scope.projectId ||
      value.project.scope.canvasId !== null ||
      value.project.aclRevision !== value.projectAclRevision
    ) {
      ctx.addIssue({ code: "custom", message: "current_project_access_scope_mismatch" });
    }
    if (
      value.canvas.scope.scopeKind !== "canvas" ||
      value.canvas.scope.workspaceId !== value.scope.workspaceId ||
      value.canvas.scope.projectId !== value.scope.projectId ||
      value.canvas.scope.canvasId !== value.scope.canvasId ||
      value.canvas.aclRevision !== value.canvasAclRevision
    ) {
      ctx.addIssue({ code: "custom", message: "current_canvas_access_scope_mismatch" });
    }
  });
export type CurrentCanvasAccessView = z.infer<typeof currentCanvasAccessViewSchema>;

/** Replaceable persistence, identity, and authorization seams; no storage/process details leak here. */
export interface ScopedAccessRepositoryPort {
  read(scope: AccessScope): Promise<EffectiveAccessEvaluation | null>;
  compareAndSet(input: AccessMutationRequest): Promise<AccessMutationResult>;
}

export interface ScopedIdentityPort {
  membershipState(workspaceId: string, humanPrincipalId: string): Promise<AccessMembershipState>;
  sessionState(workspaceId: string, humanPrincipalId: string): Promise<AccessSessionState>;
}

export interface ScopedAuthorizationPort {
  evaluate(input: EffectiveAccessEvaluation): EffectiveAccessView;
}

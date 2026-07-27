import {
  executionTargetReadModelSchema,
  responsibilityReadModelSchema,
  reviewAssignmentReadModelSchema,
  type ExecutionTargetReadModel,
  type ResponsibilityReadModel,
  type ReviewAssignmentReadModel
} from "@planweave-ai/collaboration-contracts";
import type { HumanAuthContext, HumanIdentityRepository } from "../identity/index.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import type { AgentHostRepository } from "../hosts.js";
import { AuthorityRepository } from "./authorityRepository.js";
import {
  executionTargetMutationSchema,
  responsibilityMutationSchema,
  reviewerMutationSchema,
  authorityScopeSchema,
  type AuthorityActor,
  type AuthorityScope
} from "./authoritySchemas.js";
import {
  assertAssignmentPrincipalActive,
  assertExecutionTargetMutation,
  assertHumanScopeAuthorized
} from "./authorityPolicy.js";
import type { WorkItemPackagePort } from "./workItemFacts.js";
import { workItemRefSchema } from "./schemas.js";

function actorOf(context: HumanAuthContext): AuthorityActor {
  return { kind: "human", id: context.humanPrincipalId };
}

function assertMigration(repository: AuthorityRepository, scope: AuthorityScope): void {
  const state = repository.migrationState(scope.workspaceId, scope.projectId);
  if (state?.status === "repair_required") throw new Error("authority_migration_repair_required");
}

function workItem(scope: AuthorityScope) {
  return workItemRefSchema.parse(
    scope.kind === "task"
      ? { kind: "task", canvasId: scope.canvasId, taskId: scope.taskId }
      : { kind: "block", canvasId: scope.canvasId, blockRef: scope.blockRef }
  );
}

export type AuthorityServiceOptions = {
  repository: AuthorityRepository;
  packagePort: WorkItemPackagePort;
  identity: HumanIdentityRepository;
  access: ProjectAccessRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  hosts: AgentHostRepository;
  clock?: () => Date;
};

/** Server application boundary for independent responsibility/reviewer/Host mutations. */
export class AuthorityService {
  private readonly clock: () => Date;

  constructor(private readonly options: AuthorityServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
  }

  updateResponsibility(actor: HumanAuthContext, rawIntent: unknown) {
    const intent = responsibilityMutationSchema.parse(rawIntent);
    const scope = authorityScopeSchema.parse(intent.scope);
    this.assertActorScope(actor, scope);
    assertMigration(this.options.repository, scope);
    this.assertPackageScope(scope);
    assertHumanScopeAuthorized({
      actor,
      scope,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    if (intent.principal) {
      assertAssignmentPrincipalActive({
        actor,
        projectId: scope.projectId,
        humanPrincipalId: intent.principal.humanPrincipalId,
        identity: this.options.identity
      });
    }
    return this.options.repository.applyResponsibility({ mutation: intent, actor: actorOf(actor) });
  }

  updateReviewer(actor: HumanAuthContext, rawIntent: unknown) {
    const intent = reviewerMutationSchema.parse(rawIntent);
    const scope = authorityScopeSchema.parse(intent.scope);
    this.assertActorScope(actor, scope);
    assertMigration(this.options.repository, scope);
    this.assertPackageScope(scope);
    assertHumanScopeAuthorized({
      actor,
      scope,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    if (intent.principal) {
      assertAssignmentPrincipalActive({
        actor,
        projectId: scope.projectId,
        humanPrincipalId: intent.principal.humanPrincipalId,
        identity: this.options.identity
      });
    }
    return this.options.repository.applyReviewer({ mutation: intent, actor: actorOf(actor) });
  }

  updateExecutionTarget(actor: HumanAuthContext, rawIntent: unknown) {
    const intent = executionTargetMutationSchema.parse(rawIntent);
    const scope = intent.scope;
    this.assertActorScope(actor, scope);
    assertMigration(this.options.repository, scope);
    const packageFacts = this.options.packagePort.resolveWorkItem(workItem(scope));
    assertExecutionTargetMutation({
      actor,
      scope,
      target: intent.target,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity,
      hosts: this.options.hosts,
      packageFacts
    });
    return this.options.repository.applyExecutionTarget({
      mutation: intent,
      actor: actorOf(actor)
    });
  }

  getResponsibility(
    actor: HumanAuthContext,
    rawScope: unknown
  ): ResponsibilityReadModel | undefined {
    const scope = this.authorizeRead(actor, rawScope);
    const record = this.options.repository.getResponsibility(scope);
    if (!record) return undefined;
    const availability =
      record.principal === null
        ? "unassigned"
        : this.options.identity.getActiveMembership(
              scope.projectId,
              record.principal.humanPrincipalId
            )
          ? "active"
          : "inactive_member";
    return responsibilityReadModelSchema.parse({ ...record, availability });
  }

  getReviewer(actor: HumanAuthContext, rawScope: unknown): ReviewAssignmentReadModel | undefined {
    const scope = this.authorizeRead(actor, rawScope);
    const record = this.options.repository.getReviewer(scope);
    if (!record) return undefined;
    const availability =
      record.principal === null
        ? "unassigned"
        : this.options.identity.getActiveMembership(
              scope.projectId,
              record.principal.humanPrincipalId
            )
          ? "active"
          : "inactive_member";
    return reviewAssignmentReadModelSchema.parse({ ...record, availability });
  }

  getExecutionTarget(
    actor: HumanAuthContext,
    rawScope: unknown
  ): ExecutionTargetReadModel | undefined {
    const scope = authorityScopeSchema.parse(rawScope);
    if (scope.kind !== "block") throw new Error("execution_target_requires_exact_block_scope");
    this.authorizeRead(actor, scope);
    this.assertPackageScope(scope);
    const record = this.options.repository.getExecutionTarget(scope);
    if (!record) return undefined;
    const target = record.target;
    if (target.kind === "unassigned")
      return executionTargetReadModelSchema.parse({
        ...record,
        availability: { status: "unassigned", reason: "unassigned" }
      });
    const host = target.kind === "exact_host" ? this.options.hosts.get(target.hostId) : undefined;
    if (target.kind === "automatic_host")
      return executionTargetReadModelSchema.parse({
        ...record,
        availability: { status: "pending", reason: "automatic_pending_selection" }
      });
    const reason = !host ? "host_missing" : host.revokedAt ? "host_revoked" : "ready";
    return executionTargetReadModelSchema.parse({
      ...record,
      availability:
        reason === "ready" ? { status: "ready", reason: "ready" } : { status: "invalid", reason }
    });
  }

  currentRevisions(actor: HumanAuthContext, rawScope: unknown) {
    const scope = this.authorizeRead(actor, rawScope);
    return this.options.repository.currentRevisions(scope);
  }

  private authorizeRead(actor: HumanAuthContext, rawScope: unknown): AuthorityScope {
    const scope = authorityScopeSchema.parse(rawScope);
    this.assertActorScope(actor, scope);
    assertMigration(this.options.repository, scope);
    assertHumanScopeAuthorized({
      actor,
      scope,
      access: this.options.access,
      workspaceIdentity: this.options.workspaceIdentity
    });
    return scope;
  }

  private assertActorScope(actor: HumanAuthContext, scope: AuthorityScope): void {
    if (actor.projectId !== scope.projectId) throw new Error("authority_project_mismatch");
    if (!this.options.workspaceIdentity.workspaceExists(scope.workspaceId))
      throw new Error("authority_workspace_mismatch");
    void this.clock;
  }

  private assertPackageScope(scope: AuthorityScope): void {
    const facts = this.options.packagePort.resolveWorkItem(workItem(scope));
    if (!facts.exists || facts.kind !== scope.kind)
      throw new Error("authority_work_item_not_found");
    if (scope.kind === "task" && facts.taskId !== scope.taskId)
      throw new Error("authority_work_item_not_found");
    if (scope.kind === "block" && facts.blockRef !== scope.blockRef)
      throw new Error("authority_work_item_not_found");
  }
}

import {
  operatorActionRequestSchema,
  operatorActionViewSchema,
  operatorEnrollmentGrantRequestSchema,
  operatorEnrollmentGrantResponseSchema,
  operatorEventQuerySchema,
  operatorEventReplaySchema,
  operatorHostViewSchema,
  operatorHostPageSchema,
  operatorInteractionPageSchema,
  operatorInteractionResponseSchema,
  operatorInteractionViewSchema,
  operatorOperationViewSchema,
  operatorPageQuerySchema,
  type OperatorOperationView
} from "./operatorDtos.js";
import { remoteDispatchIntentSchema } from "@planweave-ai/collaboration-protocol";
import { HostEnrollmentService } from "./hostEnrollment.js";
import {
  DEFAULT_HOST_OFFLINE_AFTER_MS,
  AgentHostRepository,
  isAgentHostOnline,
  operatorHostAvailability,
  type AgentHost
} from "./hosts.js";
import { OperatorTokenRegistry, type OperatorPrincipal } from "./operatorAuth.js";
import { RemoteAcpEventRepository } from "./remoteAcpEvents.js";
import { RemoteBlockCoordinator } from "./remoteBlockCoordinator.js";
import { RemoteInteractionService } from "./remoteInteractions.js";
import { RemoteOperationRepository, type RemoteOperation } from "./remoteOperations.js";
import { DispatchService } from "./dispatches.js";
import { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";

export type RemoteControlServiceOptions = {
  authorization: OperatorTokenRegistry;
  enrollments: HostEnrollmentService;
  hosts: AgentHostRepository;
  operations: RemoteOperationRepository;
  dispatches: DispatchService;
  coordinator: RemoteBlockCoordinator;
  events: RemoteAcpEventRepository;
  interactions: RemoteInteractionService;
  disconnectHost(hostId: string): void;
  hostOfflineAfterMs?: number;
  clock?: () => Date;
  workspaceIdentity: WorkspaceIdentityRepository;
};

export class RemoteControlService {
  private readonly clock: () => Date;
  private readonly hostOfflineAfterMs: number;

  constructor(private readonly options: RemoteControlServiceOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.hostOfflineAfterMs = options.hostOfflineAfterMs ?? DEFAULT_HOST_OFFLINE_AFTER_MS;
  }

  createEnrollmentGrant(principal: OperatorPrincipal, rawRequest: unknown) {
    this.options.authorization.requireServerAdmin(principal);
    const request = operatorEnrollmentGrantRequestSchema.parse(rawRequest);
    const workspaceId = this.resolveWorkspace(principal, request.workspaceId);
    return operatorEnrollmentGrantResponseSchema.parse(
      this.options.enrollments.createGrant({
        workspaceId,
        expiresAt: new Date(request.expiresAt),
        credentialExpiresAt: new Date(request.credentialExpiresAt)
      })
    );
  }

  listHosts(principal: OperatorPrincipal, rawQuery: unknown) {
    this.options.authorization.requireServerAdmin(principal);
    const query = operatorPageQuerySchema.parse(rawQuery);
    const workspaceId = this.resolveWorkspace(principal, query.workspaceId);
    const hosts = this.options.workspaceIdentity.listHostViews(
      workspaceId,
      query.limit + 1,
      query.cursor
    );
    return operatorHostPageSchema.parse({
      items: hosts
        .slice(0, query.limit)
        .map((host) =>
          this.toOperatorHostView(this.options.hosts.getRequired(host.hostId), workspaceId)
        ),
      nextCursor: hosts.length > query.limit ? query.cursor + query.limit : null
    });
  }

  getHost(principal: OperatorPrincipal, hostId: string) {
    this.options.authorization.requireServerAdmin(principal);
    const workspaceId = this.requireHostWorkspace(hostId);
    this.authorizeWorkspace(principal, workspaceId);
    return this.toOperatorHostView(this.options.hosts.getRequired(hostId), workspaceId);
  }

  revokeHost(principal: OperatorPrincipal, hostId: string) {
    this.options.authorization.requireServerAdmin(principal);
    const workspaceId = this.requireHostWorkspace(hostId);
    this.authorizeWorkspace(principal, workspaceId);
    this.options.hosts.revoke(hostId);
    this.options.disconnectHost(hostId);
    return this.toOperatorHostView(this.options.hosts.getRequired(hostId), workspaceId);
  }

  async dispatch(principal: OperatorPrincipal, rawRequest: unknown) {
    const request = remoteDispatchIntentSchema.parse(rawRequest);
    this.options.authorization.authorizeProject(principal, request.projectId);
    const workspaceId = this.resolveWorkspace(principal, principal.workspaceId);
    this.authorizeWorkspace(principal, workspaceId);
    // Assignment and dispatch remain separate operations; the coordinator revalidates
    // current assignment before Host reservation (never trusts a UI eligibility list).
    const outcome = await this.options.coordinator.dispatch({
      workspaceId,
      projectId: request.projectId,
      canvasId: request.canvasId,
      blockRef: request.blockRef,
      idempotencyKey: request.idempotencyKey,
      expectedResponsibilityRevision: request.expectedResponsibilityRevision,
      expectedReviewerRevision: request.expectedReviewerRevision,
      expectedExecutionTargetRevision: request.expectedExecutionTargetRevision,
      strictAuthority: true
    });
    return this.observeOperation(principal, outcome.operation.id);
  }

  async observeOperation(
    principal: OperatorPrincipal,
    operationId: string
  ): Promise<OperatorOperationView> {
    const operation = this.operationFor(principal, operationId);
    const runtime = await this.options.coordinator.query(operation.id);
    const dispatch = this.options.dispatches.get(operation.dispatchId);
    return operatorOperationViewSchema.parse({
      operationId: operation.id,
      projectId: operation.projectId,
      canvasId: operation.canvasId,
      blockRef: operation.blockRef,
      state: operation.state,
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId,
      envelopeDigest: operation.envelopeDigest,
      reportArtifactRef: dispatch?.result?.reportArtifactRef,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      terminalAt: operation.terminalAt,
      attempt: {
        executionAttemptId: operation.attempt.executionAttemptId,
        dispatchId: operation.attempt.dispatchId,
        status: operation.attempt.status,
        hostId: operation.attempt.hostId,
        leaseId: operation.attempt.leaseId,
        leaseExpiresAt: operation.attempt.leaseExpiresAt,
        stateVersion: operation.attempt.stateVersion
      },
      dispatchStatus: dispatch?.status,
      runtime
    });
  }

  async executeAction(principal: OperatorPrincipal, operationId: string, rawAction: unknown) {
    const operation = this.operationFor(principal, operationId);
    const action = operatorActionRequestSchema.parse(rawAction);
    if (action.operationId !== operation.id) throw new Error("operator_action_operation_mismatch");
    const record = await this.options.coordinator.executeAction(action);
    return operatorActionViewSchema.parse({
      request: record.request,
      state: record.state,
      createdAt: record.createdAt,
      deliveredAt: record.deliveredAt,
      acknowledgedAt: record.acknowledgedAt,
      settledAt: record.settledAt,
      rejectedAt: record.rejectedAt,
      rejectionCode: record.rejectionCode
    });
  }

  replayEvents(principal: OperatorPrincipal, operationId: string, rawAfterCursor: unknown) {
    const operation = this.operationFor(principal, operationId);
    const query = operatorEventQuerySchema.parse({ afterCursor: rawAfterCursor });
    return operatorEventReplaySchema.parse(
      this.options.events.replay(operation.executionAttemptId, query.afterCursor)
    );
  }

  listPendingInteractions(principal: OperatorPrincipal, operationId: string, rawQuery: unknown) {
    const operation = this.operationFor(principal, operationId);
    const query = operatorPageQuerySchema.parse(rawQuery);
    const interactions = this.options.interactions.listPending(
      operation.id,
      query.limit + 1,
      query.cursor
    );
    return operatorInteractionPageSchema.parse({
      items: interactions.slice(0, query.limit).map(toOperatorInteractionView),
      nextCursor: interactions.length > query.limit ? query.cursor + query.limit : null
    });
  }

  settleInteraction(principal: OperatorPrincipal, operationId: string, rawSettlement: unknown) {
    const operation = this.operationFor(principal, operationId);
    const settlement = operatorInteractionResponseSchema.parse(rawSettlement);
    if (
      settlement.dispatchId !== operation.dispatchId ||
      settlement.executionAttemptId !== operation.executionAttemptId ||
      !operation.attempt.hostId
    ) {
      throw new Error("operator_interaction_operation_mismatch");
    }
    const interaction = this.options.interactions.settle({
      hostId: operation.attempt.hostId,
      responderId: principal.operatorId,
      settlement
    });
    return toOperatorInteractionView(interaction);
  }

  private operationFor(principal: OperatorPrincipal, operationId: string): RemoteOperation {
    const operation = this.options.operations.getRequiredInWorkspace(
      principal.workspaceId,
      operationId
    );
    this.options.authorization.authorizeProject(principal, operation.projectId);
    this.authorizeWorkspace(principal, operation.workspaceId);
    return operation;
  }

  private toOperatorHostView(host: AgentHost, workspaceId: string) {
    return toOperatorHostView(host, workspaceId, this.clock(), this.hostOfflineAfterMs);
  }

  private authorizeWorkspace(principal: OperatorPrincipal, workspaceId: string): void {
    this.options.authorization.authorizeWorkspace(principal, workspaceId, (projectId) =>
      principal.projectIds.includes(projectId) ? principal.workspaceId : undefined
    );
  }

  private resolveWorkspace(principal: OperatorPrincipal, requestedWorkspaceId?: string): string {
    const workspaceIds = this.options.workspaceIdentity.listWorkspaceIds();
    const workspaceId = requestedWorkspaceId ?? principal.workspaceId;
    if (!workspaceId || !workspaceIds.includes(workspaceId)) {
      throw new Error("operator_workspace_required");
    }
    this.options.workspaceIdentity.assertReadCutover(workspaceId);
    this.authorizeWorkspace(principal, workspaceId);
    return workspaceId;
  }

  private requireHostWorkspace(hostId: string): string {
    const workspaceId = this.options.workspaceIdentity.workspaceForHost(hostId);
    if (!workspaceId) throw new Error("operator_host_workspace_ambiguous");
    return workspaceId;
  }
}

function toOperatorHostView(
  host: AgentHost,
  workspaceId: string,
  now: Date,
  hostOfflineAfterMs: number
) {
  const online = isAgentHostOnline(host, { now, hostOfflineAfterMs });
  return operatorHostViewSchema.parse({
    id: host.id,
    workspaceId,
    displayName: host.displayName,
    capabilities: host.capabilities,
    capacity: host.capacity,
    online,
    lastSeenAt: host.lastSeenAt,
    revokedAt: host.revokedAt,
    credentialExpiresAt: host.credentialExpiresAt,
    readinessObservation: host.readinessObservation,
    availability: operatorHostAvailability(host, workspaceId, online)
  });
}

function toOperatorInteractionView(
  interaction: ReturnType<RemoteInteractionService["getRequired"]>
) {
  return operatorInteractionViewSchema.parse({
    request: interaction.request,
    operationId: interaction.operationId,
    hostId: interaction.hostId,
    status: interaction.status,
    createdAt: interaction.createdAt,
    settlement: interaction.settlement,
    settledBy: interaction.settledBy,
    settledAt: interaction.settledAt
  });
}

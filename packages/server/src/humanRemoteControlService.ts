import {
  remoteActionViewSchema,
  remoteDispatchWireCommandSchema,
  remoteEventQuerySchema,
  remoteEventReplaySchema,
  remoteInteractionPageQuerySchema,
  remoteInteractionPageSchema,
  remoteInteractionResponseSchema,
  remoteInteractionViewSchema,
  remoteOperationObservationSchema
} from "@planweave-ai/collaboration-contracts";
import type { HumanAuthContext } from "./identity/index.js";
import { authorizeHumanAction } from "./identity/policy.js";
import { RemoteAcpEventRepository } from "./remoteAcpEvents.js";
import { RemoteBlockCoordinator } from "./remoteBlockCoordinator.js";
import { RemoteInteractionService } from "./remoteInteractions.js";
import { RemoteOperationRepository, type RemoteOperation } from "./remoteOperations.js";
import { DispatchService } from "./dispatches.js";

export class HumanRemoteControlError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HumanRemoteControlError";
  }
}

export type HumanRemoteControlServiceOptions = {
  operations: RemoteOperationRepository;
  dispatches: DispatchService;
  coordinator: RemoteBlockCoordinator;
  events: RemoteAcpEventRepository;
  interactions: RemoteInteractionService;
};

export class HumanRemoteControlService {
  constructor(private readonly options: HumanRemoteControlServiceOptions) {}

  async dispatch(context: HumanAuthContext, projectId: string, rawRequest: unknown) {
    this.authorize(context, projectId);
    const request = remoteDispatchWireCommandSchema.parse(rawRequest);
    const outcome = await this.options.coordinator.dispatch({ projectId, ...request });
    return this.observeOperation(context, projectId, outcome.operation.id);
  }

  async observeOperation(context: HumanAuthContext, projectId: string, operationId: string) {
    const operation = this.operationFor(context, projectId, operationId);
    const runtime = await this.options.coordinator.query(operation.id);
    const dispatch = this.options.dispatches.get(operation.dispatchId);
    return remoteOperationObservationSchema.parse({
      operationId: operation.id,
      projectId: operation.projectId,
      canvasId: operation.canvasId,
      blockRef: operation.blockRef,
      state: operation.state,
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId,
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
      runtime: {
        ref: runtime.ref,
        status: runtime.status,
        ...(runtime.ownership
          ? {
              ownership: {
                operationId: runtime.ownership.operationId,
                phase: runtime.ownership.phase,
                ...(runtime.ownership.phase === "active"
                  ? {
                      dispatchId: runtime.ownership.dispatchId,
                      executionAttemptId: runtime.ownership.executionAttemptId
                    }
                  : {})
              }
            }
          : {}),
        ...(runtime.interruption ? { interruption: runtime.interruption } : {}),
        ...(runtime.terminalReceipt
          ? {
              terminalReceipt: {
                operationId: runtime.terminalReceipt.operationId,
                outcome: runtime.terminalReceipt.outcome
              }
            }
          : {}),
        ...(runtime.blockedReason !== undefined ? { blockedReason: runtime.blockedReason } : {}),
        ...(runtime.divergenceReason !== undefined
          ? { divergenceReason: runtime.divergenceReason }
          : {})
      }
    });
  }

  async executeAction(
    context: HumanAuthContext,
    projectId: string,
    operationId: string,
    rawAction: unknown
  ) {
    const operation = this.operationFor(context, projectId, operationId);
    const action = remoteActionViewSchema.shape.request.parse(rawAction);
    if (action.operationId !== operation.id) {
      throw new HumanRemoteControlError("human_remote_operation_mismatch");
    }
    const record = await this.options.coordinator.executeAction(action);
    return remoteActionViewSchema.parse({
      request: record.request,
      state: record.state,
      createdAt: record.createdAt,
      deliveredAt: record.deliveredAt,
      acknowledgedAt: record.acknowledgedAt,
      settledAt: record.settledAt
    });
  }

  replayEvents(
    context: HumanAuthContext,
    projectId: string,
    operationId: string,
    rawQuery: unknown
  ) {
    const operation = this.operationFor(context, projectId, operationId);
    const query = remoteEventQuerySchema.parse(rawQuery);
    return remoteEventReplaySchema.parse(
      this.options.events.replay(operation.executionAttemptId, query.afterCursor)
    );
  }

  listPendingInteractions(
    context: HumanAuthContext,
    projectId: string,
    operationId: string,
    rawQuery: unknown
  ) {
    const operation = this.operationFor(context, projectId, operationId);
    const query = remoteInteractionPageQuerySchema.parse(rawQuery);
    const interactions = this.options.interactions.listPending(
      operation.id,
      query.limit + 1,
      query.cursor
    );
    return remoteInteractionPageSchema.parse({
      items: interactions.slice(0, query.limit).map(toHumanInteractionView),
      nextCursor: interactions.length > query.limit ? query.cursor + query.limit : null
    });
  }

  settleInteraction(
    context: HumanAuthContext,
    projectId: string,
    operationId: string,
    rawSettlement: unknown
  ) {
    const operation = this.operationFor(context, projectId, operationId);
    const settlement = remoteInteractionResponseSchema.parse(rawSettlement);
    if (
      settlement.dispatchId !== operation.dispatchId ||
      settlement.executionAttemptId !== operation.executionAttemptId ||
      !operation.attempt.hostId
    ) {
      throw new HumanRemoteControlError("human_remote_interaction_operation_mismatch");
    }
    return toHumanInteractionView(
      this.options.interactions.settle({
        hostId: operation.attempt.hostId,
        responderId: context.humanPrincipalId,
        settlement
      })
    );
  }

  private authorize(context: HumanAuthContext, projectId: string): void {
    const decision = authorizeHumanAction({
      action: "remote_run_control",
      subject: { kind: "human", context },
      facts: { targetProjectId: projectId }
    });
    if (!decision.allowed) throw new HumanRemoteControlError(decision.code);
  }

  private operationFor(
    context: HumanAuthContext,
    projectId: string,
    operationId: string
  ): RemoteOperation {
    this.authorize(context, projectId);
    const operation = this.options.operations.getRequired(operationId);
    if (operation.projectId !== projectId) {
      throw new HumanRemoteControlError("human_cross_project_forbidden");
    }
    return operation;
  }
}

function toHumanInteractionView(
  interaction: ReturnType<RemoteInteractionService["getRequired"]>
) {
  return remoteInteractionViewSchema.parse({
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

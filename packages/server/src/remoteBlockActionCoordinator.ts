import {
  RemoteExecutionActionService,
  type RemoteExecutionActionRecord
} from "./remoteExecutionActions.js";
import type {
  RemoteExecutionActionDecision,
  RemoteExecutionActionRequest
} from "./remoteExecutionLifecycle.js";
import { remoteBlockIdentity } from "./remoteBlockIdentity.js";
import type {
  RemoteBlockCoordinatorOptions,
  RemoteDispatchOutcome
} from "./remoteBlockCoordinator.js";
import type { MailboxMessage } from "./mailbox.js";

export class RemoteBlockActionCoordinator {
  constructor(
    private readonly options: RemoteBlockCoordinatorOptions,
    private readonly lifecycle: {
      reenter(operationId: string): Promise<RemoteDispatchOutcome>;
      fail(operationId: string): Promise<void>;
      checkpoint(): Promise<void>;
    }
  ) {}

  execute(rawAction: unknown): Promise<RemoteExecutionActionRecord> {
    return this.service().execute(rawAction);
  }

  reconcile(): Promise<RemoteExecutionActionRecord[]> {
    return this.service().reconcile();
  }

  async requestCancel(operationId: string, reason: string): Promise<void> {
    const operation = this.options.operations.getRequired(operationId);
    if (!operation.attempt.leaseId) throw new Error("remote_attempt_not_bound");
    await this.execute({
      actionId: `cancel-${operation.executionAttemptId}`,
      operationId: operation.id,
      dispatchId: operation.dispatchId,
      executionAttemptId: operation.executionAttemptId,
      expectedAttemptVersion: operation.attempt.stateVersion,
      kind: "cancel",
      leaseId: operation.attempt.leaseId,
      reason
    });
  }

  private service(): RemoteExecutionActionService {
    return new RemoteExecutionActionService(this.options.actions, {
      snapshot: (action) => {
        const operation = this.options.operations.getRequired(action.operationId);
        return this.options.dispatches.actionSnapshot(operation);
      },
      recover: (action) => this.recover(action),
      apply: (action, decision) => this.apply(action, decision),
      afterApply: () => this.lifecycle.checkpoint()
    });
  }

  private async recover(
    action: RemoteExecutionActionRequest
  ): Promise<"delivered" | "settled" | undefined> {
    if (action.kind === "retry_new_attempt") {
      if (
        !this.options.operations.isRetryApplied({
          operationId: action.operationId,
          priorExecutionAttemptId: action.executionAttemptId,
          newDispatchId: action.newDispatchId,
          newExecutionAttemptId: action.newExecutionAttemptId,
          expectedAttemptVersion: action.expectedAttemptVersion
        })
      ) {
        return undefined;
      }
      await this.lifecycle.reenter(action.operationId);
      return "settled";
    }
    if (action.kind === "resume_same_session") {
      if (
        !this.options.reservations.isResumeApplied({
          priorLeaseId: action.priorLeaseId,
          leaseId: action.leaseId,
          executionAttemptId: action.executionAttemptId,
          leaseExpiresAt: action.leaseExpiresAt
        })
      ) {
        return undefined;
      }
      const operation = this.options.operations.getRequired(action.operationId);
      const message = this.options.dispatches.enqueueResume({ operation, action });
      this.publish(message);
      return "delivered";
    }
    const operation = this.options.operations.getRequired(action.operationId);
    const persisted = this.options.dispatches.inspect(operation).dispatch;
    if (action.kind === "cancel" && persisted?.status === "cancelling") {
      const message = this.options.dispatches.enqueueCancel({ operation, action });
      this.publish(message);
      return "delivered";
    }
    if (action.kind === "block" && operation.attempt.status === "action_required") {
      return "settled";
    }
    if (
      action.kind === "fail" &&
      (persisted?.status === "awaiting_writeback" ||
        persisted?.status === "failed" ||
        persisted?.status === "cancelled")
    ) {
      await this.lifecycle.fail(operation.id);
      return "settled";
    }
    return undefined;
  }

  private async apply(
    action: RemoteExecutionActionRequest,
    decision: RemoteExecutionActionDecision
  ): Promise<"delivered" | "settled"> {
    let operation = this.options.operations.getRequired(action.operationId);
    const runtime = this.options.runtimeResolver.resolve(operation);
    switch (decision.transition) {
      case "cancel": {
        if (action.kind !== "cancel") throw new Error("remote_action_decision_mismatch");
        const message = this.options.dispatches.enqueueCancel({ operation, action });
        this.publish(message);
        return "delivered";
      }
      case "block":
        if (action.kind !== "block") throw new Error("remote_action_decision_mismatch");
        this.options.operations.markActionRequired({
          operationId: operation.id,
          executionAttemptId: operation.executionAttemptId,
          expectedAttemptVersion: action.expectedAttemptVersion
        });
        this.options.dispatches.markActionRequired(operation);
        return "settled";
      case "fail":
        if (action.kind !== "fail") throw new Error("remote_action_decision_mismatch");
        this.options.dispatches.prepareManualFailure({ operation, failure: action.failure });
        await this.lifecycle.fail(operation.id);
        return "settled";
      case "resume": {
        if (action.kind !== "resume_same_session")
          throw new Error("remote_action_decision_mismatch");
        await runtime.resumeAttempt(remoteBlockIdentity(operation));
        this.options.reservations.resumeSameAttempt({
          priorLeaseId: action.priorLeaseId,
          leaseId: action.leaseId,
          leaseExpiresAt: action.leaseExpiresAt,
          expectedAttemptVersion: action.expectedAttemptVersion
        });
        operation = this.options.operations.getRequired(operation.id);
        const message = this.options.dispatches.enqueueResume({ operation, action });
        this.publish(message);
        return "delivered";
      }
      case "retry": {
        if (action.kind !== "retry_new_attempt") throw new Error("remote_action_decision_mismatch");
        // New attempt is a fresh dispatch: revalidate current assignment and resnapshot.
        // Do not reuse the prior attempt's host_selection_json (stale after reassignment).
        const hostSelection = this.options.assignmentGate
          ? this.options.assignmentGate.resolve({
              projectId: operation.projectId,
              canvasId: operation.canvasId,
              blockRef: operation.blockRef,
              requiredCapabilities: operation.requiredCapabilities
            })
          : undefined;
        await runtime.retryAttempt({
          ...remoteBlockIdentity(operation),
          newDispatchId: action.newDispatchId,
          newExecutionAttemptId: action.newExecutionAttemptId
        });
        this.options.operations.retryAttempt({
          operationId: operation.id,
          priorExecutionAttemptId: operation.executionAttemptId,
          newDispatchId: action.newDispatchId,
          newExecutionAttemptId: action.newExecutionAttemptId,
          expectedAttemptVersion: action.expectedAttemptVersion,
          hostSelection
        });
        await this.lifecycle.reenter(operation.id);
        return "settled";
      }
    }
  }

  private publish(message: MailboxMessage): void {
    if (message.publishedAt) return;
    this.options.mailbox.publish(message);
    this.options.dispatches.markMailboxPublished(message.messageId);
  }
}

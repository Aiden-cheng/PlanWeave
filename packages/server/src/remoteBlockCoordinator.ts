import {
  OUTPUT_MAX_ARTIFACT_BYTES,
  OUTPUT_MAX_ARTIFACT_COUNT,
  agentHostProtocolVersion,
  assertAgentHostProtocolCompatible,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  mailboxCommandSchema
} from "@planweave-ai/distributed-protocol";
import type { RemoteBlockDispatchCandidate } from "@planweave-ai/runtime";
import { remoteBlockFailureInputSchema } from "@planweave-ai/runtime";
import type {
  RemoteArtifactContentPort,
  RemoteBlockRuntimeResolverPort,
  RemoteCoordinatorCheckpoint,
  RemoteCoordinatorCheckpointPort,
  RemoteDispatchPersistencePort,
  RemoteInputArtifactPort,
  RemoteMailboxPublisherPort,
  RemoteOperationCandidatePort,
  RemoteRuntimeLocator
} from "./remoteBlockCoordinatorPorts.js";
import { HostReservationRepository } from "./hostReservations.js";
import { RemoteOperationRepository, type RemoteOperation } from "./remoteOperations.js";
import {
  RemoteExecutionActionRepository,
  type RemoteExecutionActionRecord
} from "./remoteExecutionActions.js";
import { RemoteBlockActionCoordinator } from "./remoteBlockActionCoordinator.js";
import { remoteBlockIdentity } from "./remoteBlockIdentity.js";
import type {
  AssignmentDispatchGate,
  DispatchHostSelectionSnapshot
} from "./work/dispatchIntegration.js";

export type RemoteDispatchRequest = RemoteRuntimeLocator & {
  blockRef: string;
  idempotencyKey: string;
  /** Optional exact Host request; revalidated against assignment + live Host facts. */
  requestedHostId?: string;
  /**
   * When true, allow dispatch of human/unassigned Blocks (API-level override).
   * When assignmentGate is configured and this is false/omitted, human/unassigned deny.
   */
  allowHumanOverride?: boolean;
  /**
   * Optional assignment revision fingerprint. When set, must match durable assignment
   * revision at dispatch begin or the call fails with a clear conflict.
   */
  expectedAssignmentRevision?: number;
};

export type RemoteDispatchOutcome = {
  operation: RemoteOperation;
  status:
    | "awaiting_host"
    | "activated"
    | "active"
    | "wait_for_action"
    | "awaiting_writeback"
    | "terminal";
};

export type RemoteBlockCoordinatorOptions = {
  runtimeResolver: RemoteBlockRuntimeResolverPort;
  operations: RemoteOperationRepository;
  actions: RemoteExecutionActionRepository;
  candidates: RemoteOperationCandidatePort;
  reservations: HostReservationRepository;
  dispatches: RemoteDispatchPersistencePort;
  mailbox: RemoteMailboxPublisherPort;
  inputArtifacts: RemoteInputArtifactPort;
  artifactContent: RemoteArtifactContentPort;
  checkpoints?: RemoteCoordinatorCheckpointPort;
  /**
   * Optional assignment gate consulted before Host reservation.
   * When set, human/unassigned Blocks require allowHumanOverride; exact Host is pinned;
   * automatic uses the deterministic selector with package capabilities.
   */
  assignmentGate?: AssignmentDispatchGate;
};

function buildEnvelope(operation: RemoteOperation, candidate: RemoteBlockDispatchCandidate) {
  const protocolCheck = assertAgentHostProtocolCompatible(agentHostProtocolVersion);
  if (!protocolCheck.ok) {
    throw new Error(`${protocolCheck.code}:${protocolCheck.message}`);
  }
  return executionEnvelopeSchema.parse({
    protocolVersion: agentHostProtocolVersion,
    execution: {
      dispatchId: operation.dispatchId,
      attemptId: operation.executionAttemptId
    },
    projectId: candidate.projectId,
    canvasId: candidate.canvasId,
    taskId: candidate.taskId,
    blockRef: candidate.blockRef,
    blockType: candidate.blockType,
    sourceRevision: candidate.sourceRevision,
    graphFingerprint: candidate.graphFingerprint,
    renderedPrompt: candidate.renderedPrompt,
    acceptance: candidate.acceptance,
    dependencySummaries: candidate.dependencySummaries,
    inputArtifacts: candidate.inputArtifacts,
    workspaceId: candidate.workspaceId,
    agentId: candidate.agentId,
    agentProfileId: candidate.agentProfileId,
    session: candidate.session,
    requiredCapabilities: candidate.requiredCapabilities,
    output: {
      reportRequired: true,
      maxArtifactBytes: OUTPUT_MAX_ARTIFACT_BYTES,
      maxArtifactCount: OUTPUT_MAX_ARTIFACT_COUNT
    },
    trace: { correlationId: operation.id }
  });
}

export class RemoteBlockCoordinator {
  /**
   * Per-operation Host selection authorized at dispatch begin.
   * Assignment and dispatch remain separate operations: reassignment does not rewrite this map.
   */
  private readonly hostSelectionByOperation = new Map<string, DispatchHostSelectionSnapshot>();

  constructor(private readonly options: RemoteBlockCoordinatorOptions) {}

  private async checkpoint(point: RemoteCoordinatorCheckpoint): Promise<void> {
    await this.options.checkpoints?.reached(point);
  }

  /**
   * Expose the Host selection authorized at dispatch begin (display / cancel-retry).
   * Prefer durable operation snapshot so restart does not lose the fingerprint.
   * Never used to silently retarget after reassignment.
   */
  getAuthorizedHostSelection(operationId: string): DispatchHostSelectionSnapshot | undefined {
    const cached = this.hostSelectionByOperation.get(operationId);
    if (cached) return cached;
    const durable = this.options.operations.get(operationId)?.hostSelection;
    if (durable) {
      this.hostSelectionByOperation.set(operationId, durable);
    }
    return durable;
  }

  async dispatch(request: RemoteDispatchRequest): Promise<RemoteDispatchOutcome> {
    const existing = this.options.operations.findByCallerIdentity(request);
    if (existing) return this.reenter(existing.id);

    const runtime = this.options.runtimeResolver.resolve(request);
    const candidate = await runtime.inspect({ ref: request.blockRef });
    if (candidate.projectId !== request.projectId || candidate.canvasId !== request.canvasId) {
      throw new Error("remote_runtime_locator_candidate_mismatch");
    }

    // Assignment revalidation is a separate read from dispatch persistence.
    // Capture the authorized selection before reservation so concurrent reassignment cannot
    // redirect this operation to an arbitrary Host. Persist with the operation so restart
    // cannot re-resolve from a later assignment.
    let selection: DispatchHostSelectionSnapshot | undefined;
    if (this.options.assignmentGate) {
      selection = this.options.assignmentGate.resolve({
        projectId: candidate.projectId,
        canvasId: candidate.canvasId,
        blockRef: candidate.blockRef,
        requiredCapabilities: candidate.requiredCapabilities,
        requestedHostId: request.requestedHostId,
        allowHumanOverride: request.allowHumanOverride,
        expectedAssignmentRevision: request.expectedAssignmentRevision
      });
    }

    await this.checkpoint("before_operation_commit");
    const operation = this.options.operations.create({
      projectId: candidate.projectId,
      canvasId: candidate.canvasId,
      blockRef: candidate.blockRef,
      ownershipGeneration: candidate.sourceRevision,
      idempotencyKey: request.idempotencyKey,
      sourceFingerprint: candidate.graphFingerprint,
      requiredCapabilities: candidate.requiredCapabilities,
      hostSelection: selection
    });
    if (operation.hostSelection) {
      this.hostSelectionByOperation.set(operation.id, operation.hostSelection);
    }
    await this.checkpoint("after_operation_commit");
    this.options.candidates.record(operation.id, candidate);
    await this.checkpoint("after_candidate_persistence");
    return this.reenter(operation.id);
  }

  async reenter(operationId: string): Promise<RemoteDispatchOutcome> {
    let operation = this.options.operations.getRequired(operationId);
    if (["completed", "failed", "cancelled"].includes(operation.state)) {
      return { operation, status: "terminal" };
    }
    const runtime = this.options.runtimeResolver.resolve(operation);
    if (operation.state !== "preparing") {
      try {
        const binding = await runtime.reconcile({
          ref: operation.blockRef,
          operationId: operation.id
        });
        if (binding.divergenceReason && !binding.interruption) {
          this.options.operations.recordDiagnostic(
            operation.id,
            "remote_source_changed",
            binding.divergenceReason
          );
          throw new Error("remote_source_changed");
        }
      } catch (error) {
        this.options.operations.recordDiagnostic(
          operation.id,
          "runtime_reconciliation_conflict",
          error instanceof Error ? error.message : "Runtime reconciliation failed."
        );
        throw error;
      }
    }
    let candidate = this.options.candidates.get(operation.id);
    if (!candidate) {
      if (operation.state !== "preparing") throw new Error("remote_operation_candidate_missing");
      candidate = await runtime.inspect({ ref: operation.blockRef });
      if (
        candidate.projectId !== operation.projectId ||
        candidate.canvasId !== operation.canvasId ||
        candidate.sourceRevision !== operation.ownershipGeneration ||
        candidate.graphFingerprint !== operation.sourceFingerprint
      ) {
        this.options.operations.recordDiagnostic(
          operation.id,
          "remote_source_changed",
          "The Runtime source changed before the durable candidate could be restored."
        );
        throw new Error("remote_source_changed");
      }
      this.options.candidates.record(operation.id, candidate);
      await this.checkpoint("after_candidate_persistence");
    }

    if (operation.state === "preparing") {
      try {
        await runtime.claim({
          ref: operation.blockRef,
          operationId: operation.id,
          sourceRevision: operation.ownershipGeneration,
          graphFingerprint: operation.sourceFingerprint
        });
        await this.checkpoint("after_runtime_claim");
      } catch (error) {
        this.options.operations.recordDiagnostic(
          operation.id,
          "runtime_claim_conflict",
          error instanceof Error ? error.message : "Runtime claim failed."
        );
        throw error;
      }
      operation = this.options.operations.getRequired(operation.id);
      if (operation.state === "preparing") {
        operation = this.options.operations.markClaimed(operation.id);
      }
    }

    const envelope = buildEnvelope(operation, candidate);
    const envelopeDigest = hashExecutionEnvelope(envelope);
    operation = this.options.operations.recordEnvelope({
      operationId: operation.id,
      digest: envelopeDigest
    });
    await this.checkpoint("after_envelope_persistence");
    await this.options.inputArtifacts.materialize(candidate);
    await this.checkpoint("after_input_materialization");

    const persisted = this.inspectPersistence(
      operation,
      envelopeDigest,
      candidate.inputArtifacts.length
    );
    if (persisted.dispatch?.status === "running" || persisted.dispatch?.status === "cancelling") {
      await this.checkpoint("after_host_acceptance_observed");
      return { operation: this.options.operations.getRequired(operation.id), status: "active" };
    }
    if (persisted.dispatch?.status === "leased" && operation.state === "activated") {
      return { operation: this.options.operations.getRequired(operation.id), status: "activated" };
    }
    if (persisted.dispatch?.status === "interrupted") {
      const interruption = persisted.dispatch.interruption;
      if (!interruption) {
        this.recordInconsistency(operation, "An interrupted dispatch has no interruption payload.");
      }
      await runtime.markInterrupted({
        ...remoteBlockIdentity(operation),
        interruption
      });
      return {
        operation: this.options.operations.getRequired(operation.id),
        status: "wait_for_action"
      };
    }
    if (persisted.dispatch?.status === "awaiting_writeback") {
      await this.checkpoint("after_terminal_event_persistence");
      const action = persisted.dispatch.terminalAction;
      if (!action) {
        this.recordInconsistency(
          operation,
          "An awaiting-writeback dispatch has no terminal payload."
        );
      }
      if (action.kind === "complete") {
        await this.complete(operation.id);
      } else {
        await this.fail(operation.id);
      }
      return {
        operation: this.options.operations.getRequired(operation.id),
        status: "terminal"
      };
    }
    if (
      persisted.dispatch?.status === "completed" ||
      persisted.dispatch?.status === "failed" ||
      persisted.dispatch?.status === "cancelled"
    ) {
      this.finalizeOperationTerminal(operation, persisted.dispatch.status);
      return {
        operation: this.options.operations.getRequired(operation.id),
        status: "terminal"
      };
    }

    let reservation = operation.attempt.leaseId
      ? this.options.reservations.getRequired(operation.attempt.leaseId)
      : undefined;
    if (!reservation) {
      try {
        const preferredHostId = this.resolvePreferredHostId(operation);
        reservation = this.options.reservations.reserve(operation.id, { preferredHostId });
        await this.checkpoint("after_host_reservation");
        this.options.operations.clearDiagnostic(operation.id);
      } catch (error) {
        if (error instanceof Error && error.message === "no_compatible_agent_host") {
          this.options.operations.recordDiagnostic(
            operation.id,
            "no_compatible_agent_host",
            "No compatible online Agent Host currently has reservation capacity."
          );
          return {
            operation: this.options.operations.getRequired(operation.id),
            status: "awaiting_host"
          };
        }
        throw error;
      }
    }
    operation = this.options.operations.getRequired(operation.id);
    this.options.dispatches.prepare({ operation, reservation, envelope, envelopeDigest });
    await this.checkpoint("after_dispatch_persistence");

    try {
      await runtime.activate(remoteBlockIdentity(operation));
      await this.checkpoint("after_runtime_binding");
    } catch (error) {
      this.options.operations.recordDiagnostic(
        operation.id,
        "runtime_activation_conflict",
        error instanceof Error ? error.message : "Runtime activation failed."
      );
      throw error;
    }
    const command = mailboxCommandSchema.parse({
      type: "execute_block",
      protocolVersion: agentHostProtocolVersion,
      dispatchId: operation.dispatchId,
      leaseId: reservation.leaseId,
      executionAttemptId: operation.executionAttemptId,
      leaseExpiresAt: reservation.leaseExpiresAt,
      envelopeDigest,
      envelope
    });
    const delivery = this.options.dispatches.activate({ operation, reservation, command });
    await this.checkpoint("after_mailbox_enqueue");
    if (!delivery.message.publishedAt) {
      this.options.mailbox.publish(delivery.message);
      await this.checkpoint("after_mailbox_publish");
      this.options.dispatches.markMailboxPublished(delivery.message.messageId);
    }
    this.options.operations.clearDiagnostic(operation.id);
    return { operation: this.options.operations.getRequired(operation.id), status: "activated" };
  }

  async reenterPending(): Promise<RemoteDispatchOutcome[]> {
    const outcomes: RemoteDispatchOutcome[] = [];
    for (const operation of this.options.operations.listNonTerminal()) {
      outcomes.push(await this.reenter(operation.id));
    }
    return outcomes;
  }

  async query(operationId: string) {
    const operation = this.options.operations.getRequired(operationId);
    return this.options.runtimeResolver.resolve(operation).query({
      ref: operation.blockRef,
      operationId: operation.id
    });
  }

  async executeAction(rawAction: unknown): Promise<RemoteExecutionActionRecord> {
    return this.actionCoordinator().execute(rawAction);
  }

  async reconcileActions(): Promise<RemoteExecutionActionRecord[]> {
    return this.actionCoordinator().reconcile();
  }

  async requestCancel(operationId: string, reason: string): Promise<void> {
    await this.actionCoordinator().requestCancel(operationId, reason);
  }

  private actionCoordinator(): RemoteBlockActionCoordinator {
    return new RemoteBlockActionCoordinator(this.options, {
      reenter: (operationId) => this.reenter(operationId),
      fail: (operationId) => this.fail(operationId),
      checkpoint: () => this.checkpoint("after_action_side_effect")
    });
  }

  async complete(operationId: string): Promise<void> {
    let operation = this.options.operations.getRequired(operationId);
    const terminal = this.options.dispatches.inspect(operation).dispatch;
    if (terminal?.status !== "awaiting_writeback" || terminal.terminalAction?.kind !== "complete") {
      throw new Error("remote_completion_evidence_missing");
    }
    await this.checkpoint("after_terminal_event_persistence");
    const reportArtifactRef = terminal.terminalAction.reportArtifactRef;
    const runtime = this.options.runtimeResolver.resolve(operation);
    const reportBytes = new Uint8Array(
      await this.options.artifactContent.readReport(reportArtifactRef)
    );
    await this.checkpoint("before_runtime_writeback");
    await runtime.complete({ ...remoteBlockIdentity(operation), reportArtifactRef, reportBytes });
    await this.checkpoint("after_runtime_writeback");
    operation = this.options.operations.getRequired(operation.id);
    this.options.dispatches.finishTerminal({ operation, status: "completed" });
    await this.checkpoint("after_dispatch_terminal_persistence");
    this.finalizeOperationTerminal(operation, "completed");
    await this.checkpoint("after_terminal_persistence");
  }

  async fail(operationId: string): Promise<void> {
    let operation = this.options.operations.getRequired(operationId);
    const terminal = this.options.dispatches.inspect(operation).dispatch;
    if (terminal?.status !== "awaiting_writeback" || terminal.terminalAction?.kind !== "fail") {
      const current = this.options.dispatches.inspect(operation).dispatch;
      if (current?.status === "failed" || current?.status === "cancelled") {
        this.finalizeOperationTerminal(operation, current.status);
        return;
      }
      throw new Error("remote_failure_evidence_missing");
    }
    await this.checkpoint("after_terminal_event_persistence");
    const failure = terminal.terminalAction.failure;
    const runtime = this.options.runtimeResolver.resolve(operation);
    await this.checkpoint("before_runtime_writeback");
    await runtime.fail(
      remoteBlockFailureInputSchema.parse({ ...remoteBlockIdentity(operation), failure })
    );
    await this.checkpoint("after_runtime_writeback");
    operation = this.options.operations.getRequired(operation.id);
    const status = failure.code === "execution_cancelled" ? "cancelled" : "failed";
    this.options.dispatches.finishTerminal({ operation, status });
    await this.checkpoint("after_dispatch_terminal_persistence");
    this.finalizeOperationTerminal(operation, status);
    await this.checkpoint("after_terminal_persistence");
  }

  private finalizeOperationTerminal(
    operation: RemoteOperation,
    status: "completed" | "failed" | "cancelled"
  ): void {
    if (!operation.attempt.leaseId) throw new Error("remote_terminal_attempt_not_bound");
    const reservation = this.options.reservations.getRequired(operation.attempt.leaseId);
    if (reservation.status === "active") {
      this.options.reservations.release({
        leaseId: reservation.leaseId,
        fencingToken: reservation.fencingToken,
        expectedVersion: reservation.version,
        reason: status
      });
      return;
    }
    const current = this.options.operations.getRequired(operation.id);
    this.options.reservations.finalizeFencedAttempt({
      operationId: current.id,
      executionAttemptId: current.executionAttemptId,
      leaseId: reservation.leaseId,
      status
    });
  }

  private inspectPersistence(
    operation: RemoteOperation,
    envelopeDigest: string,
    expectedInputGrantCount: number
  ) {
    try {
      const persisted = this.options.dispatches.inspect(operation);
      if (persisted.dispatch) {
        if (persisted.dispatch.envelopeDigest !== envelopeDigest) {
          this.recordInconsistency(
            operation,
            "The persisted dispatch envelope is missing or changed."
          );
        }
        if (persisted.dispatch.inputGrantCount !== expectedInputGrantCount) {
          this.recordInconsistency(
            operation,
            "The persisted dispatch input grants do not match the immutable envelope."
          );
        }
      }
      if (persisted.mailbox && !persisted.dispatch) {
        this.recordInconsistency(operation, "A mailbox command exists without a dispatch.");
      }
      if (operation.state === "activated" && !persisted.mailbox) {
        this.recordInconsistency(operation, "An activated attempt has no durable mailbox command.");
      }
      return persisted;
    } catch (error) {
      if (error instanceof Error && error.message === "remote_persistence_inconsistent") {
        throw error;
      }
      this.options.operations.recordDiagnostic(
        operation.id,
        "remote_persistence_inconsistent",
        error instanceof Error ? error.message : "Persisted coordinator state is invalid."
      );
      throw new Error("remote_persistence_inconsistent", { cause: error });
    }
  }

  private recordInconsistency(operation: RemoteOperation, message: string): never {
    this.options.operations.recordDiagnostic(
      operation.id,
      "remote_persistence_inconsistent",
      message
    );
    throw new Error("remote_persistence_inconsistent");
  }

  /**
   * Prefer the Host selection authorized at dispatch begin.
   * Durable operation.hostSelection is authoritative after restart; never re-resolve from
   * a later assignment (that would silently migrate exact Host → automatic under override defaults).
   * Active reserved Host is never rewritten by reassignment (lease remains on reservation).
   */
  private resolvePreferredHostId(operation: RemoteOperation): string | undefined {
    const durable = operation.hostSelection ?? this.hostSelectionByOperation.get(operation.id);
    if (durable) {
      this.hostSelectionByOperation.set(operation.id, durable);
      return durable.preferredHostId;
    }
    if (!this.options.assignmentGate) {
      return undefined;
    }
    // Gate was configured at dispatch begin but the fingerprint is missing — fail closed.
    throw new Error("remote_host_selection_missing");
  }
}

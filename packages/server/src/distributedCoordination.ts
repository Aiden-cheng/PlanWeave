import { DispatchService, type DispatchRecord } from "./dispatches.js";
import { ArtifactAuthorizationRepository } from "./artifactAuthorization.js";
import { AgentHostRepository } from "./hosts.js";
import { DurableMailbox } from "./mailbox.js";
import type { SqliteDatabase } from "./sqlite.js";
import { RemoteBlockCoordinator } from "./remoteBlockCoordinator.js";
import type {
  RemoteArtifactContentPort,
  RemoteBlockRuntimeResolverPort,
  RemoteCoordinatorCheckpointPort,
  RemoteInputArtifactPort
} from "./remoteBlockCoordinatorPorts.js";
import {
  SqliteRemoteDispatchPersistence,
  SqliteRemoteOperationCandidateRepository
} from "./remoteCoordinatorPersistence.js";
import { HostReservationRepository } from "./hostReservations.js";
import { RemoteOperationRepository } from "./remoteOperations.js";
import { RemoteExecutionActionRepository } from "./remoteExecutionActions.js";
import { RemoteAcpEventRepository } from "./remoteAcpEvents.js";
import {
  RemoteInteractionService,
  type RemoteInteractionAuthorizationPort
} from "./remoteInteractions.js";
import { startPlanweaveServer, type PlanweaveServer, type StartupContext } from "./lifecycle.js";
import type { ServerStorageConfig } from "./config.js";
import {
  createAssignmentDispatchGate,
  type AssignmentDispatchGate
} from "./work/dispatchIntegration.js";
import { WorkAssignmentRepository } from "./work/repository.js";
import type { AssignmentRecord } from "./work/schemas.js";

export type RemoteBlockCoordinationOptions = {
  leaseDurationMs: number;
  hostOfflineAfterMs: number;
  clock?: () => Date;
  runtimeResolver: RemoteBlockRuntimeResolverPort;
  inputArtifacts: RemoteInputArtifactPort;
  artifactContent: RemoteArtifactContentPort;
  checkpoints?: RemoteCoordinatorCheckpointPort;
  interactionAuthorization?: RemoteInteractionAuthorizationPort;
  eventRetentionMaxEvents?: number;
  eventRetentionMaxBytes?: number;
  /**
   * When true (default), wire assignment→dispatch gate with operator-compatible override default.
   * Set false only for low-level tests that intentionally bypass assignment policy.
   */
  enableAssignmentDispatchGate?: boolean;
  /** Override the default assignment gate (e.g. strict human collaboration path). */
  assignmentGate?: AssignmentDispatchGate;
  onAssignmentUpdatedInTransaction?: (record: AssignmentRecord) => void;
  onDispatchActivityTransitionInTransaction?: (input: {
    type:
      | "remote_run_started"
      | "remote_run_succeeded"
      | "remote_run_failed"
      | "remote_run_interrupted";
    dispatch: DispatchRecord;
    occurredAt: string;
  }) => void;
};

export function createRemoteBlockCoordination(
  database: SqliteDatabase,
  options: RemoteBlockCoordinationOptions,
  startupContext: StartupContext
) {
  const hosts = new AgentHostRepository(database, options.clock);
  const mailbox = new DurableMailbox(database);
  const artifactAuthorization = new ArtifactAuthorizationRepository(database);
  const operations = new RemoteOperationRepository(database, options.clock);
  const actions = new RemoteExecutionActionRepository(database, options.clock);
  const reservations = new HostReservationRepository(database, {
    leaseDurationMs: options.leaseDurationMs,
    hostOfflineAfterMs: options.hostOfflineAfterMs,
    clock: options.clock
  });
  const acpEvents = new RemoteAcpEventRepository(database, {
    clock: options.clock,
    maxEvents: options.eventRetentionMaxEvents,
    maxBytes: options.eventRetentionMaxBytes
  });
  const interactions = new RemoteInteractionService(database, {
    authorization: options.interactionAuthorization ?? { canRespond: () => false },
    publisher: mailbox,
    clock: options.clock
  });
  const workAssignments = new WorkAssignmentRepository(database, {
    onAssignmentUpdatedInTransaction: options.onAssignmentUpdatedInTransaction
  });
  const assignmentGate =
    options.assignmentGate ??
    (options.enableAssignmentDispatchGate === false
      ? undefined
      : createAssignmentDispatchGate({
          repository: workAssignments,
          // Operator / existing remote paths may dispatch unassigned Blocks; exact Host
          // assignments still pin selection. Strict callers pass allowHumanOverride:false.
          defaultAllowHumanOverride: true
        }));
  const coordinator = new RemoteBlockCoordinator({
    runtimeResolver: options.runtimeResolver,
    operations,
    actions,
    candidates: new SqliteRemoteOperationCandidateRepository(database),
    reservations,
    dispatches: new SqliteRemoteDispatchPersistence(database),
    mailbox,
    inputArtifacts: options.inputArtifacts,
    artifactContent: options.artifactContent,
    checkpoints: options.checkpoints,
    assignmentGate,
    serverInstanceOwnerToken: startupContext.serverInstanceOwnerToken
  });
  const dispatches = new DispatchService(database, hosts, artifactAuthorization, {
    leaseDurationMs: options.leaseDurationMs,
    hostOfflineAfterMs: options.hostOfflineAfterMs,
    writeback: {
      complete: async (input) => {
        const operation = operations.getByDispatchId(input.dispatchId);
        if (!operation) throw new Error("remote_operation_not_found_for_dispatch");
        if (
          operation.attempt.hostId !== input.hostId ||
          operation.attempt.leaseId !== input.leaseId ||
          operation.executionAttemptId !== input.executionAttemptId
        ) {
          throw new Error("remote_writeback_identity_mismatch");
        }
        artifactAuthorization.requireResultProvenance(
          {
            projectId: input.projectId,
            hostId: input.hostId,
            dispatchId: input.dispatchId,
            leaseId: input.leaseId,
            executionAttemptId: input.executionAttemptId
          },
          input.result
        );
        await coordinator.complete(operation.id);
      },
      fail: async (input) => {
        const operation = operations.getByDispatchId(input.dispatchId);
        if (!operation) throw new Error("remote_operation_not_found_for_dispatch");
        if (
          operation.attempt.hostId !== input.hostId ||
          operation.attempt.leaseId !== input.leaseId ||
          operation.executionAttemptId !== input.executionAttemptId
        ) {
          throw new Error("remote_writeback_identity_mismatch");
        }
        await coordinator.fail(operation.id);
      }
    },
    onActivityTransitionInTransaction: options.onDispatchActivityTransitionInTransaction
  });
  const reconcile = async (context?: StartupContext) => {
    await dispatches.recoverExpiredLeases();
    reservations.expireDue();
    interactions.expireDue();
    await coordinator.reconcileActions(context);
    return coordinator.reenterPending();
  };
  return {
    hosts,
    mailbox,
    artifactAuthorization,
    operations,
    actions,
    acpEvents,
    interactions,
    reservations,
    coordinator,
    dispatches,
    workAssignments,
    assignmentGate,
    reconcile
  };
}

export async function startRemoteBlockCoordinationServer(
  config: ServerStorageConfig,
  createOptions: (database: SqliteDatabase) => RemoteBlockCoordinationOptions
): Promise<{
  server: PlanweaveServer;
  coordination: ReturnType<typeof createRemoteBlockCoordination>;
}> {
  let coordination: ReturnType<typeof createRemoteBlockCoordination> | undefined;
  const server = await startPlanweaveServer(config, [
    async (database, startupContext) => {
      const created = createRemoteBlockCoordination(
        database,
        createOptions(database),
        startupContext
      );
      await created.reconcile(startupContext);
      coordination = created;
    }
  ]);
  if (!coordination) {
    server.close();
    throw new Error("remote_coordination_startup_not_initialized");
  }
  return { server, coordination };
}

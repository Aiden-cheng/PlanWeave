import {
  DispatchService,
  type DispatchServiceOptions,
  type DispatchWriteback
} from "./dispatches.js";
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
import { startPlanweaveServer, type PlanweaveServer } from "./lifecycle.js";
import type { ServerStorageConfig } from "./config.js";

export type DistributedCoordinationOptions = Omit<DispatchServiceOptions, "writeback"> & {
  writeback: DispatchWriteback;
};

export function createDistributedCoordination(
  database: SqliteDatabase,
  options: DistributedCoordinationOptions
) {
  const hosts = new AgentHostRepository(database);
  const mailbox = new DurableMailbox(database);
  const artifactAuthorization = new ArtifactAuthorizationRepository(database);
  const dispatches = new DispatchService(database, hosts, artifactAuthorization, options);
  return { hosts, mailbox, artifactAuthorization, dispatches };
}

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
};

export function createRemoteBlockCoordination(
  database: SqliteDatabase,
  options: RemoteBlockCoordinationOptions
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
    checkpoints: options.checkpoints
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
    }
  });
  const reconcile = async () => {
    await dispatches.recoverExpiredLeases();
    reservations.expireDue();
    interactions.expireDue();
    await coordinator.reconcileActions();
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
    async (database) => {
      const created = createRemoteBlockCoordination(database, createOptions(database));
      await created.reconcile();
      coordination = created;
    }
  ]);
  if (!coordination) {
    server.close();
    throw new Error("remote_coordination_startup_not_initialized");
  }
  return { server, coordination };
}

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
import { startPlanweaveServer, type PlanweaveServer } from "./lifecycle.js";
import type { ServerConfig } from "./config.js";

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
  runtimeResolver: RemoteBlockRuntimeResolverPort;
  inputArtifacts: RemoteInputArtifactPort;
  artifactContent: RemoteArtifactContentPort;
  checkpoints?: RemoteCoordinatorCheckpointPort;
};

export function createRemoteBlockCoordination(
  database: SqliteDatabase,
  options: RemoteBlockCoordinationOptions
) {
  const hosts = new AgentHostRepository(database);
  const mailbox = new DurableMailbox(database);
  const artifactAuthorization = new ArtifactAuthorizationRepository(database);
  const operations = new RemoteOperationRepository(database);
  const reservations = new HostReservationRepository(database, options);
  const coordinator = new RemoteBlockCoordinator({
    runtimeResolver: options.runtimeResolver,
    operations,
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
        await coordinator.complete(operation.id, input.result.reportArtifactRef);
      },
      fail: async (input) => {
        const operation = operations.getByDispatchId(input.dispatchId);
        if (!operation) throw new Error("remote_operation_not_found_for_dispatch");
        await coordinator.fail(operation.id, input.failure);
      }
    }
  });
  return {
    hosts,
    mailbox,
    artifactAuthorization,
    operations,
    reservations,
    coordinator,
    dispatches
  };
}

export async function startRemoteBlockCoordinationServer(
  config: ServerConfig,
  createOptions: (database: SqliteDatabase) => RemoteBlockCoordinationOptions
): Promise<{
  server: PlanweaveServer;
  coordination: ReturnType<typeof createRemoteBlockCoordination>;
}> {
  let coordination: ReturnType<typeof createRemoteBlockCoordination> | undefined;
  const server = await startPlanweaveServer(config, [
    async (database) => {
      const created = createRemoteBlockCoordination(database, createOptions(database));
      await created.coordinator.reenterPending();
      coordination = created;
    }
  ]);
  if (!coordination) {
    server.close();
    throw new Error("remote_coordination_startup_not_initialized");
  }
  return { server, coordination };
}

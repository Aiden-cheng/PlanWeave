import {
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  mailboxCommandSchema,
  type ExecutionEnvelope
} from "@planweave-ai/distributed-protocol";
import type { createDistributedCoordination } from "../../distributedCoordination.js";
import { HostReservationRepository } from "../../hostReservations.js";
import { RemoteOperationRepository } from "../../remoteOperations.js";
import { SqliteRemoteDispatchPersistence } from "../../remoteCoordinatorPersistence.js";
import type { SqliteDatabase } from "../../sqlite.js";

type FixtureOptions = {
  leaseDurationMs?: number;
  hostOfflineAfterMs?: number;
};

export function createRemoteDispatchFixture(
  database: SqliteDatabase,
  coordination: ReturnType<typeof createDistributedCoordination>,
  sourceEnvelope: ExecutionEnvelope,
  options: FixtureOptions = {}
) {
  const operations = new RemoteOperationRepository(database);
  let operation = operations.create({
    projectId: sourceEnvelope.projectId,
    canvasId: sourceEnvelope.canvasId,
    blockRef: sourceEnvelope.blockRef,
    ownershipGeneration: sourceEnvelope.sourceRevision,
    idempotencyKey: sourceEnvelope.execution.dispatchId,
    sourceFingerprint: sourceEnvelope.graphFingerprint,
    requiredCapabilities: sourceEnvelope.requiredCapabilities
  });
  if (operation.state === "preparing") operation = operations.markClaimed(operation.id);
  const envelope = executionEnvelopeSchema.parse({
    ...sourceEnvelope,
    execution: {
      dispatchId: operation.dispatchId,
      attemptId: operation.executionAttemptId
    }
  });
  const envelopeDigest = hashExecutionEnvelope(envelope);
  operation = operations.recordEnvelope({ operationId: operation.id, digest: envelopeDigest });
  const reservations = new HostReservationRepository(database, {
    leaseDurationMs: options.leaseDurationMs ?? 60_000,
    hostOfflineAfterMs: options.hostOfflineAfterMs ?? 60_000
  });
  const reservation = operation.attempt.leaseId
    ? reservations.getRequired(operation.attempt.leaseId)
    : reservations.reserve(operation.id);
  operation = operations.getRequired(operation.id);
  const persistence = new SqliteRemoteDispatchPersistence(database);
  persistence.prepare({ operation, reservation, envelope, envelopeDigest });
  const delivery = persistence.activate({
    operation,
    reservation,
    command: mailboxCommandSchema.parse({
      type: "execute_block",
      protocolVersion: envelope.protocolVersion,
      dispatchId: operation.dispatchId,
      leaseId: reservation.leaseId,
      executionAttemptId: operation.executionAttemptId,
      leaseExpiresAt: reservation.leaseExpiresAt,
      envelopeDigest,
      envelope
    })
  });
  if (!delivery.message.publishedAt) {
    coordination.mailbox.publish(delivery.message);
    persistence.markMailboxPublished(delivery.message.messageId);
  }
  return coordination.dispatches.getRequired(operation.dispatchId);
}

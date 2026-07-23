import {
  agentHostProtocolVersion,
  dispatchResultSchema,
  mailboxCommandSchema,
  normalizedFailureSchema,
  type ExecutionEnvelope
} from "@planweave-ai/distributed-protocol";
import { remoteBlockDispatchCandidateSchema } from "@planweave-ai/runtime";
import { z } from "zod";
import { ArtifactAuthorizationRepository } from "./artifactAuthorization.js";
import type {
  ActivatedMailboxDelivery,
  RemoteDispatchPersistencePort,
  RemoteOperationCandidatePort,
  RemoteDispatchReconciliationState
} from "./remoteBlockCoordinatorPorts.js";
import type { HostCapacityReservation } from "./hostReservations.js";
import { DurableMailbox } from "./mailbox.js";
import { RemoteOperationRepository, type RemoteOperation } from "./remoteOperations.js";
import { inWriteTransaction, type SqliteDatabase } from "./sqlite.js";

export class SqliteRemoteOperationCandidateRepository implements RemoteOperationCandidatePort {
  constructor(private readonly database: SqliteDatabase) {}

  get(operationId: string) {
    const row = this.database
      .prepare("SELECT candidate_json FROM remote_operation_candidates WHERE operation_id=?")
      .get(operationId);
    if (!row) return undefined;
    try {
      return remoteBlockDispatchCandidateSchema.parse(JSON.parse(String(row.candidate_json)));
    } catch (error) {
      throw new Error("remote_operation_candidate_row_invalid", { cause: error });
    }
  }

  record(operationId: string, candidate: unknown): void {
    const parsed = remoteBlockDispatchCandidateSchema.parse(candidate);
    const canonical = JSON.stringify(parsed);
    const existing = this.database
      .prepare("SELECT candidate_json FROM remote_operation_candidates WHERE operation_id=?")
      .get(operationId);
    if (existing) {
      if (existing.candidate_json !== canonical) {
        throw new Error("remote_operation_candidate_conflict");
      }
      return;
    }
    this.database
      .prepare(
        `INSERT INTO remote_operation_candidates(operation_id,candidate_json,created_at)
         VALUES (?,?,?)`
      )
      .run(operationId, canonical, new Date().toISOString());
  }
}

function locatorReference(operation: RemoteOperation): string {
  return `runtime:${operation.projectId}:${operation.canvasId}`;
}

export class SqliteRemoteDispatchPersistence implements RemoteDispatchPersistencePort {
  private readonly artifacts: ArtifactAuthorizationRepository;
  private readonly mailbox: DurableMailbox;
  private readonly operations: RemoteOperationRepository;

  constructor(private readonly database: SqliteDatabase) {
    this.artifacts = new ArtifactAuthorizationRepository(database);
    this.mailbox = new DurableMailbox(database);
    this.operations = new RemoteOperationRepository(database);
  }

  inspect(operation: RemoteOperation): RemoteDispatchReconciliationState {
    const dispatch = this.database
      .prepare("SELECT status,result_json,failure_json FROM dispatches WHERE id=?")
      .get(operation.dispatchId);
    const envelope = this.database
      .prepare("SELECT envelope_digest FROM dispatch_execution_envelopes WHERE dispatch_id=?")
      .get(operation.dispatchId);
    const grantCount = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM artifact_grants
         WHERE dispatch_id=? AND permission='input_read'`
      )
      .get(operation.dispatchId);
    const mailboxRow = this.database
      .prepare(
        `SELECT message_id,host_id,command_json,published_at FROM mailbox_messages
         WHERE message_id=?`
      )
      .get(`execute-${operation.dispatchId}`);
    const mailbox = mailboxRow
      ? (() => {
          const command = mailboxCommandSchema.parse(JSON.parse(String(mailboxRow.command_json)));
          if (
            command.type !== "execute_block" ||
            command.dispatchId !== operation.dispatchId ||
            command.executionAttemptId !== operation.executionAttemptId ||
            mailboxRow.host_id !== operation.attempt.hostId
          ) {
            throw new Error("remote_mailbox_identity_conflict");
          }
          return {
            messageId: String(mailboxRow.message_id),
            publishedAt: mailboxRow.published_at
              ? z.iso.datetime().parse(mailboxRow.published_at)
              : undefined
          };
        })()
      : undefined;
    if (!dispatch) {
      if (envelope || Number(grantCount?.count ?? 0) !== 0 || mailbox) {
        throw new Error("remote_dispatch_persistence_orphaned");
      }
      return {};
    }
    const status = z
      .enum([
        "leased",
        "running",
        "interrupted",
        "cancelling",
        "awaiting_writeback",
        "completed",
        "failed",
        "cancelled"
      ])
      .parse(dispatch.status);
    const terminalAction =
      status === "awaiting_writeback"
        ? (() => {
            if (dispatch.result_json && !dispatch.failure_json) {
              return {
                kind: "complete" as const,
                reportArtifactRef: dispatchResultSchema.parse(
                  JSON.parse(String(dispatch.result_json))
                ).reportArtifactRef
              };
            }
            if (dispatch.failure_json && !dispatch.result_json) {
              return {
                kind: "fail" as const,
                failure: normalizedFailureSchema.parse(JSON.parse(String(dispatch.failure_json)))
              };
            }
            throw new Error("remote_dispatch_writeback_payload_invalid");
          })()
        : undefined;
    return {
      dispatch: {
        status,
        envelopeDigest: envelope
          ? z
              .string()
              .regex(/^envelope:sha256:[a-f0-9]{64}$/)
              .parse(envelope.envelope_digest)
          : undefined,
        inputGrantCount: z
          .number()
          .int()
          .nonnegative()
          .parse(Number(grantCount?.count ?? 0)),
        terminalAction
      },
      mailbox
    };
  }

  prepare(input: {
    operation: RemoteOperation;
    reservation: HostCapacityReservation;
    envelope: ExecutionEnvelope;
    envelopeDigest: string;
  }): void {
    inWriteTransaction(this.database, () => {
      const existing = this.database
        .prepare("SELECT * FROM dispatches WHERE id=?")
        .get(input.operation.dispatchId);
      if (!existing) {
        this.database
          .prepare(
            `INSERT INTO dispatches(
              id,project_id,block_ref,package_ref,host_id,required_capabilities_json,
              status,lease_id,execution_attempt_id,lease_expires_at,created_at
            ) VALUES (?,?,?,?,?,?,'leased',?,?,?,?)`
          )
          .run(
            input.operation.dispatchId,
            input.operation.projectId,
            input.operation.blockRef,
            locatorReference(input.operation),
            input.reservation.hostId,
            JSON.stringify(input.operation.requiredCapabilities),
            input.reservation.leaseId,
            input.operation.executionAttemptId,
            input.reservation.leaseExpiresAt,
            input.operation.createdAt
          );
        this.database
          .prepare(
            `INSERT INTO dispatch_events(dispatch_id,type,payload_json,occurred_at)
             VALUES (?,'dispatch.leased',?,?)`
          )
          .run(
            input.operation.dispatchId,
            JSON.stringify({
              hostId: input.reservation.hostId,
              leaseId: input.reservation.leaseId,
              leaseExpiresAt: input.reservation.leaseExpiresAt
            }),
            new Date().toISOString()
          );
      } else if (
        existing.project_id !== input.operation.projectId ||
        existing.block_ref !== input.operation.blockRef ||
        existing.host_id !== input.reservation.hostId ||
        existing.lease_id !== input.reservation.leaseId ||
        existing.execution_attempt_id !== input.operation.executionAttemptId
      ) {
        throw new Error("remote_dispatch_identity_conflict");
      }
      this.artifacts.recordExecutionEnvelope(
        input.operation.dispatchId,
        input.envelopeDigest,
        input.envelope
      );
      this.artifacts.grantDispatchInputs(
        {
          projectId: input.operation.projectId,
          hostId: input.reservation.hostId,
          dispatchId: input.operation.dispatchId,
          leaseId: input.reservation.leaseId,
          executionAttemptId: input.operation.executionAttemptId
        },
        input.envelope
      );
    });
  }

  activate(input: {
    operation: RemoteOperation;
    reservation: HostCapacityReservation;
    command: unknown;
  }): ActivatedMailboxDelivery {
    const command = mailboxCommandSchema.parse(input.command);
    return inWriteTransaction(this.database, () => {
      const operation = this.operations.getRequired(input.operation.id);
      const delivery = this.mailbox.enqueueOnce(
        `execute-${operation.dispatchId}`,
        input.reservation.hostId,
        command
      );
      if (operation.attempt.status === "reserved") {
        const now = new Date().toISOString();
        const updated = this.database
          .prepare(
            `UPDATE remote_execution_attempts
             SET status='activated',state_version=state_version+1,updated_at=?
             WHERE execution_attempt_id=? AND status='reserved' AND lease_id=?
               AND lease_fencing_token=?`
          )
          .run(
            now,
            operation.executionAttemptId,
            input.reservation.leaseId,
            input.reservation.fencingToken
          );
        if (updated.changes !== 1) throw new Error("remote_attempt_activation_conflict");
        this.database
          .prepare("UPDATE remote_operations SET state='activated',updated_at=? WHERE id=?")
          .run(now, operation.id);
        this.operations.appendEvent(
          operation.id,
          operation.executionAttemptId,
          "remote.attempt.activated",
          now
        );
      } else if (operation.attempt.status !== "activated") {
        throw new Error("remote_attempt_activation_conflict");
      }
      return { operation: this.operations.getRequired(operation.id), message: delivery.message };
    });
  }

  enqueueCancel(input: { operation: RemoteOperation; reason: string }) {
    const attempt = input.operation.attempt;
    if (!attempt.hostId || !attempt.leaseId) throw new Error("remote_attempt_not_bound");
    const hostId = attempt.hostId;
    const leaseId = attempt.leaseId;
    return inWriteTransaction(
      this.database,
      () =>
        this.mailbox.enqueueOnce(
          `cancel-${input.operation.dispatchId}`,
          hostId,
          mailboxCommandSchema.parse({
            type: "cancel_execution",
            protocolVersion: agentHostProtocolVersion,
            dispatchId: input.operation.dispatchId,
            leaseId,
            executionAttemptId: input.operation.executionAttemptId,
            reason: input.reason
          })
        ).message
    );
  }

  markMailboxPublished(messageId: string): void {
    this.mailbox.markPublished(messageId);
  }

  finishTerminal(input: {
    operation: RemoteOperation;
    status: "completed" | "failed" | "cancelled";
  }): void {
    inWriteTransaction(this.database, () => {
      const row = this.database
        .prepare("SELECT status,lease_id FROM dispatches WHERE id=?")
        .get(input.operation.dispatchId);
      if (!row) throw new Error("remote_dispatch_not_found");
      if (row.status === input.status) return;
      if (row.status !== "awaiting_writeback" || row.lease_id !== input.operation.attempt.leaseId) {
        throw new Error("remote_dispatch_not_awaiting_writeback");
      }
      const now = new Date().toISOString();
      const updated = this.database
        .prepare(
          `UPDATE dispatches SET status=?,finished_at=?
           WHERE id=? AND status='awaiting_writeback' AND lease_id=?`
        )
        .run(input.status, now, input.operation.dispatchId, input.operation.attempt.leaseId);
      if (updated.changes !== 1) throw new Error("remote_dispatch_terminal_conflict");
      this.database
        .prepare(
          `INSERT INTO dispatch_events(dispatch_id,type,payload_json,occurred_at)
           VALUES (?,?,?,?)`
        )
        .run(input.operation.dispatchId, `dispatch.${input.status}`, "{}", now);
    });
  }
}

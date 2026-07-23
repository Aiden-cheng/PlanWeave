import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  parseAgentHostEvent,
  parseAgentHostMailboxCommand,
  parseAgentHostServerEvent,
  type HostEvent,
  type NormalizedFailure as ProtocolDispatchFailure,
  type DispatchResult as ProtocolDispatchResult,
  type ServerEvent
} from "../protocol.js";
import {
  inWriteTransaction,
  openAgentHostDatabase,
  type SqliteDatabase
} from "./sqliteDatabase.js";
import {
  type AgentHostExecution,
  type ExecuteBlockCommand,
  initializeAgentHostStateSchema,
  outboxRowSchema,
  toExecution
} from "./agentHostStateRecords.js";
import {
  type AgentHostCancellation,
  type AgentHostStateLimits,
  type AgentHostStateRepository,
  DEFAULT_AGENT_HOST_STATE_LIMITS
} from "./agentHostStateContract.js";

export type { AgentHostExecution, AgentHostExecutionStatus } from "./agentHostStateRecords.js";
export type {
  AgentHostCancellation,
  AgentHostStateLimits,
  AgentHostStateRepository
} from "./agentHostStateContract.js";

type MailboxMessageEvent = Extract<ServerEvent, { type: "mailbox.message" }>;

function messageEvent(input: ServerEvent): MailboxMessageEvent {
  const parsed = parseAgentHostServerEvent(input);
  if (parsed.type !== "mailbox.message") throw new Error("mailbox_message_required");
  return parsed;
}

export class AgentHostState implements AgentHostStateRepository {
  private readonly limits: AgentHostStateLimits;

  constructor(
    private readonly database: SqliteDatabase,
    limits: Partial<AgentHostStateLimits> = {}
  ) {
    this.limits = {
      maxPendingCommands: this.parseLimit(
        limits.maxPendingCommands ?? DEFAULT_AGENT_HOST_STATE_LIMITS.maxPendingCommands,
        "pending_command"
      ),
      maxPendingEvents: this.parseLimit(
        limits.maxPendingEvents ?? DEFAULT_AGENT_HOST_STATE_LIMITS.maxPendingEvents,
        "pending_event"
      )
    };
    initializeAgentHostStateSchema(database);
  }

  close(): void {
    this.database.close();
  }

  receive(input: ServerEvent): { stored: boolean; acknowledgement: HostEvent } {
    const event = messageEvent(input);
    switch (event.command.type) {
      case "execute_block":
      case "cancel_execution":
        break;
      case "resume_execution":
      case "interaction.permission_response":
      case "interaction.elicitation_response":
      case "interaction.authentication_action":
        throw new Error(`agent_host_command_unsupported:${event.command.type}`);
    }
    return inWriteTransaction(this.database, () => {
      const commandJson = JSON.stringify(event.command);
      const existing = this.database
        .prepare(
          "SELECT sequence,previous_sequence,message_id,command_json FROM agent_host_inbox WHERE sequence=? OR message_id=?"
        )
        .get(event.sequence, event.messageId);
      let stored = false;
      if (existing) {
        if (
          Number(existing.sequence) !== event.sequence ||
          Number(existing.previous_sequence) !== event.previousSequence ||
          String(existing.message_id) !== event.messageId ||
          String(existing.command_json) !== commandJson
        ) {
          throw new Error("mailbox_message_conflict");
        }
      } else {
        const latest = this.database
          .prepare("SELECT MAX(sequence) AS sequence FROM agent_host_inbox")
          .get();
        if (event.previousSequence !== Number(latest?.sequence ?? 0)) {
          throw new Error("mailbox_message_out_of_order");
        }
        if (this.pendingCommandCount() >= this.limits.maxPendingCommands) {
          throw new Error("agent_host_pending_command_capacity_exceeded");
        }
        this.database
          .prepare(
            `INSERT INTO agent_host_inbox(
              sequence,previous_sequence,message_id,command_json,execution_status,lease_expires_at,received_at
            ) VALUES (?,?,?,?,?,?,?)`
          )
          .run(
            event.sequence,
            event.previousSequence,
            event.messageId,
            commandJson,
            event.command.type === "execute_block" ? "pending" : null,
            event.command.type === "execute_block" ? event.command.leaseExpiresAt : null,
            new Date().toISOString()
          );
        stored = true;
      }
      const acknowledgement = this.queueEvent(
        `mailbox.ack:${event.sequence}`,
        parseAgentHostEvent({
          type: "mailbox.ack",
          protocolVersion: 1,
          messageId: randomUUID(),
          sequence: event.sequence
        })
      );
      return { stored, acknowledgement };
    });
  }

  lastAcknowledgedSequence(): number {
    const row = this.database
      .prepare(
        "SELECT MAX(sequence) AS sequence FROM agent_host_inbox WHERE acknowledged_at IS NOT NULL"
      )
      .get();
    return Number(row?.sequence ?? 0);
  }

  pendingEvents(limit = this.limits.maxPendingEvents): HostEvent[] {
    const parsedLimit = this.parseLimit(limit, "pending_event_query");
    return this.database
      .prepare(
        "SELECT event_json FROM agent_host_outbox WHERE acknowledged_at IS NULL ORDER BY sequence ASC LIMIT ?"
      )
      .all(parsedLimit)
      .map((raw) => parseAgentHostEvent(JSON.parse(outboxRowSchema.parse(raw).event_json)));
  }

  pendingEventCount(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM agent_host_outbox WHERE acknowledged_at IS NULL")
      .get();
    return Number(row?.count ?? 0);
  }

  queueHeartbeat(
    activeLeases: ReadonlyArray<{
      dispatchId: string;
      leaseId: string;
      executionAttemptId: string;
    }>
  ): HostEvent {
    return inWriteTransaction(this.database, () => {
      this.database
        .prepare(
          "DELETE FROM agent_host_outbox WHERE event_key='host.heartbeat' AND acknowledged_at IS NOT NULL"
        )
        .run();
      return this.queueEvent(
        "host.heartbeat",
        parseAgentHostEvent({
          type: "host.heartbeat",
          protocolVersion: 1,
          messageId: randomUUID(),
          activeLeases
        })
      );
    });
  }

  acknowledgeEvent(messageId: string): boolean {
    return inWriteTransaction(this.database, () => {
      const raw = this.database
        .prepare("SELECT event_json,acknowledged_at FROM agent_host_outbox WHERE message_id=?")
        .get(messageId);
      if (!raw) return false;
      if (raw.acknowledged_at) return true;
      const event = parseAgentHostEvent(JSON.parse(String(raw.event_json)));
      const acknowledgedAt = new Date().toISOString();
      this.database
        .prepare("UPDATE agent_host_outbox SET acknowledged_at=? WHERE message_id=?")
        .run(acknowledgedAt, messageId);
      if (event.type === "mailbox.ack") {
        this.database
          .prepare(
            "UPDATE agent_host_inbox SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE sequence=?"
          )
          .run(acknowledgedAt, event.sequence);
      }
      return true;
    });
  }

  recoverInterruptedExecutions(): number {
    return inWriteTransaction(this.database, () => {
      const running = this.database
        .prepare("SELECT * FROM agent_host_inbox WHERE execution_status='running'")
        .all()
        .map(toExecution);
      for (const execution of running) {
        this.database
          .prepare("UPDATE agent_host_inbox SET execution_status='interrupted' WHERE sequence=?")
          .run(execution.sequence);
        this.queueEvent(
          `dispatch.interrupted:${execution.command.dispatchId}:${execution.command.leaseId}:${execution.command.executionAttemptId}`,
          parseAgentHostEvent({
            type: "dispatch.interrupted",
            protocolVersion: 1,
            messageId: randomUUID(),
            dispatchId: execution.command.dispatchId,
            leaseId: execution.command.leaseId,
            executionAttemptId: execution.command.executionAttemptId,
            reason: "host_restart",
            resumable: false
          })
        );
      }
      const cancelling = this.database
        .prepare("SELECT * FROM agent_host_inbox WHERE execution_status='cancelling'")
        .all()
        .map(toExecution);
      for (const execution of cancelling) {
        this.finishExecution(
          execution.sequence,
          "failed",
          (command) => this.cancelledEvent(command),
          "dispatch.failed",
          false
        );
      }
      return running.length + cancelling.length;
    });
  }

  recoverableExecutionCount(): number {
    const row = this.database
      .prepare(
        "SELECT COUNT(*) AS count FROM agent_host_inbox WHERE execution_status IN ('pending','running','interrupted','cancelling')"
      )
      .get();
    return Number(row?.count ?? 0);
  }

  pendingExecutions(limit: number): AgentHostExecution[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid_execution_limit");
    return this.database
      .prepare(
        "SELECT * FROM agent_host_inbox WHERE execution_status='pending' ORDER BY sequence ASC LIMIT ?"
      )
      .all(limit)
      .map(toExecution);
  }

  activeLeases(): Array<{
    dispatchId: string;
    leaseId: string;
    executionAttemptId: string;
  }> {
    return this.database
      .prepare(
        "SELECT * FROM agent_host_inbox WHERE execution_status IN ('pending','running','cancelling') ORDER BY sequence ASC"
      )
      .all()
      .map(toExecution)
      .map(({ command }) => ({
        dispatchId: command.dispatchId,
        leaseId: command.leaseId,
        executionAttemptId: command.executionAttemptId
      }));
  }

  renewLease(
    dispatchId: string,
    leaseId: string,
    executionAttemptId: string,
    leaseExpiresAt: string
  ): boolean {
    const parsedExpiry = z.string().datetime().parse(leaseExpiresAt);
    const execution = this.database
      .prepare(
        "SELECT * FROM agent_host_inbox WHERE execution_status IN ('pending','running','cancelling')"
      )
      .all()
      .map(toExecution)
      .find(
        ({ command }) =>
          command.dispatchId === dispatchId &&
          command.leaseId === leaseId &&
          command.executionAttemptId === executionAttemptId
      );
    if (!execution) return false;
    return (
      this.database
        .prepare("UPDATE agent_host_inbox SET lease_expires_at=? WHERE sequence=?")
        .run(parsedExpiry, execution.sequence).changes === 1
    );
  }

  abandonExpiredExecutions(now: Date): AgentHostExecution[] {
    return inWriteTransaction(this.database, () => {
      const expired = this.database
        .prepare(
          `SELECT * FROM agent_host_inbox
           WHERE execution_status IN ('pending','running','cancelling') AND lease_expires_at<=?
           ORDER BY sequence ASC`
        )
        .all(now.toISOString())
        .map(toExecution);
      for (const execution of expired) {
        this.database
          .prepare(
            "UPDATE agent_host_inbox SET execution_status='failed',finished_at=? WHERE sequence=?"
          )
          .run(now.toISOString(), execution.sequence);
      }
      return expired;
    });
  }

  pendingCancellations(): AgentHostCancellation[] {
    return this.database
      .prepare(
        "SELECT sequence,message_id,command_json FROM agent_host_inbox WHERE execution_status IS NULL AND processed_at IS NULL ORDER BY sequence ASC"
      )
      .all()
      .map((raw) => {
        const command = parseAgentHostMailboxCommand(JSON.parse(String(raw.command_json)));
        if (command.type !== "cancel_execution")
          throw new Error("cancel_execution_record_required");
        return {
          sequence: Number(raw.sequence),
          messageId: String(raw.message_id),
          command
        };
      });
  }

  applyCancellation(sequence: number): { shouldAbort: boolean } {
    return inWriteTransaction(this.database, () => {
      const raw = this.database
        .prepare("SELECT command_json,processed_at FROM agent_host_inbox WHERE sequence=?")
        .get(sequence);
      if (!raw) throw new Error("mailbox_message_not_found");
      const cancellation = parseAgentHostMailboxCommand(JSON.parse(String(raw.command_json)));
      if (cancellation.type !== "cancel_execution") throw new Error("cancel_execution_required");
      if (raw.processed_at) return { shouldAbort: false };
      this.database
        .prepare("UPDATE agent_host_inbox SET processed_at=? WHERE sequence=?")
        .run(new Date().toISOString(), sequence);

      const execution = this.database
        .prepare(
          "SELECT * FROM agent_host_inbox WHERE execution_status IS NOT NULL ORDER BY sequence ASC"
        )
        .all()
        .map(toExecution)
        .find(
          ({ command }) =>
            command.dispatchId === cancellation.dispatchId &&
            command.leaseId === cancellation.leaseId &&
            command.executionAttemptId === cancellation.executionAttemptId
        );
      if (!execution || execution.status === "completed" || execution.status === "failed") {
        return { shouldAbort: false };
      }
      if (execution.status === "pending") {
        this.finishExecution(
          execution.sequence,
          "failed",
          (command) => this.cancelledEvent(command),
          "dispatch.failed",
          false
        );
        return { shouldAbort: false };
      }
      if (execution.status === "running") {
        this.database
          .prepare("UPDATE agent_host_inbox SET execution_status='cancelling' WHERE sequence=?")
          .run(execution.sequence);
      }
      return { shouldAbort: true };
    });
  }

  startExecution(sequence: number): AgentHostExecution | undefined {
    return inWriteTransaction(this.database, () => {
      const raw = this.database
        .prepare("SELECT * FROM agent_host_inbox WHERE sequence=?")
        .get(sequence);
      if (!raw) throw new Error("mailbox_message_not_found");
      const current = toExecution(raw);
      if (current.status !== "pending") return undefined;
      const startedAt = new Date().toISOString();
      const updated = this.database
        .prepare(
          "UPDATE agent_host_inbox SET execution_status='running',started_at=? WHERE sequence=? AND execution_status='pending'"
        )
        .run(startedAt, sequence);
      if (updated.changes !== 1) return undefined;
      this.queueEvent(
        `dispatch.accepted:${current.command.dispatchId}:${current.command.leaseId}`,
        parseAgentHostEvent({
          type: "dispatch.accepted",
          protocolVersion: 1,
          messageId: randomUUID(),
          dispatchId: current.command.dispatchId,
          leaseId: current.command.leaseId,
          executionAttemptId: current.command.executionAttemptId
        })
      );
      return toExecution(
        this.database.prepare("SELECT * FROM agent_host_inbox WHERE sequence=?").get(sequence) ?? {}
      );
    });
  }

  completeExecution(sequence: number, result: ProtocolDispatchResult): void {
    this.finishExecution(
      sequence,
      "completed",
      (command) =>
        parseAgentHostEvent({
          type: "dispatch.completed",
          protocolVersion: 1,
          messageId: randomUUID(),
          dispatchId: command.dispatchId,
          leaseId: command.leaseId,
          executionAttemptId: command.executionAttemptId,
          result
        }),
      "dispatch.completed"
    );
  }

  failExecution(sequence: number, failure: ProtocolDispatchFailure): void {
    this.finishExecution(
      sequence,
      "failed",
      (command) =>
        parseAgentHostEvent({
          type: "dispatch.failed",
          protocolVersion: 1,
          messageId: randomUUID(),
          dispatchId: command.dispatchId,
          leaseId: command.leaseId,
          executionAttemptId: command.executionAttemptId,
          failure
        }),
      "dispatch.failed"
    );
  }

  private finishExecution(
    sequence: number,
    status: "completed" | "failed",
    createEvent: (command: ExecuteBlockCommand) => HostEvent,
    eventType: "dispatch.completed" | "dispatch.failed",
    transaction = true
  ): void {
    const finish = () => {
      const raw = this.database
        .prepare("SELECT * FROM agent_host_inbox WHERE sequence=?")
        .get(sequence);
      if (!raw) throw new Error("mailbox_message_not_found");
      const current = toExecution(raw);
      if (current.status === status) return;
      if (
        current.status !== "running" &&
        current.status !== "cancelling" &&
        !(status === "failed" && current.status === "pending")
      ) {
        throw new Error("execution_not_running");
      }
      const finishedAt = new Date().toISOString();
      this.database
        .prepare("UPDATE agent_host_inbox SET execution_status=?,finished_at=? WHERE sequence=?")
        .run(status, finishedAt, sequence);
      this.queueEvent(
        `${eventType}:${current.command.dispatchId}:${current.command.leaseId}`,
        createEvent(current.command)
      );
    };
    if (transaction) inWriteTransaction(this.database, finish);
    else finish();
  }

  private cancelledEvent(command: ExecuteBlockCommand): HostEvent {
    return parseAgentHostEvent({
      type: "dispatch.failed",
      protocolVersion: 1,
      messageId: randomUUID(),
      dispatchId: command.dispatchId,
      leaseId: command.leaseId,
      executionAttemptId: command.executionAttemptId,
      failure: {
        code: "execution_cancelled",
        message: "The execution was cancelled by the coordinator.",
        retryable: false
      }
    });
  }

  private queueEvent(eventKey: string, input: HostEvent): HostEvent {
    const event = parseAgentHostEvent(input);
    const existing = this.database
      .prepare("SELECT event_json FROM agent_host_outbox WHERE event_key=?")
      .get(eventKey);
    if (existing) return parseAgentHostEvent(JSON.parse(String(existing.event_json)));
    if (this.pendingEventCount() >= this.limits.maxPendingEvents) {
      throw new Error("agent_host_pending_event_capacity_exceeded");
    }
    this.database
      .prepare(
        `INSERT INTO agent_host_outbox(message_id,event_key,event_json,created_at)
         VALUES (?,?,?,?) ON CONFLICT(event_key) DO NOTHING`
      )
      .run(event.messageId, eventKey, JSON.stringify(event), new Date().toISOString());
    const raw = this.database
      .prepare("SELECT event_json FROM agent_host_outbox WHERE event_key=?")
      .get(eventKey);
    if (!raw) throw new Error("host_event_not_persisted");
    return parseAgentHostEvent(JSON.parse(String(raw.event_json)));
  }

  private pendingCommandCount(): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM agent_host_inbox
         WHERE execution_status IN ('pending','running','cancelling')
            OR (execution_status IS NULL AND processed_at IS NULL)`
      )
      .get();
    return Number(row?.count ?? 0);
  }

  private parseLimit(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`agent_host_${name}_limit_invalid`);
    }
    return value;
  }
}

export async function openAgentHostState(
  path: string,
  busyTimeoutMs = 5000,
  limits: Partial<AgentHostStateLimits> = {}
): Promise<AgentHostState> {
  return new AgentHostState(await openAgentHostDatabase(path, busyTimeoutMs), limits);
}

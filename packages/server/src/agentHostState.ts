import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  hostEventSchema,
  mailboxCommandSchema,
  serverEventSchema,
  type HostEvent,
  type MailboxCommand,
  type ProtocolDispatchFailure,
  type ProtocolDispatchResult,
  type ServerEvent
} from "./protocol.js";
import { inWriteTransaction, openServerDatabase, type SqliteDatabase } from "./sqlite.js";

type MailboxMessageEvent = Extract<ServerEvent, { type: "mailbox.message" }>;
type ExecuteBlockCommand = Extract<MailboxCommand, { type: "execute_block" }>;
type CancelExecutionCommand = Extract<MailboxCommand, { type: "cancel_execution" }>;

export type AgentHostExecutionStatus =
  | "pending"
  | "running"
  | "cancelling"
  | "completed"
  | "failed";

export type AgentHostExecution = {
  sequence: number;
  messageId: string;
  command: ExecuteBlockCommand;
  status: AgentHostExecutionStatus;
  receivedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type AgentHostCancellation = {
  sequence: number;
  messageId: string;
  command: CancelExecutionCommand;
};

const inboxRowSchema = z.object({
  sequence: z.number().int().positive(),
  message_id: z.string(),
  command_json: z.string(),
  execution_status: z.enum(["pending", "running", "cancelling", "completed", "failed"]).nullable(),
  lease_expires_at: z.string().datetime().nullable(),
  received_at: z.string().datetime(),
  started_at: z.string().datetime().nullable(),
  finished_at: z.string().datetime().nullable()
});

const outboxRowSchema = z.object({
  event_json: z.string()
});

const schema = `
CREATE TABLE IF NOT EXISTS agent_host_inbox (
  sequence INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  command_json TEXT NOT NULL,
  execution_status TEXT CHECK(execution_status IN (
    'pending','running','cancelling','completed','failed'
  )),
  lease_expires_at TEXT,
  received_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  acknowledged_at TEXT,
  processed_at TEXT
);

CREATE TABLE IF NOT EXISTS agent_host_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  event_key TEXT NOT NULL UNIQUE,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_host_inbox_execution
  ON agent_host_inbox(execution_status,sequence);
CREATE INDEX IF NOT EXISTS idx_agent_host_outbox_pending
  ON agent_host_outbox(acknowledged_at,sequence);
`;

function messageEvent(input: ServerEvent): MailboxMessageEvent {
  const parsed = serverEventSchema.parse(input);
  if (parsed.type !== "mailbox.message") throw new Error("mailbox_message_required");
  return parsed;
}

function toExecution(raw: Record<string, unknown>): AgentHostExecution {
  const row = inboxRowSchema.parse(raw);
  const command = mailboxCommandSchema.parse(JSON.parse(row.command_json));
  if (command.type !== "execute_block" || row.execution_status === null) {
    throw new Error("execute_block_record_required");
  }
  const effectiveCommand = row.lease_expires_at
    ? { ...command, leaseExpiresAt: row.lease_expires_at }
    : command;
  return {
    sequence: row.sequence,
    messageId: row.message_id,
    command: effectiveCommand,
    status: row.execution_status,
    receivedAt: row.received_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined
  };
}

export class AgentHostState {
  constructor(private readonly database: SqliteDatabase) {
    database.exec(schema);
  }

  close(): void {
    this.database.close();
  }

  receive(input: ServerEvent): { stored: boolean; acknowledgement: HostEvent } {
    const event = messageEvent(input);
    return inWriteTransaction(this.database, () => {
      const commandJson = JSON.stringify(event.command);
      const existing = this.database
        .prepare(
          "SELECT sequence,message_id,command_json FROM agent_host_inbox WHERE sequence=? OR message_id=?"
        )
        .get(event.sequence, event.messageId);
      let stored = false;
      if (existing) {
        if (
          Number(existing.sequence) !== event.sequence ||
          String(existing.message_id) !== event.messageId ||
          String(existing.command_json) !== commandJson
        ) {
          throw new Error("mailbox_message_conflict");
        }
      } else {
        this.database
          .prepare(
            `INSERT INTO agent_host_inbox(
              sequence,message_id,command_json,execution_status,lease_expires_at,received_at
            ) VALUES (?,?,?,?,?,?)`
          )
          .run(
            event.sequence,
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
        hostEventSchema.parse({
          type: "mailbox.ack",
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

  pendingEvents(): HostEvent[] {
    return this.database
      .prepare(
        "SELECT event_json FROM agent_host_outbox WHERE acknowledged_at IS NULL ORDER BY sequence ASC"
      )
      .all()
      .map((raw) => hostEventSchema.parse(JSON.parse(outboxRowSchema.parse(raw).event_json)));
  }

  acknowledgeEvent(messageId: string): boolean {
    return inWriteTransaction(this.database, () => {
      const raw = this.database
        .prepare("SELECT event_json,acknowledged_at FROM agent_host_outbox WHERE message_id=?")
        .get(messageId);
      if (!raw) return false;
      if (raw.acknowledged_at) return true;
      const event = hostEventSchema.parse(JSON.parse(String(raw.event_json)));
      const acknowledgedAt = new Date().toISOString();
      this.database
        .prepare("UPDATE agent_host_outbox SET acknowledged_at=? WHERE message_id=?")
        .run(acknowledgedAt, messageId);
      if (event.type === "mailbox.ack") {
        this.database
          .prepare(
            "UPDATE agent_host_inbox SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE sequence<=?"
          )
          .run(acknowledgedAt, event.sequence);
      }
      return true;
    });
  }

  recoverInterruptedExecutions(): number {
    return inWriteTransaction(this.database, () => {
      const restarted = this.database
        .prepare(
          "UPDATE agent_host_inbox SET execution_status='pending',started_at=NULL WHERE execution_status='running'"
        )
        .run().changes;
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
      return restarted + cancelling.length;
    });
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

  activeLeases(): Array<{ dispatchId: string; leaseId: string }> {
    return this.database
      .prepare(
        "SELECT * FROM agent_host_inbox WHERE execution_status IN ('pending','running','cancelling') ORDER BY sequence ASC"
      )
      .all()
      .map(toExecution)
      .map(({ command }) => ({ dispatchId: command.dispatchId, leaseId: command.leaseId }));
  }

  renewLease(dispatchId: string, leaseId: string, leaseExpiresAt: string): boolean {
    const parsedExpiry = z.string().datetime().parse(leaseExpiresAt);
    const execution = this.database
      .prepare(
        "SELECT * FROM agent_host_inbox WHERE execution_status IN ('pending','running','cancelling')"
      )
      .all()
      .map(toExecution)
      .find(({ command }) => command.dispatchId === dispatchId && command.leaseId === leaseId);
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
        const command = mailboxCommandSchema.parse(JSON.parse(String(raw.command_json)));
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
      const cancellation = mailboxCommandSchema.parse(JSON.parse(String(raw.command_json)));
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
            command.leaseId === cancellation.leaseId
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
        hostEventSchema.parse({
          type: "dispatch.accepted",
          messageId: randomUUID(),
          dispatchId: current.command.dispatchId,
          leaseId: current.command.leaseId
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
        hostEventSchema.parse({
          type: "dispatch.completed",
          messageId: randomUUID(),
          dispatchId: command.dispatchId,
          leaseId: command.leaseId,
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
        hostEventSchema.parse({
          type: "dispatch.failed",
          messageId: randomUUID(),
          dispatchId: command.dispatchId,
          leaseId: command.leaseId,
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
    return hostEventSchema.parse({
      type: "dispatch.failed",
      messageId: randomUUID(),
      dispatchId: command.dispatchId,
      leaseId: command.leaseId,
      failure: {
        code: "execution_cancelled",
        message: "The execution was cancelled by the coordinator.",
        retryable: false
      }
    });
  }

  private queueEvent(eventKey: string, input: HostEvent): HostEvent {
    const event = hostEventSchema.parse(input);
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
    return hostEventSchema.parse(JSON.parse(String(raw.event_json)));
  }
}

export async function openAgentHostState(
  path: string,
  busyTimeoutMs = 5000
): Promise<AgentHostState> {
  return new AgentHostState(await openServerDatabase(path, busyTimeoutMs));
}

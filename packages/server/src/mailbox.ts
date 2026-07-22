import { randomUUID } from "node:crypto";
import { HostEventInbox } from "./hostEvents.js";
import { mailboxCommandSchema, type MailboxCommand } from "./protocol.js";
import type { SqliteDatabase } from "./sqlite.js";

export type MailboxMessage = {
  sequence: number;
  messageId: string;
  hostId: string;
  command: MailboxCommand;
  createdAt: string;
  acknowledgedAt?: string;
};

type MailboxListener = (message: MailboxMessage) => void;

function toMessage(row: Record<string, unknown>): MailboxMessage {
  return {
    sequence: Number(row.sequence),
    messageId: String(row.message_id),
    hostId: String(row.host_id),
    command: mailboxCommandSchema.parse(JSON.parse(String(row.command_json))),
    createdAt: String(row.created_at),
    acknowledgedAt: row.acknowledged_at ? String(row.acknowledged_at) : undefined
  };
}

export class DurableMailbox {
  private readonly listeners = new Map<string, Set<MailboxListener>>();
  private readonly inbox: HostEventInbox;

  constructor(private readonly database: SqliteDatabase) {
    this.inbox = new HostEventInbox(database);
  }

  enqueue(hostId: string, command: MailboxCommand): MailboxMessage {
    const parsedCommand = mailboxCommandSchema.parse(command);
    const messageId = randomUUID();
    const createdAt = new Date().toISOString();
    const result = this.database
      .prepare(
        "INSERT INTO mailbox_messages(message_id,host_id,command_json,created_at) VALUES (?,?,?,?)"
      )
      .run(messageId, hostId, JSON.stringify(parsedCommand), createdAt);
    return {
      sequence: Number(result.lastInsertRowid),
      messageId,
      hostId,
      command: parsedCommand,
      createdAt
    };
  }

  publish(message: MailboxMessage): void {
    for (const listener of this.listeners.get(message.hostId) ?? []) listener(message);
  }

  listAfter(hostId: string, sequence: number): MailboxMessage[] {
    return this.database
      .prepare(
        "SELECT * FROM mailbox_messages WHERE host_id=? AND sequence>? ORDER BY sequence ASC"
      )
      .all(hostId, sequence)
      .map(toMessage);
  }

  acknowledge(hostId: string, messageId: string, sequence: number): void {
    this.inbox.process(hostId, messageId, "mailbox.ack", { sequence }, () => {
      this.acknowledgeSequence(hostId, sequence);
    });
  }

  private acknowledgeSequence(hostId: string, sequence: number): void {
    const highest = this.database
      .prepare("SELECT MAX(sequence) AS sequence FROM mailbox_messages WHERE host_id=?")
      .get(hostId);
    const highestSequence = Number(highest?.sequence ?? 0);
    if (sequence > highestSequence) throw new Error("mailbox_ack_beyond_highest_sequence");
    const acknowledgedAt = new Date().toISOString();
    this.database
      .prepare(
        "UPDATE mailbox_messages SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE host_id=? AND sequence<=?"
      )
      .run(acknowledgedAt, hostId, sequence);
    this.database
      .prepare(
        `UPDATE agent_hosts
         SET last_acknowledged_sequence=MAX(last_acknowledged_sequence,?)
         WHERE id=? AND revoked_at IS NULL`
      )
      .run(sequence, hostId);
  }

  subscribe(hostId: string, listener: MailboxListener): () => void {
    const hostListeners = this.listeners.get(hostId) ?? new Set<MailboxListener>();
    hostListeners.add(listener);
    this.listeners.set(hostId, hostListeners);
    return () => {
      hostListeners.delete(listener);
      if (hostListeners.size === 0) this.listeners.delete(hostId);
    };
  }
}

import { randomUUID } from "node:crypto";
import { HostEventInbox } from "./hostEvents.js";
import {
  mailboxCommandSchema,
  mailboxDeliveredSequenceSchema,
  mailboxMessageIdSchema,
  type MailboxCommand,
  type MailboxMessageId
} from "@planweave-ai/distributed-protocol";
import type { SqliteDatabase } from "./sqlite.js";

export type MailboxMessage = {
  sequence: number;
  messageId: MailboxMessageId;
  hostId: string;
  command: MailboxCommand;
  createdAt: string;
  acknowledgedAt?: string;
  publishedAt?: string;
};

type MailboxListener = (message: MailboxMessage) => void;

function toMessage(row: Record<string, unknown>): MailboxMessage {
  return {
    sequence: mailboxDeliveredSequenceSchema.parse(Number(row.sequence)),
    messageId: mailboxMessageIdSchema.parse(String(row.message_id)),
    hostId: String(row.host_id),
    command: mailboxCommandSchema.parse(JSON.parse(String(row.command_json))),
    createdAt: String(row.created_at),
    acknowledgedAt: row.acknowledged_at ? String(row.acknowledged_at) : undefined,
    publishedAt: row.published_at ? String(row.published_at) : undefined
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
    const messageId = mailboxMessageIdSchema.parse(randomUUID());
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

  enqueueOnce(
    messageId: string,
    hostId: string,
    command: MailboxCommand
  ): { message: MailboxMessage; created: boolean } {
    const parsedMessageId = mailboxMessageIdSchema.parse(messageId);
    const parsedCommand = mailboxCommandSchema.parse(command);
    const existing = this.database
      .prepare("SELECT * FROM mailbox_messages WHERE message_id=?")
      .get(parsedMessageId);
    if (existing) {
      const message = toMessage(existing);
      if (
        message.hostId !== hostId ||
        JSON.stringify(message.command) !== JSON.stringify(parsedCommand)
      ) {
        throw new Error("mailbox_message_identity_conflict");
      }
      return { message, created: false };
    }
    const createdAt = new Date().toISOString();
    const result = this.database
      .prepare(
        "INSERT INTO mailbox_messages(message_id,host_id,command_json,created_at) VALUES (?,?,?,?)"
      )
      .run(parsedMessageId, hostId, JSON.stringify(parsedCommand), createdAt);
    return {
      created: true,
      message: {
        sequence: Number(result.lastInsertRowid),
        messageId: parsedMessageId,
        hostId,
        command: parsedCommand,
        createdAt
      }
    };
  }

  markPublished(messageId: string, at = new Date()): MailboxMessage {
    const parsedMessageId = mailboxMessageIdSchema.parse(messageId);
    const updated = this.database
      .prepare(
        "UPDATE mailbox_messages SET published_at=COALESCE(published_at,?) WHERE message_id=?"
      )
      .run(at.toISOString(), parsedMessageId);
    if (updated.changes !== 1) throw new Error("mailbox_message_not_found");
    const row = this.database
      .prepare("SELECT * FROM mailbox_messages WHERE message_id=?")
      .get(parsedMessageId);
    if (!row) throw new Error("mailbox_message_not_found");
    return toMessage(row);
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

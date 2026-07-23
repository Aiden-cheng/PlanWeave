import { z } from "zod";
import { parseAgentHostMailboxCommand, type MailboxCommand } from "../protocol.js";
import type { SqliteDatabase } from "./sqliteDatabase.js";

export type ExecuteBlockCommand = Extract<MailboxCommand, { type: "execute_block" }>;
export type CancelExecutionCommand = Extract<MailboxCommand, { type: "cancel_execution" }>;

export type AgentHostExecutionStatus =
  | "pending"
  | "running"
  | "interrupted"
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

const inboxRowSchema = z.object({
  sequence: z.number().int().positive(),
  previous_sequence: z.number().int().nonnegative(),
  message_id: z.string(),
  command_json: z.string(),
  execution_status: z
    .enum(["pending", "running", "interrupted", "cancelling", "completed", "failed"])
    .nullable(),
  lease_expires_at: z.string().datetime().nullable(),
  received_at: z.string().datetime(),
  started_at: z.string().datetime().nullable(),
  finished_at: z.string().datetime().nullable()
});

export const outboxRowSchema = z.object({ event_json: z.string() });

const schema = `
CREATE TABLE IF NOT EXISTS agent_host_inbox (
  sequence INTEGER PRIMARY KEY,
  previous_sequence INTEGER NOT NULL DEFAULT 0,
  message_id TEXT NOT NULL UNIQUE,
  command_json TEXT NOT NULL,
  execution_status TEXT CHECK(execution_status IN (
    'pending','running','interrupted','cancelling','completed','failed'
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

export function initializeAgentHostStateSchema(database: SqliteDatabase): void {
  database.exec(schema);
  const columns = database.prepare("PRAGMA table_info(agent_host_inbox)").all();
  if (!columns.some((column) => column.name === "previous_sequence")) {
    database.exec(
      "ALTER TABLE agent_host_inbox ADD COLUMN previous_sequence INTEGER NOT NULL DEFAULT 0"
    );
    database.exec(
      `UPDATE agent_host_inbox
       SET previous_sequence=COALESCE((
         SELECT MAX(prior.sequence) FROM agent_host_inbox AS prior
         WHERE prior.sequence<agent_host_inbox.sequence
       ),0)`
    );
  }
}

export function toExecution(raw: Record<string, unknown>): AgentHostExecution {
  const row = inboxRowSchema.parse(raw);
  const command = parseAgentHostMailboxCommand(JSON.parse(row.command_json));
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

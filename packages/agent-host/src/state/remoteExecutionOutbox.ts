import { z } from "zod";
import type {
  AgentHostRemoteExecutionIdentity,
  AgentHostRemoteExecutionOutbox,
  AgentHostRemoteExecutionRecord
} from "../execution/remoteAcpPorts.js";
import { agentHostRemoteExecutionRecordSchema } from "../execution/remoteAcpPorts.js";
import {
  inWriteTransaction,
  openAgentHostDatabase,
  type SqliteDatabase
} from "./sqliteDatabase.js";

const recordRowSchema = z.object({ record_json: z.string() });

const schema = `
CREATE TABLE IF NOT EXISTS agent_host_remote_execution_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  execution_attempt_id TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(dispatch_id,lease_id,execution_attempt_id,record_kind,record_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_host_remote_execution_identity
  ON agent_host_remote_execution_outbox(dispatch_id,lease_id,execution_attempt_id,sequence);
`;

function recordId(record: AgentHostRemoteExecutionRecord): string {
  return record.kind === "engine_event" ? String(record.event.sequence) : record.request.requestId;
}

export class AgentHostSqliteRemoteExecutionOutbox implements AgentHostRemoteExecutionOutbox {
  constructor(private readonly database: SqliteDatabase) {
    database.exec(schema);
  }

  close(): void {
    this.database.close();
  }

  append(record: AgentHostRemoteExecutionRecord): void {
    const parsed = agentHostRemoteExecutionRecordSchema.parse(record);
    const serialized = JSON.stringify(parsed);
    inWriteTransaction(this.database, () => {
      const key = [
        parsed.identity.dispatchId,
        parsed.identity.leaseId,
        parsed.identity.executionAttemptId,
        parsed.kind,
        recordId(parsed)
      ] as const;
      const existing = this.database
        .prepare(
          `SELECT record_json FROM agent_host_remote_execution_outbox
           WHERE dispatch_id = ? AND lease_id = ? AND execution_attempt_id = ?
             AND record_kind = ? AND record_id = ?`
        )
        .get(...key);
      if (existing) {
        if (recordRowSchema.parse(existing).record_json !== serialized) {
          throw new Error("remote_execution_outbox_conflict");
        }
        return;
      }
      this.database
        .prepare(
          `INSERT INTO agent_host_remote_execution_outbox(
            dispatch_id,lease_id,execution_attempt_id,record_kind,record_id,record_json,created_at
          ) VALUES(?,?,?,?,?,?,?)`
        )
        .run(...key, serialized, new Date().toISOString());
    });
  }

  records(identity: AgentHostRemoteExecutionIdentity): AgentHostRemoteExecutionRecord[] {
    return this.database
      .prepare(
        `SELECT record_json FROM agent_host_remote_execution_outbox
         WHERE dispatch_id = ? AND lease_id = ? AND execution_attempt_id = ?
         ORDER BY sequence`
      )
      .all(identity.dispatchId, identity.leaseId, identity.executionAttemptId)
      .map((row) =>
        agentHostRemoteExecutionRecordSchema.parse(
          JSON.parse(recordRowSchema.parse(row).record_json)
        )
      );
  }
}

export async function openAgentHostRemoteExecutionOutbox(
  path: string,
  options: { busyTimeoutMs?: number } = {}
): Promise<AgentHostSqliteRemoteExecutionOutbox> {
  const database = await openAgentHostDatabase(path, options.busyTimeoutMs ?? 5_000);
  return new AgentHostSqliteRemoteExecutionOutbox(database);
}

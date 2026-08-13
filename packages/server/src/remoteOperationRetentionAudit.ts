import { z } from "zod";
import {
  auditRows,
  type RemoteOperationRetentionSummary
} from "./remoteOperationRetentionReceipt.js";
import type { SqliteDatabase } from "./sqlite.js";

export type RetentionAttemptIdentity = {
  executionAttemptId: string;
  dispatchId: string;
};

const artifactProvenanceRowSchema = z
  .object({
    artifact_ref: z.string(),
    dispatch_id: z.string(),
    execution_attempt_id: z.string(),
    grant_id: z.string(),
    permission: z.enum(["input_read", "report_write", "output_write"]),
    purpose: z.enum(["input", "report", "output"]),
    produced_by_host_id: z.string().nullable(),
    logical_name: z.string().nullable(),
    expected_sha256: z.string()
  })
  .strict();

function queryIn(
  database: SqliteDatabase,
  sql: string,
  values: readonly string[]
): Array<Record<string, unknown>> {
  if (values.length === 0) return [];
  const placeholders = values.map(() => "?").join(",");
  return database.prepare(sql.replace("__IN__", placeholders)).all(...values);
}

export function auditRemoteOperationCompaction(
  database: SqliteDatabase,
  operationId: string,
  currentAttemptId: string,
  attempts: readonly RetentionAttemptIdentity[]
): Pick<RemoteOperationRetentionSummary, "streams" | "historicalArtifactProvenance"> {
  const attemptIds = attempts.map((attempt) => attempt.executionAttemptId);
  const historical = attempts.filter((attempt) => attempt.executionAttemptId !== currentAttemptId);
  const historicalAttemptIds = historical.map((attempt) => attempt.executionAttemptId);
  const historicalDispatchIds = historical.map((attempt) => attempt.dispatchId);
  const historicalArtifactLinks = queryIn(
    database,
    `SELECT * FROM dispatch_artifact_links WHERE dispatch_id IN (__IN__)
     ORDER BY dispatch_id,link_id`,
    historicalDispatchIds
  );
  const historicalArtifactGrants = queryIn(
    database,
    `SELECT * FROM artifact_grants WHERE dispatch_id IN (__IN__)
     ORDER BY dispatch_id,grant_id`,
    historicalDispatchIds
  );
  const provenanceRows = queryIn(
    database,
    `SELECT link.artifact_ref,link.dispatch_id,link.execution_attempt_id,link.grant_id,
       link.permission,link.purpose,link.produced_by_host_id,link.logical_name,
       grant.expected_sha256
     FROM dispatch_artifact_links link
     JOIN artifact_grants grant ON grant.grant_id=link.grant_id
     WHERE link.dispatch_id IN (__IN__)
     ORDER BY link.dispatch_id,link.link_id`,
    historicalDispatchIds
  ).map((row) => artifactProvenanceRowSchema.parse(row));

  return {
    streams: {
      operationEvents: auditRows(
        database
          .prepare("SELECT * FROM remote_operation_events WHERE operation_id=? ORDER BY sequence")
          .all(operationId)
      ),
      candidates: auditRows(
        database
          .prepare(
            "SELECT * FROM remote_operation_candidates WHERE operation_id=? ORDER BY operation_id"
          )
          .all(operationId)
      ),
      actions: auditRows(
        database
          .prepare("SELECT * FROM remote_execution_actions WHERE operation_id=? ORDER BY action_id")
          .all(operationId)
      ),
      interactions: auditRows(
        database
          .prepare(
            `SELECT * FROM remote_interactions WHERE operation_id=?
             ORDER BY host_id,dispatch_id,execution_attempt_id,acp_session_id,action_id`
          )
          .all(operationId)
      ),
      reservations: auditRows(
        queryIn(
          database,
          `SELECT * FROM host_capacity_reservations
           WHERE execution_attempt_id IN (__IN__) ORDER BY lease_id`,
          attemptIds
        )
      ),
      acpStreams: auditRows(
        queryIn(
          database,
          `SELECT * FROM remote_acp_event_streams
           WHERE execution_attempt_id IN (__IN__) ORDER BY execution_attempt_id`,
          historicalAttemptIds
        )
      ),
      acpEvents: auditRows(
        queryIn(
          database,
          `SELECT * FROM remote_acp_events WHERE execution_attempt_id IN (__IN__)
           ORDER BY execution_attempt_id,cursor`,
          attemptIds
        )
      ),
      historicalAttempts: auditRows(
        queryIn(
          database,
          `SELECT * FROM remote_execution_attempts WHERE execution_attempt_id IN (__IN__)
           ORDER BY created_at,execution_attempt_id`,
          historicalAttemptIds
        )
      ),
      historicalDispatches: auditRows(
        queryIn(
          database,
          "SELECT * FROM dispatches WHERE id IN (__IN__) ORDER BY created_at,id",
          historicalDispatchIds
        )
      ),
      historicalDispatchEvents: auditRows(
        queryIn(
          database,
          `SELECT * FROM dispatch_events WHERE dispatch_id IN (__IN__)
           ORDER BY dispatch_id,sequence`,
          historicalDispatchIds
        )
      ),
      historicalDispatchEnvelopes: auditRows(
        queryIn(
          database,
          `SELECT * FROM dispatch_execution_envelopes WHERE dispatch_id IN (__IN__)
           ORDER BY dispatch_id`,
          historicalDispatchIds
        )
      ),
      historicalArtifactGrants: auditRows(historicalArtifactGrants),
      historicalArtifactLinks: auditRows(historicalArtifactLinks)
    },
    historicalArtifactProvenance: provenanceRows.map((row) => ({
      artifactRef: row.artifact_ref,
      dispatchId: row.dispatch_id,
      executionAttemptId: row.execution_attempt_id,
      grantId: row.grant_id,
      permission: row.permission,
      purpose: row.purpose,
      producedByHostId: row.produced_by_host_id,
      logicalName: row.logical_name,
      expectedSha256: row.expected_sha256
    }))
  };
}

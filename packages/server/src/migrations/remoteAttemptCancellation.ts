import type { Migration } from "./types.js";

export const remoteAttemptCancellationMigration: Migration = {
  version: 45,
  sql: `
    CREATE TABLE remote_execution_attempts_v45_new (
      execution_attempt_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES remote_operations(id),
      dispatch_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      canvas_id TEXT NOT NULL,
      block_ref TEXT NOT NULL,
      ownership_generation TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'prepared','reserved','activated','running','interrupted','action_required',
        'awaiting_writeback','superseded','completed','failed','cancelled'
      )),
      host_id TEXT REFERENCES agent_hosts(id),
      lease_id TEXT UNIQUE,
      lease_fencing_token INTEGER NOT NULL DEFAULT 0 CHECK(lease_fencing_token >= 0),
      lease_expires_at TEXT,
      state_version INTEGER NOT NULL DEFAULT 0 CHECK(state_version >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT,
      CHECK(
        (status IN ('prepared','cancelled') AND host_id IS NULL AND lease_id IS NULL
          AND lease_expires_at IS NULL AND lease_fencing_token=0)
        OR (status<>'prepared' AND host_id IS NOT NULL AND lease_id IS NOT NULL
          AND lease_expires_at IS NOT NULL AND lease_fencing_token>0)
      ),
      CHECK((status IN ('superseded','completed','failed','cancelled') AND terminal_at IS NOT NULL)
        OR (status NOT IN ('superseded','completed','failed','cancelled') AND terminal_at IS NULL))
    );

    INSERT INTO remote_execution_attempts_v45_new(
      execution_attempt_id,operation_id,dispatch_id,workspace_id,project_id,canvas_id,block_ref,
      ownership_generation,status,host_id,lease_id,lease_fencing_token,lease_expires_at,
      state_version,created_at,updated_at,terminal_at
    )
    SELECT execution_attempt_id,operation_id,dispatch_id,workspace_id,project_id,canvas_id,block_ref,
      ownership_generation,status,host_id,lease_id,lease_fencing_token,lease_expires_at,
      state_version,created_at,updated_at,terminal_at
    FROM remote_execution_attempts;

    DROP TABLE remote_execution_attempts;
    ALTER TABLE remote_execution_attempts_v45_new RENAME TO remote_execution_attempts;

    CREATE UNIQUE INDEX idx_remote_attempt_active_ownership
      ON remote_execution_attempts(workspace_id,project_id,canvas_id,block_ref,ownership_generation)
      WHERE status IN ('reserved','activated','running','interrupted','action_required','awaiting_writeback');
    CREATE INDEX idx_remote_attempt_operation_status
      ON remote_execution_attempts(operation_id,status);
    CREATE UNIQUE INDEX idx_remote_attempt_dispatch_identity
      ON remote_execution_attempts(dispatch_id);
    CREATE UNIQUE INDEX idx_remote_attempt_lease_identity
      ON remote_execution_attempts(lease_id) WHERE lease_id IS NOT NULL;
  `,
  disableForeignKeys: true
};

import { artifactMediaTypeSchema } from "./artifactMediaType.js";
import { capabilitiesSchema } from "./protocol.js";
import type { SqliteDatabase } from "./sqlite.js";

const migration1 = `
CREATE TABLE server_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const migration2 = `
CREATE TABLE agent_hosts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 128),
  last_seen_at TEXT,
  last_acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE dispatches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  block_ref TEXT NOT NULL,
  package_ref TEXT NOT NULL,
  host_id TEXT NOT NULL REFERENCES agent_hosts(id),
  required_capabilities_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'leased','running','cancelling','awaiting_writeback','completed','failed','cancelled'
  )),
  lease_id TEXT NOT NULL UNIQUE,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  finished_at TEXT,
  result_json TEXT,
  failure_json TEXT
);

CREATE INDEX idx_dispatches_host_status ON dispatches(host_id,status);
CREATE INDEX idx_dispatches_writeback ON dispatches(status,created_at);

CREATE TABLE mailbox_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  host_id TEXT NOT NULL REFERENCES agent_hosts(id),
  command_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT
);

CREATE INDEX idx_mailbox_host_sequence ON mailbox_messages(host_id,sequence);

CREATE TABLE host_event_receipts (
  message_id TEXT NOT NULL,
  host_id TEXT NOT NULL REFERENCES agent_hosts(id),
  type TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY(message_id,host_id)
);

CREATE TABLE dispatch_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id TEXT NOT NULL REFERENCES dispatches(id),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_dispatch_events_dispatch_sequence
  ON dispatch_events(dispatch_id,sequence);
`;

const migration3 = `
CREATE TABLE artifacts (
  ref TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  media_type TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  created_by_host_id TEXT REFERENCES agent_hosts(id),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_artifacts_created_by_host ON artifacts(created_by_host_id,created_at);
`;

const migration4 = `
ALTER TABLE dispatches ADD COLUMN execution_attempt_id TEXT;
UPDATE dispatches SET execution_attempt_id=id WHERE execution_attempt_id IS NULL;
`;

const migration5 = `
CREATE TABLE dispatches_v5 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  block_ref TEXT NOT NULL,
  package_ref TEXT NOT NULL,
  host_id TEXT NOT NULL REFERENCES agent_hosts(id),
  required_capabilities_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'leased','running','interrupted','cancelling','awaiting_writeback','completed','failed','cancelled'
  )),
  lease_id TEXT NOT NULL UNIQUE,
  execution_attempt_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  finished_at TEXT,
  result_json TEXT,
  failure_json TEXT,
  interruption_reason TEXT,
  interruption_resumable INTEGER,
  interruption_recovery_json TEXT
);

INSERT INTO dispatches_v5(
  id,project_id,block_ref,package_ref,host_id,required_capabilities_json,status,lease_id,
  execution_attempt_id,lease_expires_at,created_at,accepted_at,finished_at,result_json,failure_json
)
SELECT
  id,project_id,block_ref,package_ref,host_id,required_capabilities_json,status,lease_id,
  execution_attempt_id,lease_expires_at,created_at,accepted_at,finished_at,result_json,failure_json
FROM dispatches;

DROP INDEX idx_dispatches_host_status;
DROP INDEX idx_dispatches_writeback;
DROP TABLE dispatches;
ALTER TABLE dispatches_v5 RENAME TO dispatches;
CREATE INDEX idx_dispatches_host_status ON dispatches(host_id,status);
CREATE INDEX idx_dispatches_writeback ON dispatches(status,created_at);
`;

const migration6 = `
CREATE TABLE artifact_blobs (
  ref TEXT PRIMARY KEY CHECK(
    length(ref)=80 AND substr(ref,1,16)='artifact:sha256:'
    AND substr(ref,17) NOT GLOB '*[^a-f0-9]*'
  ),
  sha256 TEXT NOT NULL UNIQUE CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  media_type TEXT NOT NULL CHECK(length(media_type) BETWEEN 1 AND 255),
  relative_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  CHECK(ref='artifact:sha256:' || sha256),
  CHECK(media_type NOT GLOB '*[^ -~]*'),
  CHECK(relative_path=substr(sha256,1,2) || '/' || sha256)
);

INSERT INTO artifact_blobs(ref,sha256,size_bytes,media_type,relative_path,created_at)
SELECT ref,sha256,size_bytes,media_type,relative_path,created_at FROM artifacts;

DROP INDEX idx_artifacts_created_by_host;
DROP TABLE artifacts;

CREATE TABLE dispatch_execution_envelopes (
  dispatch_id TEXT PRIMARY KEY REFERENCES dispatches(id),
  envelope_digest TEXT NOT NULL UNIQUE
    CHECK(
      length(envelope_digest)=80 AND substr(envelope_digest,1,16)='envelope:sha256:'
      AND substr(envelope_digest,17) NOT GLOB '*[^a-f0-9]*'
    ),
  canonical_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_dispatches_artifact_scope
  ON dispatches(id,project_id,host_id,lease_id,execution_attempt_id);
CREATE UNIQUE INDEX idx_dispatches_lease_scope
  ON dispatches(id,lease_id,execution_attempt_id);

CREATE TABLE artifact_grants (
  grant_id TEXT PRIMARY KEY,
  request_fingerprint TEXT NOT NULL,
  project_id TEXT NOT NULL,
  host_id TEXT NOT NULL REFERENCES agent_hosts(id),
  dispatch_id TEXT NOT NULL REFERENCES dispatches(id),
  lease_id TEXT NOT NULL,
  execution_attempt_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('input_read','report_write','output_write')),
  artifact_ref TEXT NOT NULL
    CHECK(
      length(artifact_ref)=80 AND substr(artifact_ref,1,16)='artifact:sha256:'
      AND substr(artifact_ref,17) NOT GLOB '*[^a-f0-9]*'
    ),
  expected_sha256 TEXT NOT NULL
    CHECK(length(expected_sha256)=64 AND expected_sha256 NOT GLOB '*[^a-f0-9]*'),
  expected_size_bytes INTEGER CHECK(expected_size_bytes IS NULL OR expected_size_bytes >= 0),
  expected_media_type TEXT CHECK(expected_media_type IS NULL OR length(expected_media_type) BETWEEN 1 AND 255),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  CHECK(artifact_ref='artifact:sha256:' || expected_sha256),
  CHECK(expected_media_type IS NULL OR expected_media_type NOT GLOB '*[^ -~]*'),
  CHECK(
    (permission='input_read' AND expected_size_bytes IS NULL AND expected_media_type IS NULL AND consumed_at IS NULL)
    OR
    (permission IN ('report_write','output_write') AND expected_size_bytes IS NOT NULL AND expected_media_type IS NOT NULL)
  ),
  FOREIGN KEY(dispatch_id,project_id,host_id,lease_id,execution_attempt_id)
    REFERENCES dispatches(id,project_id,host_id,lease_id,execution_attempt_id)
);

CREATE INDEX idx_artifact_grants_authorization
  ON artifact_grants(host_id,dispatch_id,lease_id,execution_attempt_id,permission,artifact_ref);
CREATE INDEX idx_artifact_grants_expiry ON artifact_grants(expires_at,revoked_at,consumed_at);

CREATE TABLE dispatch_artifact_links (
  link_id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id TEXT NOT NULL REFERENCES dispatches(id),
  lease_id TEXT NOT NULL,
  execution_attempt_id TEXT NOT NULL,
  artifact_ref TEXT NOT NULL REFERENCES artifact_blobs(ref),
  purpose TEXT NOT NULL CHECK(purpose IN ('input','report','output')),
  logical_name TEXT,
  grant_id TEXT NOT NULL UNIQUE REFERENCES artifact_grants(grant_id),
  produced_by_host_id TEXT REFERENCES agent_hosts(id),
  linked_at TEXT NOT NULL,
  CHECK(
    (purpose='input' AND logical_name IS NOT NULL AND produced_by_host_id IS NULL)
    OR
    (purpose IN ('report','output') AND logical_name IS NULL AND produced_by_host_id IS NOT NULL)
  ),
  FOREIGN KEY(dispatch_id,lease_id,execution_attempt_id)
    REFERENCES dispatches(id,lease_id,execution_attempt_id)
);

CREATE UNIQUE INDEX idx_dispatch_artifact_links_input
  ON dispatch_artifact_links(dispatch_id,execution_attempt_id,artifact_ref,logical_name)
  WHERE purpose='input';
CREATE UNIQUE INDEX idx_dispatch_artifact_links_output
  ON dispatch_artifact_links(dispatch_id,execution_attempt_id,purpose,artifact_ref)
  WHERE purpose IN ('report','output');

CREATE INDEX idx_dispatch_artifact_links_provenance
  ON dispatch_artifact_links(dispatch_id,lease_id,execution_attempt_id,artifact_ref,purpose);
`;

const migration7 = `
CREATE UNIQUE INDEX idx_artifact_grants_link_scope ON artifact_grants(
  grant_id,project_id,host_id,dispatch_id,lease_id,execution_attempt_id,artifact_ref,permission
);

CREATE TABLE dispatch_artifact_links_v7 (
  link_id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  host_id TEXT NOT NULL REFERENCES agent_hosts(id),
  dispatch_id TEXT NOT NULL REFERENCES dispatches(id),
  lease_id TEXT NOT NULL,
  execution_attempt_id TEXT NOT NULL,
  artifact_ref TEXT NOT NULL REFERENCES artifact_blobs(ref),
  purpose TEXT NOT NULL CHECK(purpose IN ('input','report','output')),
  permission TEXT NOT NULL CHECK(permission IN ('input_read','report_write','output_write')),
  logical_name TEXT,
  grant_id TEXT NOT NULL UNIQUE,
  produced_by_host_id TEXT REFERENCES agent_hosts(id),
  linked_at TEXT NOT NULL,
  CHECK(
    (purpose='input' AND permission='input_read' AND logical_name IS NOT NULL
      AND produced_by_host_id IS NULL)
    OR
    (purpose='report' AND permission='report_write' AND logical_name IS NULL
      AND produced_by_host_id=host_id)
    OR
    (purpose='output' AND permission='output_write' AND logical_name IS NULL
      AND produced_by_host_id=host_id)
  ),
  FOREIGN KEY(dispatch_id,project_id,host_id,lease_id,execution_attempt_id)
    REFERENCES dispatches(id,project_id,host_id,lease_id,execution_attempt_id),
  FOREIGN KEY(
    grant_id,project_id,host_id,dispatch_id,lease_id,execution_attempt_id,artifact_ref,permission
  ) REFERENCES artifact_grants(
    grant_id,project_id,host_id,dispatch_id,lease_id,execution_attempt_id,artifact_ref,permission
  )
);

INSERT INTO dispatch_artifact_links_v7(
  link_id,project_id,host_id,dispatch_id,lease_id,execution_attempt_id,artifact_ref,
  purpose,permission,logical_name,grant_id,produced_by_host_id,linked_at
)
SELECT
  l.link_id,g.project_id,g.host_id,l.dispatch_id,l.lease_id,l.execution_attempt_id,l.artifact_ref,
  l.purpose,g.permission,l.logical_name,l.grant_id,l.produced_by_host_id,l.linked_at
FROM dispatch_artifact_links l JOIN artifact_grants g ON g.grant_id=l.grant_id;

DROP TABLE dispatch_artifact_links;
ALTER TABLE dispatch_artifact_links_v7 RENAME TO dispatch_artifact_links;

CREATE UNIQUE INDEX idx_dispatch_artifact_links_input
  ON dispatch_artifact_links(dispatch_id,execution_attempt_id,artifact_ref,logical_name)
  WHERE purpose='input';
CREATE UNIQUE INDEX idx_dispatch_artifact_links_output
  ON dispatch_artifact_links(dispatch_id,execution_attempt_id,purpose,artifact_ref)
  WHERE purpose IN ('report','output');
CREATE INDEX idx_dispatch_artifact_links_provenance
  ON dispatch_artifact_links(dispatch_id,lease_id,execution_attempt_id,artifact_ref,purpose);
`;

const migration9 = `
ALTER TABLE agent_hosts ADD COLUMN credential_expires_at TEXT;

CREATE TABLE agent_host_enrollment_grants (
  code_hash TEXT PRIMARY KEY CHECK(length(code_hash)=64 AND code_hash NOT GLOB '*[^a-f0-9]*'),
  expires_at TEXT NOT NULL,
  credential_expires_at TEXT NOT NULL,
  revoked_at TEXT,
  used_at TEXT,
  used_attempt_id TEXT,
  used_request_hash TEXT CHECK(used_request_hash IS NULL OR length(used_request_hash)=64),
  host_id TEXT REFERENCES agent_hosts(id),
  created_at TEXT NOT NULL,
  CHECK(
    (used_at IS NULL AND used_attempt_id IS NULL AND used_request_hash IS NULL AND host_id IS NULL)
    OR
    (used_at IS NOT NULL AND used_attempt_id IS NOT NULL AND used_request_hash IS NOT NULL AND host_id IS NOT NULL)
  )
);
`;

const migration10 = `
CREATE TABLE remote_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  block_ref TEXT NOT NULL,
  ownership_generation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK(
    length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^a-f0-9]*'
  ),
  source_fingerprint TEXT NOT NULL,
  required_capabilities_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'preparing','claimed','reserved','activated','running','interrupted','action_required',
    'awaiting_writeback','completed','failed','cancelled'
  )),
  dispatch_id TEXT NOT NULL UNIQUE,
  execution_attempt_id TEXT NOT NULL UNIQUE,
  envelope_digest TEXT CHECK(
    envelope_digest IS NULL OR (
      length(envelope_digest)=80 AND substr(envelope_digest,1,16)='envelope:sha256:'
      AND substr(envelope_digest,17) NOT GLOB '*[^a-f0-9]*'
    )
  ),
  envelope_reference TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  UNIQUE(project_id,canvas_id,block_ref,ownership_generation,idempotency_key),
  CHECK(
    (state IN ('completed','failed','cancelled') AND terminal_at IS NOT NULL)
    OR (state NOT IN ('completed','failed','cancelled') AND terminal_at IS NULL)
  )
);

CREATE TABLE remote_execution_attempts (
  execution_attempt_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES remote_operations(id),
  dispatch_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  canvas_id TEXT NOT NULL,
  block_ref TEXT NOT NULL,
  ownership_generation TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'prepared','reserved','activated','running','interrupted','action_required',
    'awaiting_writeback','completed','failed','cancelled'
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
    (status='prepared' AND host_id IS NULL AND lease_id IS NULL AND lease_expires_at IS NULL
      AND lease_fencing_token=0)
    OR (status<>'prepared' AND host_id IS NOT NULL AND lease_id IS NOT NULL
      AND lease_expires_at IS NOT NULL AND lease_fencing_token>0)
  ),
  CHECK(
    (status IN ('completed','failed','cancelled') AND terminal_at IS NOT NULL)
    OR (status NOT IN ('completed','failed','cancelled') AND terminal_at IS NULL)
  )
);

CREATE UNIQUE INDEX idx_remote_attempt_active_ownership
  ON remote_execution_attempts(project_id,canvas_id,block_ref,ownership_generation)
  WHERE status IN (
    'reserved','activated','running','interrupted','action_required','awaiting_writeback'
  );
CREATE INDEX idx_remote_attempt_operation_status
  ON remote_execution_attempts(operation_id,status);

CREATE TABLE host_capacity_reservations (
  lease_id TEXT PRIMARY KEY,
  execution_attempt_id TEXT NOT NULL UNIQUE
    REFERENCES remote_execution_attempts(execution_attempt_id),
  host_id TEXT NOT NULL REFERENCES agent_hosts(id),
  fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
  status TEXT NOT NULL CHECK(status IN ('active','released','expired','cancelled')),
  lease_expires_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  created_at TEXT NOT NULL,
  released_at TEXT,
  CHECK(
    (status='active' AND released_at IS NULL)
    OR (status<>'active' AND released_at IS NOT NULL)
  )
);

CREATE INDEX idx_host_capacity_reservations_active
  ON host_capacity_reservations(host_id,lease_expires_at)
  WHERE status='active';

CREATE TABLE remote_operation_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES remote_operations(id),
  execution_attempt_id TEXT REFERENCES remote_execution_attempts(execution_attempt_id),
  type TEXT NOT NULL CHECK(type IN (
    'remote.operation.created','remote.operation.claimed','remote.operation.envelope_recorded',
    'remote.attempt.reserved','remote.attempt.activated','remote.attempt.running',
    'remote.attempt.interrupted','remote.attempt.action_required',
    'remote.attempt.awaiting_writeback','remote.attempt.completed','remote.attempt.failed',
    'remote.attempt.cancelled','remote.reservation.released','remote.reservation.expired',
    'remote.reservation.cancelled'
  )),
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_remote_operation_events_operation_sequence
  ON remote_operation_events(operation_id,sequence);
`;

const migration11 = `
ALTER TABLE remote_operations ADD COLUMN diagnostic_code TEXT;
ALTER TABLE remote_operations ADD COLUMN diagnostic_message TEXT;
ALTER TABLE mailbox_messages ADD COLUMN published_at TEXT;

CREATE TABLE remote_operation_candidates (
  operation_id TEXT PRIMARY KEY REFERENCES remote_operations(id),
  candidate_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const migration12 = `
ALTER TABLE mailbox_messages ADD COLUMN previous_sequence INTEGER NOT NULL DEFAULT 0;
`;

const migration13 = `
CREATE TABLE remote_execution_attempts_v13 (
  execution_attempt_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES remote_operations(id),
  dispatch_id TEXT NOT NULL UNIQUE,
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
    (status='prepared' AND host_id IS NULL AND lease_id IS NULL AND lease_expires_at IS NULL
      AND lease_fencing_token=0)
    OR (status<>'prepared' AND host_id IS NOT NULL AND lease_id IS NOT NULL
      AND lease_expires_at IS NOT NULL AND lease_fencing_token>0)
  ),
  CHECK(
    (status IN ('superseded','completed','failed','cancelled') AND terminal_at IS NOT NULL)
    OR (status NOT IN ('superseded','completed','failed','cancelled') AND terminal_at IS NULL)
  )
);

INSERT INTO remote_execution_attempts_v13 SELECT * FROM remote_execution_attempts;

CREATE TABLE host_capacity_reservations_v13 (
  lease_id TEXT PRIMARY KEY,
  execution_attempt_id TEXT NOT NULL REFERENCES remote_execution_attempts_v13(execution_attempt_id),
  host_id TEXT NOT NULL REFERENCES agent_hosts(id),
  fencing_token INTEGER NOT NULL CHECK(fencing_token > 0),
  status TEXT NOT NULL CHECK(status IN ('active','released','expired','cancelled')),
  lease_expires_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  created_at TEXT NOT NULL,
  released_at TEXT,
  CHECK(
    (status='active' AND released_at IS NULL)
    OR (status<>'active' AND released_at IS NOT NULL)
  )
);

INSERT INTO host_capacity_reservations_v13 SELECT * FROM host_capacity_reservations;

CREATE TABLE remote_operation_events_v13 (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL REFERENCES remote_operations(id),
  execution_attempt_id TEXT REFERENCES remote_execution_attempts_v13(execution_attempt_id),
  type TEXT NOT NULL CHECK(type IN (
    'remote.operation.created','remote.operation.claimed','remote.operation.envelope_recorded',
    'remote.attempt.reserved','remote.attempt.activated','remote.attempt.running',
    'remote.attempt.interrupted','remote.attempt.action_required',
    'remote.attempt.awaiting_writeback','remote.attempt.superseded','remote.attempt.retry_created',
    'remote.attempt.completed','remote.attempt.failed','remote.attempt.cancelled',
    'remote.reservation.released','remote.reservation.expired','remote.reservation.cancelled'
  )),
  occurred_at TEXT NOT NULL
);

INSERT INTO remote_operation_events_v13 SELECT * FROM remote_operation_events;

DROP TABLE remote_operation_events;
DROP TABLE host_capacity_reservations;
DROP TABLE remote_execution_attempts;
ALTER TABLE remote_execution_attempts_v13 RENAME TO remote_execution_attempts;
ALTER TABLE host_capacity_reservations_v13 RENAME TO host_capacity_reservations;
ALTER TABLE remote_operation_events_v13 RENAME TO remote_operation_events;

CREATE UNIQUE INDEX idx_remote_attempt_active_ownership
  ON remote_execution_attempts(project_id,canvas_id,block_ref,ownership_generation)
  WHERE status IN (
    'reserved','activated','running','interrupted','action_required','awaiting_writeback'
  );
CREATE INDEX idx_remote_attempt_operation_status
  ON remote_execution_attempts(operation_id,status);
CREATE INDEX idx_host_capacity_reservations_active
  ON host_capacity_reservations(host_id,lease_expires_at)
  WHERE status='active';
CREATE UNIQUE INDEX idx_host_capacity_reservation_active_attempt
  ON host_capacity_reservations(execution_attempt_id)
  WHERE status='active';
CREATE INDEX idx_remote_operation_events_operation_sequence
  ON remote_operation_events(operation_id,sequence);

CREATE TABLE remote_execution_actions (
  action_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES remote_operations(id),
  dispatch_id TEXT NOT NULL,
  execution_attempt_id TEXT NOT NULL REFERENCES remote_execution_attempts(execution_attempt_id),
  kind TEXT NOT NULL CHECK(kind IN ('resume_same_session','retry_new_attempt','fail','block','cancel')),
  request_fingerprint TEXT NOT NULL CHECK(
    length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^a-f0-9]*'
  ),
  request_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('recorded','delivered','acknowledged','settled')),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  acknowledged_at TEXT,
  settled_at TEXT,
  CHECK(
    (state='recorded' AND delivered_at IS NULL AND acknowledged_at IS NULL AND settled_at IS NULL)
    OR (state='delivered' AND delivered_at IS NOT NULL AND acknowledged_at IS NULL AND settled_at IS NULL)
    OR (state='acknowledged' AND delivered_at IS NOT NULL AND acknowledged_at IS NOT NULL AND settled_at IS NULL)
    OR (state='settled' AND settled_at IS NOT NULL)
  )
);

CREATE INDEX idx_remote_execution_actions_operation_state
  ON remote_execution_actions(operation_id,state,created_at);
`;

const migration14 = `
CREATE TABLE remote_acp_event_streams (
  execution_attempt_id TEXT PRIMARY KEY REFERENCES remote_execution_attempts(execution_attempt_id),
  operation_id TEXT NOT NULL REFERENCES remote_operations(id),
  dispatch_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  host_id TEXT NOT NULL REFERENCES agent_hosts(id),
  acp_session_id TEXT NOT NULL,
  latest_cursor INTEGER NOT NULL DEFAULT 0 CHECK(latest_cursor >= 0),
  retained_from_cursor INTEGER NOT NULL DEFAULT 1 CHECK(retained_from_cursor > 0),
  retained_count INTEGER NOT NULL DEFAULT 0 CHECK(retained_count >= 0),
  retained_bytes INTEGER NOT NULL DEFAULT 0 CHECK(retained_bytes >= 0),
  dropped_count INTEGER NOT NULL DEFAULT 0 CHECK(dropped_count >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE remote_acp_events (
  execution_attempt_id TEXT NOT NULL REFERENCES remote_acp_event_streams(execution_attempt_id),
  cursor INTEGER NOT NULL CHECK(cursor > 0),
  event_json TEXT NOT NULL,
  encoded_bytes INTEGER NOT NULL CHECK(encoded_bytes > 0),
  received_at TEXT NOT NULL,
  PRIMARY KEY(execution_attempt_id,cursor)
);

CREATE TABLE remote_interactions (
  action_id TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES remote_operations(id),
  host_id TEXT NOT NULL REFERENCES agent_hosts(id),
  dispatch_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  execution_attempt_id TEXT NOT NULL REFERENCES remote_execution_attempts(execution_attempt_id),
  acp_session_id TEXT NOT NULL,
  request_type TEXT NOT NULL CHECK(request_type IN (
    'interaction.permission_requested','interaction.elicitation_requested',
    'interaction.authentication_required'
  )),
  request_fingerprint TEXT NOT NULL CHECK(
    length(request_fingerprint)=64 AND request_fingerprint NOT GLOB '*[^a-f0-9]*'
  ),
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','settled','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settlement_fingerprint TEXT,
  settlement_json TEXT,
  settled_by TEXT,
  settled_at TEXT,
  mailbox_message_id TEXT,
  expiry_mailbox_message_id TEXT,
  CHECK(
    (status='pending' AND settlement_fingerprint IS NULL AND settlement_json IS NULL
      AND settled_by IS NULL AND settled_at IS NULL AND mailbox_message_id IS NULL
      AND expiry_mailbox_message_id IS NULL)
    OR (status='settled' AND settlement_fingerprint IS NOT NULL AND settlement_json IS NOT NULL
      AND settled_by IS NOT NULL AND settled_at IS NOT NULL AND mailbox_message_id IS NOT NULL
      AND expiry_mailbox_message_id IS NULL)
    OR (status='expired' AND settlement_fingerprint IS NULL AND settlement_json IS NULL
      AND settled_by IS NULL AND settled_at IS NOT NULL AND mailbox_message_id IS NULL)
  ),
  PRIMARY KEY(host_id,dispatch_id,execution_attempt_id,acp_session_id,action_id)
);

CREATE INDEX idx_remote_acp_events_attempt_cursor
  ON remote_acp_events(execution_attempt_id,cursor);
CREATE INDEX idx_remote_interactions_operation_status
  ON remote_interactions(operation_id,status,expires_at);
`;

const migration15 = `
CREATE UNIQUE INDEX idx_remote_attempt_dispatch_identity
  ON remote_execution_attempts(dispatch_id);
CREATE UNIQUE INDEX idx_remote_attempt_lease_identity
  ON remote_execution_attempts(lease_id)
  WHERE lease_id IS NOT NULL;
`;

const migration16 = `
CREATE TABLE human_principals (
  human_principal_id TEXT PRIMARY KEY CHECK(
    length(human_principal_id) BETWEEN 1 AND 128
    AND human_principal_id GLOB '[A-Za-z0-9]*'
    AND human_principal_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL
);

CREATE TABLE project_memberships (
  membership_id TEXT PRIMARY KEY CHECK(
    length(membership_id) BETWEEN 1 AND 128
    AND membership_id GLOB '[A-Za-z0-9]*'
    AND membership_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  project_id TEXT NOT NULL CHECK(
    length(project_id) BETWEEN 1 AND 128
    AND project_id GLOB '[A-Za-z0-9]*'
    AND project_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  human_principal_id TEXT NOT NULL REFERENCES human_principals(human_principal_id),
  role TEXT NOT NULL CHECK(role IN ('owner','member')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE UNIQUE INDEX idx_project_memberships_active_unique
  ON project_memberships(project_id, human_principal_id)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_project_memberships_project_active
  ON project_memberships(project_id, role)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_project_memberships_principal
  ON project_memberships(human_principal_id)
  WHERE revoked_at IS NULL;

CREATE TABLE project_invitations (
  invitation_id TEXT PRIMARY KEY CHECK(
    length(invitation_id) BETWEEN 1 AND 128
    AND invitation_id GLOB '[A-Za-z0-9]*'
    AND invitation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  project_id TEXT NOT NULL CHECK(
    length(project_id) BETWEEN 1 AND 128
    AND project_id GLOB '[A-Za-z0-9]*'
    AND project_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  role TEXT NOT NULL CHECK(role = 'member'),
  created_by_human_principal_id TEXT NOT NULL REFERENCES human_principals(human_principal_id),
  token_sha256 TEXT NOT NULL UNIQUE
    CHECK(length(token_sha256)=64 AND token_sha256 NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  consumed_at TEXT,
  consumed_by_human_principal_id TEXT REFERENCES human_principals(human_principal_id),
  CHECK(
    (consumed_at IS NULL AND consumed_by_human_principal_id IS NULL)
    OR (consumed_at IS NOT NULL AND consumed_by_human_principal_id IS NOT NULL)
  )
);

CREATE INDEX idx_project_invitations_project_open
  ON project_invitations(project_id, expires_at)
  WHERE revoked_at IS NULL AND consumed_at IS NULL;

CREATE TABLE human_device_credentials (
  device_credential_id TEXT PRIMARY KEY CHECK(
    length(device_credential_id) BETWEEN 1 AND 128
    AND device_credential_id GLOB '[A-Za-z0-9]*'
    AND device_credential_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  human_principal_id TEXT NOT NULL REFERENCES human_principals(human_principal_id),
  minted_for_project_id TEXT NOT NULL CHECK(
    length(minted_for_project_id) BETWEEN 1 AND 128
    AND minted_for_project_id GLOB '[A-Za-z0-9]*'
    AND minted_for_project_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  label TEXT CHECK(label IS NULL OR length(label) BETWEEN 1 AND 64),
  token_sha256 TEXT NOT NULL UNIQUE
    CHECK(length(token_sha256)=64 AND token_sha256 NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT
);

CREATE INDEX idx_human_devices_principal_active
  ON human_device_credentials(human_principal_id)
  WHERE revoked_at IS NULL;

CREATE INDEX idx_human_devices_project_minted_active
  ON human_device_credentials(minted_for_project_id, human_principal_id)
  WHERE revoked_at IS NULL;
`;

/**
 * Work assignment coordination store (HC-002#B-002).
 * Keyed by project + exact WorkItemRef (kind/canvas/key). Target is normalized columns only —
 * never task titles, prompts, Block lifecycle, Host presence, or capability copies.
 * Unassign keeps a durable row with target_kind='unassigned' (revision advances; no silent delete).
 */
const migration17 = `
CREATE TABLE work_assignments (
  project_id TEXT NOT NULL CHECK(
    length(project_id) BETWEEN 1 AND 128
    AND project_id GLOB '[A-Za-z0-9]*'
    AND project_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  canvas_id TEXT NOT NULL CHECK(
    length(canvas_id) BETWEEN 1 AND 128
    AND canvas_id GLOB '[A-Za-z0-9]*'
    AND canvas_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  work_item_kind TEXT NOT NULL CHECK(work_item_kind IN ('task','block')),
  work_item_key TEXT NOT NULL CHECK(length(work_item_key) BETWEEN 1 AND 256),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('unassigned','human','exact_host','automatic_host')),
  target_human_principal_id TEXT CHECK(
    target_human_principal_id IS NULL
    OR (
      length(target_human_principal_id) BETWEEN 1 AND 128
      AND target_human_principal_id GLOB '[A-Za-z0-9]*'
      AND target_human_principal_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  target_host_id TEXT CHECK(
    target_host_id IS NULL
    OR (
      length(target_host_id) BETWEEN 1 AND 128
      AND target_host_id GLOB '[A-Za-z0-9]*'
      AND target_host_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  updated_by_kind TEXT NOT NULL CHECK(updated_by_kind IN ('human','local_admin','system')),
  updated_by_id TEXT NOT NULL CHECK(
    length(updated_by_id) BETWEEN 1 AND 128
    AND updated_by_id GLOB '[A-Za-z0-9]*'
    AND updated_by_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  updated_by_display_name TEXT CHECK(
    updated_by_display_name IS NULL OR length(updated_by_display_name) BETWEEN 1 AND 128
  ),
  updated_at TEXT NOT NULL,
  reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 512),
  PRIMARY KEY (project_id, canvas_id, work_item_kind, work_item_key),
  CHECK(
    (target_kind = 'unassigned' AND target_human_principal_id IS NULL AND target_host_id IS NULL)
    OR (target_kind = 'human' AND target_human_principal_id IS NOT NULL AND target_host_id IS NULL)
    OR (target_kind = 'exact_host' AND target_host_id IS NOT NULL AND target_human_principal_id IS NULL)
    OR (target_kind = 'automatic_host' AND target_human_principal_id IS NULL AND target_host_id IS NULL)
  ),
  CHECK(
    (work_item_kind = 'task' AND target_kind IN ('unassigned','human'))
    OR work_item_kind = 'block'
  )
);

CREATE INDEX idx_work_assignments_project_canvas
  ON work_assignments(project_id, canvas_id, updated_at);

CREATE INDEX idx_work_assignments_project_target_human
  ON work_assignments(project_id, target_human_principal_id)
  WHERE target_kind = 'human';

CREATE INDEX idx_work_assignments_project_target_host
  ON work_assignments(project_id, target_host_id)
  WHERE target_kind = 'exact_host';
`;

function validateRemoteAttemptIdentities(database: SqliteDatabase): void {
  const duplicateDispatch = database
    .prepare(
      `SELECT dispatch_id FROM remote_execution_attempts
       GROUP BY dispatch_id HAVING COUNT(*)>1 LIMIT 1`
    )
    .get();
  if (duplicateDispatch) throw new Error("migration_duplicate_remote_attempt_dispatch_identity");
  const duplicateLease = database
    .prepare(
      `SELECT lease_id FROM remote_execution_attempts WHERE lease_id IS NOT NULL
       GROUP BY lease_id HAVING COUNT(*)>1 LIMIT 1`
    )
    .get();
  if (duplicateLease) throw new Error("migration_duplicate_remote_attempt_lease_identity");
}

function backfillMailboxPredecessors(database: SqliteDatabase): void {
  for (const row of database
    .prepare("SELECT sequence,host_id FROM mailbox_messages ORDER BY sequence ASC")
    .all()) {
    const prior = database
      .prepare(
        "SELECT MAX(sequence) AS sequence FROM mailbox_messages WHERE host_id=? AND sequence<?"
      )
      .get(row.host_id, row.sequence);
    database
      .prepare("UPDATE mailbox_messages SET previous_sequence=? WHERE sequence=?")
      .run(Number(prior?.sequence ?? 0), row.sequence);
  }
}

const migration8 = "SELECT 1;";

function tableExists(database: SqliteDatabase, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  );
}

function validateArtifactMediaTypes(database: SqliteDatabase): void {
  const table = tableExists(database, "artifact_blobs") ? "artifact_blobs" : "artifacts";
  for (const row of database.prepare(`SELECT ref,media_type FROM ${table}`).all()) {
    const parsed = artifactMediaTypeSchema.safeParse(row.media_type);
    if (!parsed.success) {
      throw new Error("migration_invalid_artifact_media_type");
    }
    if (parsed.data !== row.media_type) {
      database.prepare(`UPDATE ${table} SET media_type=? WHERE ref=?`).run(parsed.data, row.ref);
    }
  }
  if (!tableExists(database, "artifact_grants")) return;
  for (const row of database
    .prepare(
      "SELECT grant_id,expected_media_type FROM artifact_grants WHERE expected_media_type IS NOT NULL"
    )
    .all()) {
    const parsed = artifactMediaTypeSchema.safeParse(row.expected_media_type);
    if (!parsed.success) {
      throw new Error("migration_invalid_artifact_media_type");
    }
    if (parsed.data !== row.expected_media_type) {
      database
        .prepare("UPDATE artifact_grants SET expected_media_type=? WHERE grant_id=?")
        .run(parsed.data, row.grant_id);
    }
  }
}

function validateArtifactLinkGrantTuples(database: SqliteDatabase): void {
  const mismatch = database
    .prepare(
      `SELECT 1 FROM dispatch_artifact_links l
       LEFT JOIN artifact_grants g ON g.grant_id=l.grant_id
       LEFT JOIN dispatches d ON d.id=l.dispatch_id
       WHERE g.grant_id IS NULL OR d.id IS NULL
         OR g.project_id<>d.project_id OR g.host_id<>d.host_id
         OR l.dispatch_id<>g.dispatch_id OR l.lease_id<>g.lease_id
         OR l.execution_attempt_id<>g.execution_attempt_id OR l.artifact_ref<>g.artifact_ref
         OR (l.purpose='input' AND g.permission<>'input_read')
         OR (l.purpose='report' AND g.permission<>'report_write')
         OR (l.purpose='output' AND g.permission<>'output_write')
         OR (l.purpose IN ('report','output') AND l.produced_by_host_id<>g.host_id)
       LIMIT 1`
    )
    .get();
  if (mismatch) throw new Error("migration_artifact_link_grant_mismatch");
}

function validateAgentHostsForReservations(database: SqliteDatabase): void {
  for (const row of database
    .prepare("SELECT id,capabilities_json,capacity FROM agent_hosts")
    .all()) {
    try {
      if (typeof row.id !== "string" || row.id.length === 0) {
        throw new Error("invalid_host_id");
      }
      const capabilities = JSON.parse(String(row.capabilities_json));
      capabilitiesSchema.parse(capabilities);
      const capacity = Number(row.capacity);
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 128) {
        throw new Error("invalid_host_capacity");
      }
    } catch (error) {
      throw new Error("migration_invalid_agent_host_row", { cause: error });
    }
  }
}

type Migration = {
  version: number;
  sql: string;
  disableForeignKeys?: boolean;
  before?: (database: SqliteDatabase) => void;
  after?: (database: SqliteDatabase) => void;
};

const migrations: readonly Migration[] = [
  { version: 1, sql: migration1 },
  { version: 2, sql: migration2 },
  { version: 3, sql: migration3 },
  { version: 4, sql: migration4 },
  { version: 5, sql: migration5, disableForeignKeys: true },
  { version: 6, sql: migration6, after: validateArtifactMediaTypes },
  {
    version: 7,
    sql: migration7,
    before(database) {
      validateArtifactMediaTypes(database);
      validateArtifactLinkGrantTuples(database);
    }
  },
  { version: 8, sql: migration8, before: validateArtifactMediaTypes },
  { version: 9, sql: migration9 },
  { version: 10, sql: migration10, before: validateAgentHostsForReservations },
  { version: 11, sql: migration11 },
  { version: 12, sql: migration12, after: backfillMailboxPredecessors },
  { version: 13, sql: migration13, disableForeignKeys: true },
  { version: 14, sql: migration14 },
  { version: 15, sql: migration15, before: validateRemoteAttemptIdentities },
  { version: 16, sql: migration16 },
  { version: 17, sql: migration17 }
];

export const latestCentralSchemaVersion = Math.max(
  ...migrations.map((migration) => migration.version)
);

function assertSchemaCompatible(database: SqliteDatabase): void {
  const found = centralSchemaVersion(database);
  if (found > latestCentralSchemaVersion) {
    throw new Error(`server_schema_version_unsupported:${found}:${latestCentralSchemaVersion}`);
  }
}

export function applyMigrations(database: SqliteDatabase): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  assertSchemaCompatible(database);
  for (const migration of migrations) {
    const disableForeignKeys = migration.disableForeignKeys === true;
    if (disableForeignKeys) database.exec("PRAGMA foreign_keys = OFF");
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        assertSchemaCompatible(database);
        const alreadyApplied = database
          .prepare("SELECT 1 FROM schema_migrations WHERE version=?")
          .get(migration.version);
        if (!alreadyApplied) {
          migration.before?.(database);
          database.exec(migration.sql);
          migration.after?.(database);
          if (disableForeignKeys) {
            const violations = database.prepare("PRAGMA foreign_key_check").all();
            if (violations.length > 0) throw new Error("migration_foreign_key_violation");
          }
          database
            .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
            .run(migration.version, new Date().toISOString());
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      if (disableForeignKeys) database.exec("PRAGMA foreign_keys = ON");
    }
  }
  const found = Number(
    database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version ?? 0
  );
  if (found !== latestCentralSchemaVersion) {
    throw new Error(`server_schema_version_incomplete:${found}:${latestCentralSchemaVersion}`);
  }
}

export function centralSchemaVersion(database: SqliteDatabase): number {
  const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    | { version: number | null }
    | undefined;
  return Number(row?.version ?? 0);
}

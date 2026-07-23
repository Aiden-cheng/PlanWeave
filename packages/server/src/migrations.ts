import { artifactMediaTypeSchema } from "./artifactMediaType.js";
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

function tableExists(database: SqliteDatabase, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  );
}

function validateArtifactMediaTypes(database: SqliteDatabase): void {
  const table = tableExists(database, "artifact_blobs") ? "artifact_blobs" : "artifacts";
  for (const row of database.prepare(`SELECT media_type FROM ${table}`).all()) {
    if (!artifactMediaTypeSchema.safeParse(row.media_type).success) {
      throw new Error("migration_invalid_artifact_media_type");
    }
  }
  if (!tableExists(database, "artifact_grants")) return;
  for (const row of database
    .prepare(
      "SELECT expected_media_type FROM artifact_grants WHERE expected_media_type IS NOT NULL"
    )
    .all()) {
    if (!artifactMediaTypeSchema.safeParse(row.expected_media_type).success) {
      throw new Error("migration_invalid_artifact_media_type");
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
  }
];

export function applyMigrations(database: SqliteDatabase): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
  );
  const applied = new Set(
    database
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => Number(row.version))
  );
  for (const migration of migrations)
    if (!applied.has(migration.version)) {
      const disableForeignKeys =
        "disableForeignKeys" in migration && migration.disableForeignKeys === true;
      if (disableForeignKeys) database.exec("PRAGMA foreign_keys = OFF");
      try {
        database.exec("BEGIN IMMEDIATE");
        try {
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
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      } finally {
        if (disableForeignKeys) database.exec("PRAGMA foreign_keys = ON");
      }
    }
  const latest = Math.max(...migrations.map((migration) => migration.version));
  const found = Number(
    database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version ?? 0
  );
  if (found < latest)
    throw new Error(`Unsupported schema version ${found}; expected at least ${latest}.`);
}

export function centralSchemaVersion(database: SqliteDatabase): number {
  const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
    | { version: number | null }
    | undefined;
  return Number(row?.version ?? 0);
}

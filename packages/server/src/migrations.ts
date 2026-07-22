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

const migrations = [
  { version: 1, sql: migration1 },
  { version: 2, sql: migration2 },
  { version: 3, sql: migration3 }
] as const;

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
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec(migration.sql);
        database
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts.js";
import {
  applyMigrations,
  centralSchemaVersion,
  latestCentralSchemaVersion
} from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const directories: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function createV5Database(mediaType: string) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-artifact-migration-v7-"));
  directories.push(dataDirectory);
  const databasePath = join(dataDirectory, "server.sqlite");
  const database = await openServerDatabase(databasePath, 5000);
  databases.push(database);
  const digest = "d".repeat(64);
  database.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version,applied_at) VALUES
      (1,'2020-01-01T00:00:00.000Z'),(2,'2020-01-01T00:00:00.000Z'),
      (3,'2020-01-01T00:00:00.000Z'),(4,'2020-01-01T00:00:00.000Z'),
      (5,'2020-01-01T00:00:00.000Z');
    CREATE TABLE agent_hosts(
      id TEXT PRIMARY KEY,display_name TEXT NOT NULL,credential_hash TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,capacity INTEGER NOT NULL,last_seen_at TEXT,
      last_acknowledged_sequence INTEGER NOT NULL DEFAULT 0,revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE dispatches(
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL,block_ref TEXT NOT NULL,
      package_ref TEXT NOT NULL,host_id TEXT NOT NULL REFERENCES agent_hosts(id),
      required_capabilities_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'leased','running','interrupted','cancelling','awaiting_writeback','completed','failed','cancelled'
      )),
      lease_id TEXT NOT NULL UNIQUE,execution_attempt_id TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,created_at TEXT NOT NULL,accepted_at TEXT,finished_at TEXT,
      result_json TEXT,failure_json TEXT,interruption_reason TEXT,interruption_resumable INTEGER,
      interruption_recovery_json TEXT
    );
    CREATE INDEX idx_dispatches_host_status ON dispatches(host_id,status);
    CREATE INDEX idx_dispatches_writeback ON dispatches(status,created_at);
    CREATE TABLE mailbox_messages(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE,
      host_id TEXT NOT NULL REFERENCES agent_hosts(id),command_json TEXT NOT NULL,
      created_at TEXT NOT NULL,acknowledged_at TEXT
    );
    CREATE TABLE artifacts(
      ref TEXT PRIMARY KEY,sha256 TEXT NOT NULL UNIQUE,size_bytes INTEGER NOT NULL,
      media_type TEXT NOT NULL,relative_path TEXT NOT NULL UNIQUE,
      created_by_host_id TEXT,created_at TEXT NOT NULL
    );
    CREATE INDEX idx_artifacts_created_by_host ON artifacts(created_by_host_id,created_at);
  `);
  database
    .prepare(
      `INSERT INTO artifacts(
        ref,sha256,size_bytes,media_type,relative_path,created_by_host_id,created_at
      ) VALUES (?,?,?,?,?,NULL,?)`
    )
    .run(
      `artifact:sha256:${digest}`,
      digest,
      7,
      mediaType,
      `dd/${digest}`,
      "2020-01-01T00:00:00.000Z"
    );
  return { dataDirectory, database, digest };
}

describe("artifact migration v7", () => {
  it("preserves a valid quoted media parameter across upgrade and reopen", async () => {
    const legacyMediaType = 'Text/Plain ; Charset = "utf-8"';
    const mediaType = 'text/plain; charset="utf-8"';
    const { dataDirectory, database, digest } = await createV5Database(legacyMediaType);
    applyMigrations(database);
    expect(centralSchemaVersion(database)).toBe(latestCentralSchemaVersion);
    expect(
      new ArtifactStore(database, dataDirectory, 1024).get(`artifact:sha256:${digest}`)
    ).toMatchObject({ mediaType });
    database.close();
    databases.pop();

    const reopened = await openServerDatabase(join(dataDirectory, "server.sqlite"), 5000);
    databases.push(reopened);
    applyMigrations(reopened);
    expect(centralSchemaVersion(reopened)).toBe(latestCentralSchemaVersion);
    expect(
      new ArtifactStore(reopened, dataDirectory, 1024).get(`artifact:sha256:${digest}`)
    ).toMatchObject({ mediaType });
  });

  it("rolls an invalid legacy media type back before recording v6", async () => {
    const { database } = await createV5Database("../../secret");
    expect(() => applyMigrations(database)).toThrowError("migration_invalid_artifact_media_type");
    expect(centralSchemaVersion(database)).toBe(5);
    expect(
      database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifacts'").get()
    ).toBeDefined();
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifact_blobs'")
        .get()
    ).toBeUndefined();
  });

  it("canonicalizes blob and grant media types when upgrading an existing v7 database", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-artifact-existing-v7-"));
    directories.push(dataDirectory);
    const databasePath = join(dataDirectory, "server.sqlite");
    const database = await openServerDatabase(databasePath, 5000);
    databases.push(database);
    const digest = "f".repeat(64);
    const artifactRef = `artifact:sha256:${digest}`;
    const legacyMediaType = "Text/Plain ; Charset = utf-8";
    const canonicalMediaType = "text/plain; charset=utf-8";
    database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version,applied_at) VALUES
        (1,'2020-01-01T00:00:00.000Z'),(2,'2020-01-01T00:00:00.000Z'),
        (3,'2020-01-01T00:00:00.000Z'),(4,'2020-01-01T00:00:00.000Z'),
        (5,'2020-01-01T00:00:00.000Z'),(6,'2020-01-01T00:00:00.000Z'),
        (7,'2020-01-01T00:00:00.000Z');
      CREATE TABLE agent_hosts(
        id TEXT PRIMARY KEY,display_name TEXT NOT NULL,credential_hash TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,capacity INTEGER NOT NULL,last_seen_at TEXT,
        last_acknowledged_sequence INTEGER NOT NULL DEFAULT 0,revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO agent_hosts(
        id,display_name,credential_hash,capabilities_json,capacity,created_at
      ) VALUES ('host-v7','Host v7','credential-hash','["test"]',1,'2020-01-01T00:00:00.000Z');
      CREATE TABLE dispatches(
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL,block_ref TEXT NOT NULL,
        package_ref TEXT NOT NULL,host_id TEXT NOT NULL REFERENCES agent_hosts(id),
        required_capabilities_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'leased','running','interrupted','cancelling','awaiting_writeback','completed','failed','cancelled'
        )),
        lease_id TEXT NOT NULL UNIQUE,execution_attempt_id TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,created_at TEXT NOT NULL,accepted_at TEXT,finished_at TEXT,
        result_json TEXT,failure_json TEXT,interruption_reason TEXT,interruption_resumable INTEGER,
        interruption_recovery_json TEXT
      );
      CREATE INDEX idx_dispatches_host_status ON dispatches(host_id,status);
      CREATE INDEX idx_dispatches_writeback ON dispatches(status,created_at);
      CREATE TABLE mailbox_messages(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE,
        host_id TEXT NOT NULL REFERENCES agent_hosts(id),command_json TEXT NOT NULL,
        created_at TEXT NOT NULL,acknowledged_at TEXT
      );
      CREATE TABLE artifact_blobs(
        ref TEXT PRIMARY KEY,sha256 TEXT NOT NULL UNIQUE,size_bytes INTEGER NOT NULL,
        media_type TEXT NOT NULL,relative_path TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL
      );
      INSERT INTO artifact_blobs(
        ref,sha256,size_bytes,media_type,relative_path,created_at
      ) VALUES (
        '${artifactRef}','${digest}',7,'${legacyMediaType}','ff/${digest}',
        '2020-01-01T00:00:00.000Z'
      );
      CREATE TABLE artifact_grants(
        grant_id TEXT PRIMARY KEY,expected_media_type TEXT
      );
      INSERT INTO artifact_grants(grant_id,expected_media_type)
      VALUES ('grant-v7','${legacyMediaType}');
    `);

    applyMigrations(database);

    expect(centralSchemaVersion(database)).toBe(latestCentralSchemaVersion);
    expect(
      database.prepare("SELECT media_type FROM artifact_blobs WHERE ref=?").get(artifactRef)
        ?.media_type
    ).toBe(canonicalMediaType);
    expect(
      database
        .prepare("SELECT expected_media_type FROM artifact_grants WHERE grant_id='grant-v7'")
        .get()?.expected_media_type
    ).toBe(canonicalMediaType);

    database.close();
    databases.pop();
    const reopened = await openServerDatabase(databasePath, 5000);
    databases.push(reopened);
    applyMigrations(reopened);
    expect(centralSchemaVersion(reopened)).toBe(latestCentralSchemaVersion);
    expect(
      reopened.prepare("SELECT media_type FROM artifact_blobs WHERE ref=?").get(artifactRef)
        ?.media_type
    ).toBe(canonicalMediaType);
  });

  it("rejects a mismatched v6 link/grant tuple without rewriting history", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-artifact-mismatch-v6-"));
    directories.push(dataDirectory);
    const database = await openServerDatabase(join(dataDirectory, "server.sqlite"), 5000);
    databases.push(database);
    const digest = "e".repeat(64);
    const artifactRef = `artifact:sha256:${digest}`;
    database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version,applied_at) VALUES
        (1,'2020-01-01T00:00:00.000Z'),(2,'2020-01-01T00:00:00.000Z'),
        (3,'2020-01-01T00:00:00.000Z'),(4,'2020-01-01T00:00:00.000Z'),
        (5,'2020-01-01T00:00:00.000Z'),(6,'2020-01-01T00:00:00.000Z');
      CREATE TABLE agent_hosts(id TEXT PRIMARY KEY);
      INSERT INTO agent_hosts VALUES ('host-a');
      CREATE TABLE dispatches(
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL,host_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,execution_attempt_id TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_dispatches_artifact_scope
        ON dispatches(id,project_id,host_id,lease_id,execution_attempt_id);
      CREATE UNIQUE INDEX idx_dispatches_lease_scope
        ON dispatches(id,lease_id,execution_attempt_id);
      INSERT INTO dispatches VALUES ('dispatch-a','project-a','host-a','lease-a','attempt-a');
      CREATE TABLE artifact_blobs(ref TEXT PRIMARY KEY,media_type TEXT NOT NULL);
      INSERT INTO artifact_blobs VALUES ('${artifactRef}','text/plain');
      CREATE TABLE artifact_grants(
        grant_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,host_id TEXT NOT NULL,
        dispatch_id TEXT NOT NULL,lease_id TEXT NOT NULL,execution_attempt_id TEXT NOT NULL,
        permission TEXT NOT NULL,artifact_ref TEXT NOT NULL,expected_media_type TEXT
      );
      INSERT INTO artifact_grants VALUES(
        'grant-a','project-a','host-a','dispatch-a','lease-a','attempt-a',
        'report_write','${artifactRef}','text/plain'
      );
      CREATE TABLE dispatch_artifact_links(
        link_id INTEGER PRIMARY KEY AUTOINCREMENT,dispatch_id TEXT NOT NULL,lease_id TEXT NOT NULL,
        execution_attempt_id TEXT NOT NULL,artifact_ref TEXT NOT NULL,purpose TEXT NOT NULL,
        logical_name TEXT,grant_id TEXT NOT NULL UNIQUE,produced_by_host_id TEXT,linked_at TEXT NOT NULL
      );
      INSERT INTO dispatch_artifact_links(
        dispatch_id,lease_id,execution_attempt_id,artifact_ref,purpose,logical_name,
        grant_id,produced_by_host_id,linked_at
      ) VALUES(
        'dispatch-a','lease-a','attempt-a','${artifactRef}','output',NULL,
        'grant-a','host-a','2020-01-01T00:00:00.000Z'
      );
    `);

    expect(() => applyMigrations(database)).toThrowError("migration_artifact_link_grant_mismatch");
    expect(centralSchemaVersion(database)).toBe(6);
    expect(
      database.prepare("SELECT purpose FROM dispatch_artifact_links WHERE grant_id='grant-a'").get()
        ?.purpose
    ).toBe("output");
    expect(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_artifact_grants_link_scope'"
        )
        .get()
    ).toBeUndefined();
  });
});

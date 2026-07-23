import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { applyMigrations, centralSchemaVersion } from "../migrations.js";
import { RemoteOperationRepository } from "../remoteOperations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup(): Promise<PlanweaveServer> {
  const directory = await mkdtemp(join(tmpdir(), "planweave-remote-operation-"));
  directories.push(directory);
  const server = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  servers.push(server);
  return server;
}

const operationInput = {
  projectId: "project-a",
  canvasId: "default",
  blockRef: "RC-002#B-001",
  ownershipGeneration: "generation-1",
  idempotencyKey: "request-1",
  sourceFingerprint: "graph-fingerprint-1",
  requiredCapabilities: ["linux", "acp.codex"]
} as const;

describe("RemoteOperationRepository", () => {
  it("creates stable dispatch and attempt identities, replays identical input, and rejects conflict", async () => {
    const server = await setup();
    const repository = new RemoteOperationRepository(server.database);

    const created = repository.create(operationInput);
    expect(repository.create(operationInput)).toEqual(created);
    expect(created.dispatchId).toMatch(/^dispatch-/);
    expect(created.executionAttemptId).toMatch(/^attempt-/);
    expect(created.attempt.status).toBe("prepared");
    expect(repository.markClaimed(created.id).state).toBe("claimed");
    const digest = `envelope:sha256:${"a".repeat(64)}`;
    expect(repository.recordEnvelope({ operationId: created.id, digest }).envelopeDigest).toBe(
      digest
    );
    expect(repository.recordEnvelope({ operationId: created.id, digest }).dispatchId).toBe(
      created.dispatchId
    );
    expect(() =>
      repository.recordEnvelope({
        operationId: created.id,
        digest: `envelope:sha256:${"b".repeat(64)}`
      })
    ).toThrowError("remote_operation_envelope_conflict");
    expect(() =>
      repository.create({ ...operationInput, sourceFingerprint: "graph-fingerprint-2" })
    ).toThrowError("remote_operation_idempotency_conflict");
  });

  it("fails visibly when persisted enum or JSON data is corrupted", async () => {
    const server = await setup();
    const repository = new RemoteOperationRepository(server.database);
    const created = repository.create(operationInput);

    server.database
      .prepare("UPDATE remote_operations SET required_capabilities_json=? WHERE id=?")
      .run('["linux",', created.id);
    expect(() => repository.getRequired(created.id)).toThrowError("remote_operation_row_invalid");

    server.database.exec("PRAGMA ignore_check_constraints = ON");
    server.database
      .prepare("UPDATE remote_operations SET required_capabilities_json=?,state=? WHERE id=?")
      .run('["linux"]', "unknown", created.id);
    server.database.exec("PRAGMA ignore_check_constraints = OFF");
    expect(() => repository.getRequired(created.id)).toThrowError("remote_operation_row_invalid");
  });
});

describe("remote coordinator migration v9", () => {
  it("upgrades v8 in place and rejects corrupt Host capability data without recording v9", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-remote-migration-"));
    directories.push(directory);
    const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
    databases.push(database);
    database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations(version,applied_at) VALUES
        (1,'2020-01-01T00:00:00.000Z'),(2,'2020-01-01T00:00:00.000Z'),
        (3,'2020-01-01T00:00:00.000Z'),(4,'2020-01-01T00:00:00.000Z'),
        (5,'2020-01-01T00:00:00.000Z'),(6,'2020-01-01T00:00:00.000Z'),
        (7,'2020-01-01T00:00:00.000Z'),(8,'2020-01-01T00:00:00.000Z');
      CREATE TABLE agent_hosts(
        id TEXT PRIMARY KEY,display_name TEXT NOT NULL,credential_hash TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,capacity INTEGER NOT NULL,last_seen_at TEXT,
        last_acknowledged_sequence INTEGER NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL
      );
      INSERT INTO agent_hosts VALUES(
        'host-a','Host A','hash','["linux",',1,NULL,0,NULL,
        '2020-01-01T00:00:00.000Z'
      );
      CREATE TABLE mailbox_messages(
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL UNIQUE,
        host_id TEXT NOT NULL REFERENCES agent_hosts(id),command_json TEXT NOT NULL,
        created_at TEXT NOT NULL,acknowledged_at TEXT
      );
      CREATE TABLE artifact_blobs(ref TEXT PRIMARY KEY,media_type TEXT NOT NULL);
      CREATE TABLE artifact_grants(grant_id TEXT PRIMARY KEY,expected_media_type TEXT);
    `);

    expect(() => applyMigrations(database)).toThrowError("migration_invalid_agent_host_row");
    expect(centralSchemaVersion(database)).toBe(9);
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_operations'")
        .get()
    ).toBeUndefined();

    database
      .prepare("UPDATE agent_hosts SET capabilities_json=? WHERE id=?")
      .run('["linux"]', "host-a");
    applyMigrations(database);
    expect(centralSchemaVersion(database)).toBe(12);
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='remote_operations'")
        .get()
    ).toBeDefined();
  });
});

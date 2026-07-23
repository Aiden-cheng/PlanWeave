import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionEnvelopeSchema } from "@planweave-ai/distributed-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore, type ArtifactMetadata } from "../artifacts.js";
import { createDistributedCoordination } from "../distributedCoordination.js";
import type { DispatchRecord } from "../dispatches.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { openServerDatabase } from "../sqlite.js";
import { executionEnvelopeFor } from "./protocolTestFixtures.js";
import { createRemoteDispatchFixture } from "./support/remoteDispatchFixture.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-artifact-authorization-"));
  directories.push(dataDirectory);
  const server = await startPlanweaveServer({
    dataDirectory,
    databasePath: join(dataDirectory, "server.sqlite"),
    busyTimeoutMs: 5000
  });
  servers.push(server);
  const coordination = createDistributedCoordination(server.database, {
    leaseDurationMs: 60_000,
    hostOfflineAfterMs: 60_000,
    writeback: { complete: async () => {}, fail: async () => {} }
  });
  const registration = coordination.hosts.register("Artifact authorization host");
  coordination.hosts.reportOnline(registration.host.id, ["test"], 4);
  return {
    server,
    coordination,
    registration,
    artifacts: new ArtifactStore(server.database, dataDirectory, 1024 * 1024)
  };
}

async function putArtifact(
  artifacts: ArtifactStore,
  text: string,
  mediaType = "text/plain"
): Promise<ArtifactMetadata> {
  const bytes = Buffer.from(text);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return artifacts.put({
    expectedSha256: sha256,
    expectedSizeBytes: bytes.byteLength,
    mediaType,
    chunks: (async function* () {
      yield bytes;
    })()
  });
}

function scope(dispatch: DispatchRecord) {
  return {
    projectId: dispatch.projectId,
    hostId: dispatch.hostId,
    dispatchId: dispatch.id,
    leaseId: dispatch.leaseId,
    executionAttemptId: dispatch.executionAttemptId
  };
}

describe("dispatch artifact authorization repository", () => {
  it("commits immutable envelope and isolated input grants before mailbox publication", async () => {
    const { server, coordination, registration, artifacts } = await setup();
    const input = await putArtifact(artifacts, "shared immutable input");
    const base = executionEnvelopeFor("T-001#B-001", ["test"]);
    const envelope = executionEnvelopeSchema.parse({
      ...base,
      inputArtifacts: [{ artifactRef: input.ref, logicalName: "requirements.txt" }]
    });
    let grantCountAtPublication = 0;
    const unsubscribe = coordination.mailbox.subscribe(registration.host.id, () => {
      grantCountAtPublication = Number(
        server.database.prepare("SELECT COUNT(*) AS count FROM artifact_grants").get()?.count ?? 0
      );
    });
    const first = createRemoteDispatchFixture(server.database, coordination, envelope);
    unsubscribe();

    expect(grantCountAtPublication).toBe(1);
    expect(
      coordination.artifactAuthorization.authorizeInputRead({
        ...scope(first),
        artifactRef: input.ref
      })
    ).toMatchObject({ permission: "input_read", consumedAt: undefined });
    expect(
      server.database.prepare("SELECT COUNT(*) AS count FROM dispatch_execution_envelopes").get()
        ?.count
    ).toBe(1);

    const replay = createRemoteDispatchFixture(server.database, coordination, envelope);
    expect(replay).toEqual(first);
    expect(coordination.mailbox.listAfter(registration.host.id, 0)).toHaveLength(1);
    expect(
      server.database.prepare("SELECT COUNT(*) AS count FROM artifact_grants").get()?.count
    ).toBe(1);

    const conflicting = executionEnvelopeSchema.parse({
      ...envelope,
      renderedPrompt: `${envelope.renderedPrompt}\nconflicting replay`
    });
    expect(() =>
      createRemoteDispatchFixture(server.database, coordination, conflicting)
    ).toThrowError("remote_operation_envelope_conflict");

    const secondEnvelope = executionEnvelopeSchema.parse({
      ...executionEnvelopeFor("T-001#B-002", ["test"]),
      inputArtifacts: [{ artifactRef: input.ref, logicalName: "requirements.txt" }]
    });
    const second = createRemoteDispatchFixture(server.database, coordination, secondEnvelope);
    expect(
      server.database.prepare("SELECT COUNT(*) AS count FROM artifact_blobs").get()?.count
    ).toBe(1);
    expect(
      server.database.prepare("SELECT COUNT(*) AS count FROM artifact_grants").get()?.count
    ).toBe(2);
    expect(() =>
      coordination.artifactAuthorization.authorizeInputRead({
        ...scope(second),
        leaseId: first.leaseId,
        artifactRef: input.ref
      })
    ).toThrowError("artifact_input_grant_not_found");
  });

  it("binds output grants before upload and records one accepted provenance link", async () => {
    const { server, coordination, registration, artifacts } = await setup();
    const dispatch = createRemoteDispatchFixture(
      server.database,
      coordination,
      executionEnvelopeFor("T-001#B-003", ["test"])
    );
    coordination.dispatches.accept(
      registration.host.id,
      "accept-output",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    const bytes = Buffer.from("accepted report");
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    const grantInput = {
      ...scope(dispatch),
      operationId: "upload-report-1",
      permission: "report_write" as const,
      expectedSha256,
      expectedSizeBytes: bytes.byteLength,
      expectedMediaType: "text/markdown"
    };
    const grant = coordination.artifactAuthorization.createOutputGrant(grantInput);
    expect(coordination.artifactAuthorization.createOutputGrant(grantInput)).toEqual(grant);
    expect(() =>
      coordination.artifactAuthorization.createOutputGrant({
        ...grantInput,
        expectedSizeBytes: bytes.byteLength + 1
      })
    ).toThrowError("artifact_grant_identity_conflict");

    const artifact = await artifacts.put({
      expectedSha256,
      expectedSizeBytes: bytes.byteLength,
      mediaType: "text/markdown",
      chunks: (async function* () {
        yield bytes;
      })()
    });
    const accepted = coordination.artifactAuthorization.acceptOutputUpload(
      { ...scope(dispatch), grantId: grant.grantId },
      artifact
    );
    expect(
      coordination.artifactAuthorization.acceptOutputUpload(
        { ...scope(dispatch), grantId: grant.grantId },
        artifact
      )
    ).toEqual(accepted);
    expect(accepted).toMatchObject({
      artifactRef: artifact.ref,
      purpose: "report",
      producedByHostId: registration.host.id
    });
    expect(
      coordination.artifactAuthorization.requireAcceptedProvenance(
        scope(dispatch),
        artifact.ref,
        "report"
      )
    ).toEqual(accepted);

    expect(() =>
      server.database
        .prepare("UPDATE dispatch_artifact_links SET permission='output_write' WHERE grant_id=?")
        .run(grant.grantId)
    ).toThrowError();
    expect(() =>
      server.database
        .prepare(
          "UPDATE dispatch_artifact_links SET project_id='tampered-project' WHERE grant_id=?"
        )
        .run(grant.grantId)
    ).toThrowError();
    server.database.exec("PRAGMA foreign_keys = OFF");
    server.database
      .prepare("UPDATE dispatch_artifact_links SET project_id='tampered-project' WHERE grant_id=?")
      .run(grant.grantId);
    server.database.exec("PRAGMA foreign_keys = ON");
    expect(() =>
      coordination.artifactAuthorization.requireAcceptedProvenance(
        scope(dispatch),
        artifact.ref,
        "report"
      )
    ).toThrowError("artifact_provenance_not_found");

    const ungranted = await putArtifact(artifacts, "deduplicated but unauthorized");
    expect(() =>
      coordination.artifactAuthorization.requireAcceptedProvenance(scope(dispatch), ungranted.ref)
    ).toThrowError("artifact_provenance_not_found");
    expect(() =>
      coordination.artifactAuthorization.acceptOutputUpload(
        { ...scope(dispatch), grantId: grant.grantId },
        ungranted
      )
    ).toThrowError("artifact_upload_provenance_mismatch");
  });

  it("fails closed for revoked and expired grants and revoked accepted provenance", async () => {
    const { server, coordination, artifacts } = await setup();
    const input = await putArtifact(artifacts, "expiring input");
    const envelope = executionEnvelopeSchema.parse({
      ...executionEnvelopeFor("T-001#B-004", ["test"]),
      inputArtifacts: [{ artifactRef: input.ref, logicalName: "input.txt" }]
    });
    const dispatch = createRemoteDispatchFixture(server.database, coordination, envelope);
    const inputGrant = coordination.artifactAuthorization.authorizeInputRead({
      ...scope(dispatch),
      artifactRef: input.ref
    });
    coordination.artifactAuthorization.revokeGrant(inputGrant.grantId);
    expect(() =>
      coordination.artifactAuthorization.authorizeInputRead({
        ...scope(dispatch),
        artifactRef: input.ref
      })
    ).toThrowError("artifact_grant_revoked");

    server.database
      .prepare("UPDATE artifact_grants SET revoked_at=NULL,expires_at=? WHERE grant_id=?")
      .run("2020-01-01T00:00:00.000Z", inputGrant.grantId);
    expect(() =>
      coordination.artifactAuthorization.authorizeInputRead({
        ...scope(dispatch),
        artifactRef: input.ref
      })
    ).toThrowError("artifact_grant_expired");
  });
});

describe("artifact authorization migration", () => {
  it("upgrades a v5 database, preserves blobs without deriving grants, and reopens", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-artifact-migration-"));
    directories.push(dataDirectory);
    const databasePath = join(dataDirectory, "server.sqlite");
    const legacy = await openServerDatabase(databasePath, 5000);
    const digest = "d".repeat(64);
    legacy.exec(`
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
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL,host_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,execution_attempt_id TEXT NOT NULL
      );
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
      INSERT INTO artifacts VALUES(
        'artifact:sha256:${digest}','${digest}',7,'text/plain','dd/${digest}',
        'legacy-host','2020-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const upgraded = await startPlanweaveServer({
      dataDirectory,
      databasePath,
      busyTimeoutMs: 5000
    });
    servers.push(upgraded);
    expect(upgraded.readiness().schemaVersion).toBe(12);
    expect(
      upgraded.database.prepare("SELECT COUNT(*) AS count FROM artifact_blobs").get()?.count
    ).toBe(1);
    expect(
      upgraded.database.prepare("SELECT COUNT(*) AS count FROM artifact_grants").get()?.count
    ).toBe(0);
    expect(upgraded.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    upgraded.close();
    servers.pop();

    const reopened = await startPlanweaveServer({
      dataDirectory,
      databasePath,
      busyTimeoutMs: 5000
    });
    servers.push(reopened);
    expect(reopened.readiness().schemaVersion).toBe(12);
    expect(
      reopened.database.prepare("SELECT COUNT(*) AS count FROM artifact_blobs").get()?.count
    ).toBe(1);
    expect(
      reopened.database.prepare("SELECT COUNT(*) AS count FROM artifact_grants").get()?.count
    ).toBe(0);
  });
});

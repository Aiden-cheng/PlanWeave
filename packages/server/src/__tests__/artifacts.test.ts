import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type Server as HttpServer } from "node:http";
import { mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionEnvelopeSchema } from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { attachAgentHostArtifactHttp, type ArtifactHttpServer } from "../artifactHttp.js";
import { ArtifactStore } from "../artifacts.js";
import { createTestDispatchCoordination } from "./support/testDispatchCoordination.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { executionEnvelopeFor } from "./protocolTestFixtures.js";
import { createRemoteDispatchFixture } from "./support/remoteDispatchFixture.js";

const directories: string[] = [];
const databases: PlanweaveServer[] = [];
const httpServers: HttpServer[] = [];
const artifactServers: ArtifactHttpServer[] = [];

afterEach(async () => {
  for (const artifactServer of artifactServers.splice(0)) artifactServer.close();
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-artifacts-"));
  directories.push(dataDirectory);
  const server = await startPlanweaveServer({
    dataDirectory,
    databasePath: join(dataDirectory, "server.sqlite"),
    busyTimeoutMs: 5000
  });
  databases.push(server);
  return {
    dataDirectory,
    server,
    artifacts: new ArtifactStore(server.database, dataDirectory, 1024 * 1024)
  };
}

async function rawRequest(
  url: string,
  headers: Record<string, string>,
  body = Buffer.alloc(0)
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: "PUT", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() })
      );
    });
    request.on("error", reject);
    request.end(body);
  });
}

describe("content-addressed artifacts", () => {
  it("verifies the digest and size before publishing an artifact", async () => {
    const { dataDirectory, artifacts } = await setup();
    const bytes = Buffer.from("# Remote block report\n\nAll checks passed.\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const metadata = await artifacts.put({
      expectedSha256: sha256,
      expectedSizeBytes: bytes.byteLength,
      mediaType: "text/markdown; charset=utf-8",
      chunks: (async function* () {
        yield bytes.subarray(0, 10);
        yield bytes.subarray(10);
      })()
    });

    expect(metadata).toMatchObject({
      ref: `artifact:sha256:${sha256}`,
      sha256,
      sizeBytes: bytes.byteLength,
      mediaType: "text/markdown; charset=utf-8"
    });
    await expect(artifacts.read(metadata.ref)).resolves.toEqual(bytes);

    await expect(
      artifacts.put({
        expectedSha256: "0".repeat(64),
        expectedSizeBytes: bytes.byteLength,
        mediaType: "text/markdown",
        chunks: (async function* () {
          yield bytes;
        })()
      })
    ).rejects.toThrowError("artifact_digest_mismatch");

    await expect(
      artifacts.put({
        expectedSha256: sha256,
        expectedSizeBytes: bytes.byteLength - 1,
        mediaType: "text/markdown",
        chunks: (async function* () {
          yield bytes;
        })()
      })
    ).rejects.toThrowError("artifact_size_mismatch");
    expect(await readdir(join(dataDirectory, "artifacts", "tmp"))).toEqual([]);
  });

  it("uploads and downloads artifacts over authenticated HTTP", async () => {
    const { dataDirectory, server, artifacts } = await setup();
    const coordination = createTestDispatchCoordination(server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete: async () => {}, fail: async () => {} }
    });
    const registration = coordination.hosts.register("Artifact Host");
    coordination.hosts.reportOnline(registration.host.id, ["test"], 2);
    const inputBytes = Buffer.from("dispatch input");
    const inputSha256 = createHash("sha256").update(inputBytes).digest("hex");
    const input = await artifacts.put({
      expectedSha256: inputSha256,
      expectedSizeBytes: inputBytes.byteLength,
      mediaType: "text/plain",
      chunks: (async function* () {
        yield inputBytes;
      })()
    });
    const envelope = executionEnvelopeSchema.parse({
      ...executionEnvelopeFor("T-001#B-020", ["test"]),
      inputArtifacts: [
        { artifactRef: input.ref, logicalName: "input.txt", mediaType: "Text/Plain" }
      ]
    });
    expect(envelope.inputArtifacts[0]?.mediaType).toBe("text/plain");
    const dispatch = createRemoteDispatchFixture(server.database, coordination, envelope);
    coordination.dispatches.accept(
      registration.host.id,
      "accept-http",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    const httpServer = createServer();
    httpServers.push(httpServer);
    artifactServers.push(
      attachAgentHostArtifactHttp(httpServer, {
        hosts: coordination.hosts,
        dispatches: coordination.dispatches,
        authorization: coordination.artifactAuthorization,
        artifacts,
        allowInsecureTransport: true
      })
    );
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected an HTTP port.");
    const bytes = Buffer.from("remote report");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const base =
      `http://127.0.0.1:${address.port}/agent-hosts/${registration.host.id}` +
      `/dispatches/${dispatch.id}/leases/${dispatch.leaseId}` +
      `/attempts/${dispatch.executionAttemptId}/artifacts`;
    const url = `${base}/${sha256}`;

    const unauthorized = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: "Bearer invalid-token",
        "content-type": "Text/Markdown ; Charset=UTF-8",
        "x-planweave-artifact-operation-id": "http-report-1",
        "x-planweave-artifact-purpose": "report"
      },
      body: bytes
    });
    expect(unauthorized.status).toBe(401);

    const uploaded = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${registration.token}`,
        "content-type": "Text/Markdown ; Charset=UTF-8",
        "x-planweave-artifact-operation-id": "http-report-1",
        "x-planweave-artifact-purpose": "report"
      },
      body: bytes
    });
    expect(uploaded.status).toBe(201);
    await expect(uploaded.json()).resolves.toMatchObject({
      ref: `artifact:sha256:${sha256}`,
      sizeBytes: bytes.byteLength,
      mediaType: "text/markdown; charset=UTF-8"
    });

    const retry = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${registration.token}`,
        "content-type": "text/markdown; charset=UTF-8",
        "x-planweave-artifact-operation-id": "http-report-1",
        "x-planweave-artifact-purpose": "report"
      },
      body: bytes
    });
    expect(retry.status).toBe(201);

    const duplicateOperation = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${registration.token}`,
        "content-type": "text/markdown; charset=UTF-8",
        "x-planweave-artifact-operation-id": "http-report-duplicate-operation",
        "x-planweave-artifact-purpose": "report"
      },
      body: bytes
    });
    expect(duplicateOperation.status).toBe(500);
    expect(await duplicateOperation.json()).toEqual({ error: "artifact_request_failed" });

    const downloaded = await fetch(`${base}/${inputSha256}`, {
      headers: { Authorization: `Bearer ${registration.token}` }
    });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("etag")).toBe(`"sha256:${inputSha256}"`);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(inputBytes);

    const inputPath = join(
      dataDirectory,
      "artifacts",
      "sha256",
      inputSha256.slice(0, 2),
      inputSha256
    );
    await unlink(inputPath);
    const missingFile = await fetch(`${base}/${inputSha256}`, {
      headers: { Authorization: `Bearer ${registration.token}` }
    });
    expect(missingFile.status).toBe(500);
    expect(await missingFile.json()).toEqual({ error: "artifact_request_failed" });

    const outputRead = await fetch(url, {
      headers: { Authorization: `Bearer ${registration.token}` }
    });
    expect(outputRead.status).toBe(403);
    const inputGrant = coordination.artifactAuthorization.authorizeInputRead({
      workspaceId: dispatch.workspaceId,
      projectId: dispatch.projectId,
      hostId: dispatch.hostId,
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      artifactRef: input.ref
    });
    const inputWrite = await fetch(`${base}/${inputSha256}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${registration.token}`,
        "content-type": "text/plain",
        "x-planweave-artifact-operation-id": inputGrant.grantId,
        "x-planweave-artifact-purpose": "output"
      },
      body: inputBytes
    });
    expect(inputWrite.status).toBe(403);
  });

  it("rejects foreign scopes, invalid upload contracts, expired grants, and malformed routes", async () => {
    const { server, artifacts } = await setup();
    const coordination = createTestDispatchCoordination(server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete: async () => {}, fail: async () => {} }
    });
    const owner = coordination.hosts.register("Owner Host");
    const foreign = coordination.hosts.register("Foreign Host");
    coordination.hosts.reportOnline(owner.host.id, ["owner"], 1);
    coordination.hosts.reportOnline(foreign.host.id, ["foreign"], 1);
    const dispatch = createRemoteDispatchFixture(
      server.database,
      coordination,
      executionEnvelopeFor("T-001#B-021", ["owner"])
    );
    const httpServer = createServer();
    httpServers.push(httpServer);
    artifactServers.push(
      attachAgentHostArtifactHttp(httpServer, {
        hosts: coordination.hosts,
        dispatches: coordination.dispatches,
        authorization: coordination.artifactAuthorization,
        artifacts,
        allowInsecureTransport: true
      })
    );
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected an HTTP port.");
    const bytes = Buffer.from("negative request");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = (hostId: string, dispatchId: string, leaseId: string, digest = sha256) =>
      `http://127.0.0.1:${address.port}/agent-hosts/${hostId}` +
      `/dispatches/${dispatchId}/leases/${leaseId}` +
      `/attempts/${dispatch.executionAttemptId}/artifacts/${digest}`;
    const headers = (token: string, operationId: string, purpose = "report") => ({
      Authorization: `Bearer ${token}`,
      "content-type": "text/plain",
      "content-length": String(bytes.byteLength),
      "x-planweave-artifact-operation-id": operationId,
      "x-planweave-artifact-purpose": purpose
    });

    const foreignScope = await rawRequest(
      path(foreign.host.id, dispatch.id, dispatch.leaseId),
      headers(foreign.token, "foreign-host"),
      bytes
    );
    const missingScope = await rawRequest(
      path(owner.host.id, "missing-dispatch", dispatch.leaseId),
      headers(owner.token, "wrong-dispatch"),
      bytes
    );
    expect(foreignScope).toEqual({ status: 401, body: '{"error":"Unauthorized"}' });
    expect(missingScope).toEqual({
      status: 403,
      body: '{"error":"artifact_scope_forbidden"}'
    });
    expect(
      (
        await rawRequest(
          path(owner.host.id, dispatch.id, "stale-lease"),
          headers(owner.token, "stale-lease"),
          bytes
        )
      ).status
    ).toBe(403);

    coordination.artifactAuthorization.createOutputGrant({
      ...{
        workspaceId: dispatch.workspaceId,
        projectId: dispatch.projectId,
        hostId: dispatch.hostId,
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId
      },
      operationId: "expired-upload",
      permission: "report_write",
      expectedSha256: sha256,
      expectedSizeBytes: bytes.byteLength,
      expectedMediaType: "text/plain"
    });
    server.database
      .prepare("UPDATE artifact_grants SET expires_at=? WHERE grant_id=?")
      .run("2020-01-01T00:00:00.000Z", "expired-upload");
    expect(
      (
        await rawRequest(
          path(owner.host.id, dispatch.id, dispatch.leaseId),
          headers(owner.token, "expired-upload"),
          bytes
        )
      ).status
    ).toBe(403);

    const revokedGrant = coordination.artifactAuthorization.createOutputGrant({
      workspaceId: dispatch.workspaceId,
      projectId: dispatch.projectId,
      hostId: dispatch.hostId,
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      operationId: "revoked-upload",
      permission: "report_write",
      expectedSha256: sha256,
      expectedSizeBytes: bytes.byteLength,
      expectedMediaType: "text/plain"
    });
    coordination.artifactAuthorization.revokeGrant(revokedGrant.grantId);
    expect(
      (
        await rawRequest(
          path(owner.host.id, dispatch.id, dispatch.leaseId),
          headers(owner.token, "revoked-upload"),
          bytes
        )
      ).status
    ).toBe(403);

    const wrongDigest = await rawRequest(
      path(owner.host.id, dispatch.id, dispatch.leaseId, "0".repeat(64)),
      headers(owner.token, "wrong-digest"),
      bytes
    );
    expect(wrongDigest.status).toBe(400);
    expect(JSON.parse(wrongDigest.body)).toEqual({ error: "artifact_integrity_mismatch" });

    expect(
      (
        await rawRequest(
          path(owner.host.id, dispatch.id, dispatch.leaseId),
          {
            ...headers(owner.token, "oversized"),
            "content-length": String(artifacts.maxArtifactBytes + 1)
          },
          Buffer.alloc(artifacts.maxArtifactBytes + 1)
        )
      ).status
    ).toBe(413);
    const missingMedia = headers(owner.token, "missing-media");
    delete (missingMedia as Partial<typeof missingMedia>)["content-type"];
    expect(
      (await rawRequest(path(owner.host.id, dispatch.id, dispatch.leaseId), missingMedia, bytes))
        .status
    ).toBe(400);

    const malformed = await fetch(
      `http://127.0.0.1:${address.port}/agent-hosts/${owner.host.id}/dispatches/malformed`,
      { headers: { Authorization: `Bearer ${owner.token}` } }
    );
    expect(malformed.status).toBe(404);
    coordination.hosts.revoke(owner.host.id);
    expect(
      (
        await rawRequest(
          path(owner.host.id, dispatch.id, dispatch.leaseId),
          headers(owner.token, "revoked-token"),
          bytes
        )
      ).status
    ).toBe(401);
  });
});

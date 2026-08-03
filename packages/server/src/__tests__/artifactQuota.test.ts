import { createHash } from "node:crypto";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";
import { createServer, type Server as HttpServer } from "node:http";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachAgentHostArtifactHttp, type ArtifactHttpServer } from "../artifactHttp.js";
import { ArtifactStore } from "../artifacts.js";
import { createTestDispatchCoordination } from "./support/testDispatchCoordination.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { executionEnvelopeFor } from "./protocolTestFixtures.js";
import { createRemoteDispatchFixture } from "./support/remoteDispatchFixture.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];
const httpServers: HttpServer[] = [];
const artifactServers: ArtifactHttpServer[] = [];

afterEach(async () => {
  for (const artifactServer of artifactServers.splice(0)) artifactServer.close();
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("artifact output quotas", () => {
  it("counts accepted provenance separately from bounded pending operations", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-artifact-quota-"));
    directories.push(dataDirectory);
    const server = await startPlanweaveServer({
      dataDirectory,
      databasePath: join(dataDirectory, "server.sqlite"),
      busyTimeoutMs: 5000
    });
    servers.push(server);
    const coordination = createTestDispatchCoordination(server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete: async () => {}, fail: async () => {} }
    });
    const host = coordination.hosts.register("Quota Host");
    coordination.hosts.reportOnline(host.host.id, ["quota"], 1);
    const dispatch = createRemoteDispatchFixture(
      server.database,
      coordination,
      executionEnvelopeFor("T-001#B-050", ["quota"], "project-quota")
    );
    coordination.dispatches.accept(
      dispatch.hostId,
      "accept-quota-test",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    const artifacts = new ArtifactStore(server.database, dataDirectory, 1024);
    const httpServer = createServer();
    httpServers.push(httpServer);
    artifactServers.push(
      attachAgentHostArtifactHttp(httpServer, {
        hosts: coordination.hosts,
        dispatches: coordination.dispatches,
        authorization: coordination.artifactAuthorization,
        artifacts,
        transportAdmission: loopbackHttpTransportAdmission
      })
    );
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected HTTP address");

    const bytes = Buffer.from("report after repeated aborted uploads");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const pathname =
      `/agent-hosts/${host.host.id}/dispatches/${dispatch.id}/leases/${dispatch.leaseId}` +
      `/attempts/${dispatch.executionAttemptId}/artifacts/${sha256}`;
    for (let index = 0; index < 16; index++) {
      const operationId = `aborted-quota-${index}`;
      const socket = connect(address.port, "127.0.0.1");
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      socket.write(
        `PUT ${pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
          `Authorization: Bearer ${host.token}\r\nContent-Type: text/plain\r\n` +
          `Content-Length: ${bytes.byteLength}\r\n` +
          `x-planweave-artifact-operation-id: ${operationId}\r\n` +
          "x-planweave-artifact-purpose: report\r\nConnection: close\r\n\r\n"
      );
      socket.write(bytes.subarray(0, 1));
      for (
        let turn = 0;
        turn < 100 && !coordination.artifactAuthorization.getGrant(operationId);
        turn++
      ) {
        await nextTurn();
      }
      socket.destroy();
      await nextTurn();
      expect(
        coordination.artifactAuthorization.getGrantRequired(operationId).consumedAt
      ).toBeUndefined();
    }

    const origin = `http://127.0.0.1:${address.port}`;
    const accepted = await fetch(`${origin}${pathname}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${host.token}`,
        "content-type": "text/plain",
        "x-planweave-artifact-operation-id": "accepted-after-aborts",
        "x-planweave-artifact-purpose": "report"
      },
      body: bytes
    });
    expect(accepted.status).toBe(201);
    expect(
      server.database
        .prepare(
          "SELECT COUNT(*) AS count FROM dispatch_artifact_links WHERE purpose IN ('report','output')"
        )
        .get()?.count
    ).toBe(1);

    const grantInput = (operationId: string, digest = sha256, sizeBytes = bytes.byteLength) => ({
      workspaceId: dispatch.workspaceId,
      projectId: dispatch.projectId,
      hostId: dispatch.hostId,
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      operationId,
      permission: "output_write" as const,
      expectedSha256: digest,
      expectedSizeBytes: sizeBytes,
      expectedMediaType: "text/plain"
    });
    for (let index = 1; index < 16; index++) {
      const outputBytes = Buffer.from(`accepted output ${index}`);
      const outputDigest = createHash("sha256").update(outputBytes).digest("hex");
      const grant = coordination.artifactAuthorization.createOutputGrant(
        grantInput(`accepted-output-${index}`, outputDigest, outputBytes.byteLength)
      );
      const artifact = await artifacts.put({
        expectedSha256: outputDigest,
        expectedSizeBytes: outputBytes.byteLength,
        mediaType: "text/plain",
        chunks: (async function* () {
          yield outputBytes;
        })()
      });
      coordination.artifactAuthorization.acceptOutputUpload(
        {
          workspaceId: dispatch.workspaceId,
          projectId: dispatch.projectId,
          hostId: dispatch.hostId,
          dispatchId: dispatch.id,
          leaseId: dispatch.leaseId,
          executionAttemptId: dispatch.executionAttemptId,
          grantId: grant.grantId
        },
        artifact
      );
    }
    const overflowBytes = Buffer.from("output beyond accepted contract");
    const overflowDigest = createHash("sha256").update(overflowBytes).digest("hex");
    const overflowGrant = coordination.artifactAuthorization.createOutputGrant(
      grantInput("accepted-output-overflow", overflowDigest, overflowBytes.byteLength)
    );
    const overflowArtifact = await artifacts.put({
      expectedSha256: overflowDigest,
      expectedSizeBytes: overflowBytes.byteLength,
      mediaType: "text/plain",
      chunks: (async function* () {
        yield overflowBytes;
      })()
    });
    expect(() =>
      coordination.artifactAuthorization.acceptOutputUpload(
        {
          workspaceId: dispatch.workspaceId,
          projectId: dispatch.projectId,
          hostId: dispatch.hostId,
          dispatchId: dispatch.id,
          leaseId: dispatch.leaseId,
          executionAttemptId: dispatch.executionAttemptId,
          grantId: overflowGrant.grantId
        },
        overflowArtifact
      )
    ).toThrowError("artifact_grant_count_exceeds_output_contract");
    expect(
      coordination.artifactAuthorization.getGrantRequired(overflowGrant.grantId).consumedAt
    ).toBeUndefined();
    expect(
      server.database
        .prepare(
          "SELECT COUNT(*) AS count FROM dispatch_artifact_links WHERE purpose IN ('report','output')"
        )
        .get()?.count
    ).toBe(16);

    for (let index = 16; index < 63; index++) {
      coordination.artifactAuthorization.createOutputGrant(grantInput(`pending-quota-${index}`));
    }
    expect(() =>
      coordination.artifactAuthorization.createOutputGrant(grantInput("pending-over-limit"))
    ).toThrowError("artifact_pending_operation_limit_exceeded");
    expect(
      coordination.artifactAuthorization.createOutputGrant(grantInput("pending-quota-62"))
    ).toMatchObject({ grantId: "pending-quota-62" });
    coordination.artifactAuthorization.revokeGrant("aborted-quota-0");
    expect(
      coordination.artifactAuthorization.createOutputGrant(grantInput("pending-after-revoke"))
    ).toMatchObject({ grantId: "pending-after-revoke" });
  });
});

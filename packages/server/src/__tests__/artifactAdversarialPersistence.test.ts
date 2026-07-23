import { createHash } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionEnvelopeSchema } from "@planweave-ai/distributed-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachAgentHostArtifactHttp, type ArtifactHttpServer } from "../artifactHttp.js";
import { ArtifactStore } from "../artifacts.js";
import { createDistributedCoordination } from "../distributedCoordination.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { executionEnvelopeFor } from "./protocolTestFixtures.js";

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

describe("artifact persistence failure boundary", () => {
  it("rolls back acceptance and prevents the orphaned blob from completing a dispatch", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-artifact-persistence-"));
    directories.push(dataDirectory);
    const server = await startPlanweaveServer({
      dataDirectory,
      databasePath: join(dataDirectory, "server.sqlite"),
      busyTimeoutMs: 5000
    });
    servers.push(server);
    const complete = vi.fn(async () => {});
    const coordination = createDistributedCoordination(server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete, fail: async () => {} }
    });
    const host = coordination.hosts.register("Persistence Failure Host");
    coordination.hosts.reportOnline(host.host.id, ["project-persistence"], 1);
    const artifacts = new ArtifactStore(server.database, dataDirectory, 1024);
    const dispatch = coordination.dispatches.dispatchBlock({
      packageRef: "package://project-persistence/v1",
      envelope: executionEnvelopeSchema.parse(
        executionEnvelopeFor("T-001#B-040", ["project-persistence"], "project-persistence")
      )
    });
    coordination.dispatches.accept(
      dispatch.hostId,
      "accept-persistence-test",
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
    if (!address || typeof address === "string") throw new Error("Expected HTTP address");

    const operationId = "forced-persistence-failure";
    server.database.exec(`
      CREATE TRIGGER fail_forced_provenance
      BEFORE INSERT ON dispatch_artifact_links
      WHEN NEW.grant_id = '${operationId}'
      BEGIN
        SELECT RAISE(ABORT, 'forced_provenance_failure');
      END
    `);
    const bytes = Buffer.from("blob stored before provenance transaction fails");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const url =
      `http://127.0.0.1:${address.port}/agent-hosts/${host.host.id}` +
      `/dispatches/${dispatch.id}/leases/${dispatch.leaseId}` +
      `/attempts/${dispatch.executionAttemptId}/artifacts/${sha256}`;
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${host.token}`,
        "content-type": "text/plain",
        "x-planweave-artifact-operation-id": operationId,
        "x-planweave-artifact-purpose": "report"
      },
      body: bytes
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "artifact_request_failed" });

    const grant = coordination.artifactAuthorization.getGrantRequired(operationId);
    expect(grant.consumedAt).toBeUndefined();
    expect(
      server.database
        .prepare("SELECT COUNT(*) AS count FROM dispatch_artifact_links WHERE grant_id=?")
        .get(operationId)?.count
    ).toBe(0);
    const artifactRef = `artifact:sha256:${sha256}`;
    expect(artifacts.get(artifactRef)).toMatchObject({ ref: artifactRef });

    await expect(
      coordination.dispatches.complete(
        dispatch.hostId,
        "complete-after-persistence-failure",
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId,
        { summary: "must be rejected", reportArtifactRef: artifactRef, artifactRefs: [] }
      )
    ).rejects.toThrowError("artifact_provenance_not_found");
    expect(coordination.dispatches.getRequired(dispatch.id).status).toBe("running");
    expect(complete).not.toHaveBeenCalled();
  });
});

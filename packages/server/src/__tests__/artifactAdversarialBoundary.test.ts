import { createHash } from "node:crypto";
import { loopbackHttpTransportAdmission } from "./support/transportAdmission.js";
import { createServer, request as httpRequest, type Server as HttpServer } from "node:http";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionEnvelopeSchema } from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachAgentHostArtifactHttp, type ArtifactHttpServer } from "../artifactHttp.js";
import { ArtifactStore, type ArtifactMetadata } from "../artifacts.js";
import { createTestDispatchCoordination } from "./support/testDispatchCoordination.js";
import type { DispatchRecord } from "../dispatches.js";
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

async function put(artifacts: ArtifactStore, bytes: Buffer, mediaType = "text/plain") {
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

async function setup() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-artifact-adversarial-"));
  directories.push(dataDirectory);
  const server = await startPlanweaveServer({
    dataDirectory,
    databasePath: join(dataDirectory, "server.sqlite"),
    busyTimeoutMs: 5000
  });
  servers.push(server);
  const complete = vi.fn(async () => {});
  const coordination = createTestDispatchCoordination(server.database, {
    leaseDurationMs: 60_000,
    hostOfflineAfterMs: 60_000,
    writeback: { complete, fail: async () => {} }
  });
  const hostA = coordination.hosts.register("Project A Host");
  const hostB = coordination.hosts.register("Project B Host");
  coordination.hosts.reportOnline(hostA.host.id, ["project-a"], 3);
  coordination.hosts.reportOnline(hostB.host.id, ["project-b"], 2);
  const artifacts = new ArtifactStore(server.database, dataDirectory, 1024);
  const inputA = await put(artifacts, Buffer.from("project A input"));
  const inputA2 = await put(artifacts, Buffer.from("project A second dispatch input"));
  const inputB = await put(artifacts, Buffer.from("project B input"));

  const dispatch = (ref: string, projectId: string, capability: string, input: ArtifactMetadata) =>
    createRemoteDispatchFixture(
      server.database,
      coordination,
      executionEnvelopeSchema.parse({
        ...executionEnvelopeFor(ref, [capability], projectId),
        inputArtifacts: [{ artifactRef: input.ref, logicalName: "input.txt" }]
      })
    );
  const dispatchA = dispatch("T-001#B-030", "project-a", "project-a", inputA);
  const dispatchA2 = dispatch("T-001#B-031", "project-a", "project-a", inputA2);
  const dispatchB = dispatch("T-001#B-032", "project-b", "project-b", inputB);
  for (const [index, current] of [dispatchA, dispatchA2, dispatchB].entries()) {
    coordination.dispatches.accept(
      current.hostId,
      `accept-adversarial-${index}`,
      current.id,
      current.leaseId,
      current.executionAttemptId
    );
  }

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
  const origin = `http://127.0.0.1:${address.port}`;
  const url = (
    hostId: string,
    current: DispatchRecord,
    sha256: string,
    leaseId = current.leaseId,
    attemptId = current.executionAttemptId
  ) =>
    `${origin}/agent-hosts/${hostId}/dispatches/${current.id}/leases/${leaseId}` +
    `/attempts/${attemptId}/artifacts/${sha256}`;
  return {
    server,
    complete,
    coordination,
    artifacts,
    hostA,
    hostB,
    inputA,
    inputA2,
    inputB,
    dispatchA,
    dispatchA2,
    dispatchB,
    origin,
    url
  };
}

function uploadHeaders(token: string, operationId: string, purpose = "report") {
  return {
    Authorization: `Bearer ${token}`,
    "content-type": "text/plain",
    "x-planweave-artifact-operation-id": operationId,
    "x-planweave-artifact-purpose": purpose
  };
}

async function upload(url: string, token: string, operationId: string, bytes: Buffer) {
  return fetch(url, {
    method: "PUT",
    headers: uploadHeaders(token, operationId),
    body: bytes
  });
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("adversarial artifact HTTP boundary", () => {
  it("denies crossed identities without leaking foreign metadata", async () => {
    const fixture = await setup();
    const digest = (artifact: ArtifactMetadata) => artifact.sha256;
    const denial = { status: 403, body: '{"error":"artifact_scope_forbidden"}' };
    const get = async (url: string, token: string) => {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      return { status: response.status, body: await response.text() };
    };
    const cases = [
      [
        "cross-project blob",
        fixture.url(fixture.hostA.host.id, fixture.dispatchA, digest(fixture.inputB)),
        fixture.hostA.token
      ],
      [
        "cross-dispatch blob",
        fixture.url(fixture.hostA.host.id, fixture.dispatchA, digest(fixture.inputA2)),
        fixture.hostA.token
      ],
      [
        "cross-host dispatch",
        fixture.url(fixture.hostB.host.id, fixture.dispatchA, digest(fixture.inputA)),
        fixture.hostB.token
      ],
      [
        "old lease",
        fixture.url(fixture.hostA.host.id, fixture.dispatchA, digest(fixture.inputA), "old-lease"),
        fixture.hostA.token
      ],
      [
        "foreign attempt",
        fixture.url(
          fixture.hostA.host.id,
          fixture.dispatchA,
          digest(fixture.inputA),
          fixture.dispatchA.leaseId,
          fixture.dispatchA2.executionAttemptId
        ),
        fixture.hostA.token
      ]
    ] as const;
    for (const [_name, url, token] of cases) expect(await get(url, token)).toEqual(denial);

    const fabricated = await put(fixture.artifacts, Buffer.from("existing but ungranted"));
    const fabricatedResponse = await get(
      fixture.url(fixture.hostA.host.id, fixture.dispatchA, fabricated.sha256),
      fixture.hostA.token
    );
    expect(fabricatedResponse).toEqual(denial);
    expect(fabricatedResponse.body).not.toContain(
      JSON.stringify({ sizeBytes: fabricated.sizeBytes, mediaType: fabricated.mediaType })
    );

    const pathShaped = await fetch(
      `${fixture.origin}/agent-hosts/${fixture.hostA.host.id}/dispatches/${fixture.dispatchA.id}` +
        `/leases/${fixture.dispatchA.leaseId}/attempts/${fixture.dispatchA.executionAttemptId}` +
        "/artifacts/%2e%2e%2fsecret",
      { headers: { Authorization: `Bearer ${fixture.hostA.token}` } }
    );
    expect(pathShaped.status).toBe(404);
  });

  it("denies write replay conflicts, permission abuse, limits, and revoked principals", async () => {
    const fixture = await setup();
    const report = Buffer.from("legitimate report");
    const reportSha = createHash("sha256").update(report).digest("hex");
    const reportUrl = fixture.url(fixture.hostA.host.id, fixture.dispatchA, reportSha);
    expect((await upload(reportUrl, fixture.hostA.token, "committed-upload", report)).status).toBe(
      201
    );
    expect((await upload(reportUrl, fixture.hostA.token, "committed-upload", report)).status).toBe(
      201
    );
    expect(
      fixture.server.database
        .prepare("SELECT COUNT(*) AS count FROM artifact_blobs WHERE ref=?")
        .get(`artifact:sha256:${reportSha}`)?.count
    ).toBe(1);
    expect(
      fixture.server.database
        .prepare("SELECT COUNT(*) AS count FROM dispatch_artifact_links WHERE grant_id=?")
        .get("committed-upload")?.count
    ).toBe(1);
    expect(
      (
        await fetch(reportUrl, {
          method: "PUT",
          headers: {
            ...uploadHeaders(fixture.hostA.token, "committed-upload"),
            "content-type": "application/json"
          },
          body: report
        })
      ).status
    ).toBe(403);

    const inputGrant = fixture.coordination.artifactAuthorization.authorizeInputRead({
      workspaceId: fixture.dispatchA.workspaceId,
      projectId: fixture.dispatchA.projectId,
      hostId: fixture.dispatchA.hostId,
      dispatchId: fixture.dispatchA.id,
      leaseId: fixture.dispatchA.leaseId,
      executionAttemptId: fixture.dispatchA.executionAttemptId,
      artifactRef: fixture.inputA.ref
    });
    expect(
      (
        await upload(
          fixture.url(fixture.hostA.host.id, fixture.dispatchA, fixture.inputA.sha256),
          fixture.hostA.token,
          inputGrant.grantId,
          Buffer.from("project A input")
        )
      ).status
    ).toBe(403);
    expect(
      (await fetch(reportUrl, { headers: { Authorization: `Bearer ${fixture.hostA.token}` } }))
        .status
    ).toBe(403);

    const wrongDigest = await upload(
      fixture.url(fixture.hostA.host.id, fixture.dispatchA2, "0".repeat(64)),
      fixture.hostA.token,
      "wrong-digest",
      report
    );
    expect(wrongDigest.status).toBe(400);
    expect(await wrongDigest.json()).toEqual({ error: "artifact_integrity_mismatch" });
    expect(
      (
        await fetch(fixture.url(fixture.hostA.host.id, fixture.dispatchA2, reportSha), {
          method: "PUT",
          headers: {
            ...uploadHeaders(fixture.hostA.token, "invalid-media"),
            "content-type": "../../secret"
          },
          body: report
        })
      ).status
    ).toBe(400);
    const tooLarge = Buffer.alloc(fixture.artifacts.maxArtifactBytes + 1);
    expect(
      (
        await upload(
          fixture.url(
            fixture.hostA.host.id,
            fixture.dispatchA2,
            createHash("sha256").update(tooLarge).digest("hex")
          ),
          fixture.hostA.token,
          "over-limit",
          tooLarge
        )
      ).status
    ).toBe(413);

    const revoked = fixture.coordination.artifactAuthorization.createOutputGrant({
      workspaceId: fixture.dispatchA2.workspaceId,
      projectId: fixture.dispatchA2.projectId,
      hostId: fixture.dispatchA2.hostId,
      dispatchId: fixture.dispatchA2.id,
      leaseId: fixture.dispatchA2.leaseId,
      executionAttemptId: fixture.dispatchA2.executionAttemptId,
      operationId: "revoked-grant",
      permission: "report_write",
      expectedSha256: reportSha,
      expectedSizeBytes: report.byteLength,
      expectedMediaType: "text/plain"
    });
    fixture.coordination.artifactAuthorization.revokeGrant(revoked.grantId);
    expect(
      (
        await upload(
          fixture.url(fixture.hostA.host.id, fixture.dispatchA2, reportSha),
          fixture.hostA.token,
          revoked.grantId,
          report
        )
      ).status
    ).toBe(403);
    const expired = fixture.coordination.artifactAuthorization.createOutputGrant({
      workspaceId: fixture.dispatchA2.workspaceId,
      projectId: fixture.dispatchA2.projectId,
      hostId: fixture.dispatchA2.hostId,
      dispatchId: fixture.dispatchA2.id,
      leaseId: fixture.dispatchA2.leaseId,
      executionAttemptId: fixture.dispatchA2.executionAttemptId,
      operationId: "expired-grant",
      permission: "output_write",
      expectedSha256: reportSha,
      expectedSizeBytes: report.byteLength,
      expectedMediaType: "text/plain"
    });
    fixture.server.database
      .prepare("UPDATE artifact_grants SET expires_at=? WHERE grant_id=?")
      .run("2020-01-01T00:00:00.000Z", expired.grantId);
    expect(
      (
        await upload(
          fixture.url(fixture.hostA.host.id, fixture.dispatchA2, reportSha),
          fixture.hostA.token,
          expired.grantId,
          report
        )
      ).status
    ).toBe(403);
    fixture.coordination.hosts.revoke(fixture.hostA.host.id);
    expect((await upload(reportUrl, fixture.hostA.token, "revoked-host", report)).status).toBe(401);
  });

  it("does not accept aborted streams or uploads fenced during persistence", async () => {
    const fixture = await setup();
    const bytes = Buffer.from("stream that must never become accepted provenance");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const abortOperation = "aborted-stream";
    const pathname = new URL(fixture.url(fixture.hostA.host.id, fixture.dispatchA, sha256))
      .pathname;
    const socket = connect(Number(new URL(fixture.origin).port), "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      `PUT ${pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
        `Authorization: Bearer ${fixture.hostA.token}\r\nContent-Type: text/plain\r\n` +
        `Content-Length: ${bytes.byteLength}\r\n` +
        `x-planweave-artifact-operation-id: ${abortOperation}\r\n` +
        "x-planweave-artifact-purpose: report\r\nConnection: close\r\n\r\n"
    );
    socket.write(bytes.subarray(0, 5));
    for (
      let index = 0;
      index < 100 && !fixture.coordination.artifactAuthorization.getGrant(abortOperation);
      index++
    ) {
      await nextTurn();
    }
    socket.destroy();
    await nextTurn();
    expect(
      fixture.coordination.artifactAuthorization.getGrantRequired(abortOperation).consumedAt
    ).toBeUndefined();
    expect(
      fixture.server.database
        .prepare("SELECT COUNT(*) AS count FROM dispatch_artifact_links WHERE grant_id=?")
        .get(abortOperation)?.count
    ).toBe(0);
    expect(fixture.artifacts.get(`artifact:sha256:${sha256}`)).toBeUndefined();

    const fencedOperation = "fenced-during-stream";
    const responsePromise = new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        fixture.url(fixture.hostA.host.id, fixture.dispatchA2, sha256),
        {
          method: "PUT",
          headers: {
            ...uploadHeaders(fixture.hostA.token, fencedOperation),
            "content-length": String(bytes.byteLength)
          }
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        }
      );
      request.on("error", reject);
      request.write(bytes.subarray(0, 5));
      void (async () => {
        for (
          let index = 0;
          index < 100 && !fixture.coordination.artifactAuthorization.getGrant(fencedOperation);
          index++
        ) {
          await nextTurn();
        }
        fixture.coordination.artifactAuthorization.revokeGrant(fencedOperation);
        request.end(bytes.subarray(5));
      })().catch(reject);
    });
    expect(await responsePromise).toBe(403);
    expect(
      fixture.coordination.artifactAuthorization.getGrantRequired(fencedOperation).consumedAt
    ).toBeUndefined();
    expect(
      fixture.server.database
        .prepare("SELECT COUNT(*) AS count FROM dispatch_artifact_links WHERE grant_id=?")
        .get(fencedOperation)?.count
    ).toBe(0);
  });
});

describe("adversarial dispatch result provenance", () => {
  it("rejects foreign attempt artifacts and preserves exact result replay", async () => {
    const fixture = await setup();
    const acceptReport = async (dispatch: DispatchRecord, text: string, operationId: string) => {
      const bytes = Buffer.from(text);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const grant = fixture.coordination.artifactAuthorization.createOutputGrant({
        workspaceId: dispatch.workspaceId,
        projectId: dispatch.projectId,
        hostId: dispatch.hostId,
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        operationId,
        permission: "report_write",
        expectedSha256: sha256,
        expectedSizeBytes: bytes.byteLength,
        expectedMediaType: "text/plain"
      });
      const artifact = await put(fixture.artifacts, bytes);
      fixture.coordination.artifactAuthorization.acceptOutputUpload(
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
      return artifact.ref;
    };
    const ownRef = await acceptReport(fixture.dispatchA, "own report", "own-result");
    const foreignAttemptRef = await acceptReport(
      fixture.dispatchA2,
      "other attempt report",
      "foreign-attempt-result"
    );
    const crossProjectRef = await acceptReport(
      fixture.dispatchB,
      "cross project report",
      "cross-project-result"
    );
    await expect(
      fixture.coordination.dispatches.complete(
        fixture.dispatchA.hostId,
        "foreign-result-message",
        fixture.dispatchA.id,
        fixture.dispatchA.leaseId,
        fixture.dispatchA.executionAttemptId,
        { summary: "foreign", reportArtifactRef: foreignAttemptRef, artifactRefs: [] }
      )
    ).rejects.toThrowError("artifact_provenance_not_found");
    await expect(
      fixture.coordination.dispatches.complete(
        fixture.dispatchA.hostId,
        "cross-project-result-message",
        fixture.dispatchA.id,
        fixture.dispatchA.leaseId,
        fixture.dispatchA.executionAttemptId,
        { summary: "cross-project", reportArtifactRef: crossProjectRef, artifactRefs: [] }
      )
    ).rejects.toThrowError("artifact_provenance_not_found");
    expect(fixture.coordination.dispatches.getRequired(fixture.dispatchA.id).status).toBe(
      "running"
    );

    const result = { summary: "accepted", reportArtifactRef: ownRef, artifactRefs: [] };
    await expect(
      fixture.coordination.dispatches.complete(
        fixture.dispatchA.hostId,
        "exact-result-message",
        fixture.dispatchA.id,
        fixture.dispatchA.leaseId,
        fixture.dispatchA.executionAttemptId,
        result
      )
    ).resolves.toMatchObject({ status: "completed", result });
    await expect(
      fixture.coordination.dispatches.complete(
        fixture.dispatchA.hostId,
        "exact-result-message",
        fixture.dispatchA.id,
        fixture.dispatchA.leaseId,
        fixture.dispatchA.executionAttemptId,
        result
      )
    ).resolves.toMatchObject({ status: "completed", result });
    expect(fixture.complete).toHaveBeenCalledTimes(1);
    expect(
      fixture.server.database
        .prepare(
          "SELECT COUNT(*) AS count FROM dispatch_artifact_links WHERE grant_id='own-result'"
        )
        .get()?.count
    ).toBe(1);
    await expect(
      fixture.coordination.dispatches.complete(
        fixture.dispatchA.hostId,
        "exact-result-message",
        fixture.dispatchA.id,
        fixture.dispatchA.leaseId,
        fixture.dispatchA.executionAttemptId,
        { ...result, summary: "altered duplicate payload" }
      )
    ).rejects.toThrowError("host_event_message_id_reused");
  });
});

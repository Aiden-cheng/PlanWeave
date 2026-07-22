import { createHash } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachAgentHostArtifactHttp, type ArtifactHttpServer } from "../artifactHttp.js";
import { ArtifactStore } from "../artifacts.js";
import { AgentHostRepository } from "../hosts.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";

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
    const { server, artifacts } = await setup();
    const hosts = new AgentHostRepository(server.database);
    const registration = hosts.register("Artifact Host");
    const httpServer = createServer();
    httpServers.push(httpServer);
    artifactServers.push(
      attachAgentHostArtifactHttp(httpServer, {
        hosts,
        artifacts,
        allowInsecureTransport: true
      })
    );
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected an HTTP port.");
    const bytes = Buffer.from("remote report");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const url = `http://127.0.0.1:${address.port}/agent-hosts/${registration.host.id}/artifacts/${sha256}`;

    const unauthorized = await fetch(url, {
      method: "PUT",
      headers: { Authorization: "Bearer invalid-token", "content-type": "text/markdown" },
      body: bytes
    });
    expect(unauthorized.status).toBe(401);

    const uploaded = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${registration.token}`,
        "content-type": "text/markdown"
      },
      body: bytes
    });
    expect(uploaded.status).toBe(201);
    await expect(uploaded.json()).resolves.toMatchObject({
      ref: `artifact:sha256:${sha256}`,
      sizeBytes: bytes.byteLength
    });

    const downloaded = await fetch(url, {
      headers: { Authorization: `Bearer ${registration.token}` }
    });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("etag")).toBe(`"sha256:${sha256}"`);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
  });
});

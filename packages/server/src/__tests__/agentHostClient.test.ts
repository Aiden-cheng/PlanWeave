import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHostClient, type AgentHostExecutor } from "../agentHostClient.js";
import { openAgentHostState, type AgentHostState } from "../agentHostState.js";
import { attachAgentHostArtifactHttp, type ArtifactHttpServer } from "../artifactHttp.js";
import { ArtifactStore } from "../artifacts.js";
import { createDistributedCoordination } from "../distributedCoordination.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { attachAgentHostWebSocketServer, type AgentHostWebSocketServer } from "../wsServer.js";
import { executionEnvelopeFor } from "./protocolTestFixtures.js";

const directories: string[] = [];
const databases: PlanweaveServer[] = [];
const states: AgentHostState[] = [];
const clients: AgentHostClient[] = [];
const httpServers: HttpServer[] = [];
const artifactServers: ArtifactHttpServer[] = [];
const webSocketServers: AgentHostWebSocketServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  for (const state of states.splice(0)) state.close();
  for (const artifactServer of artifactServers.splice(0)) artifactServer.close();
  await Promise.all(webSocketServers.splice(0).map((server) => server.close()));
  await Promise.all(
    httpServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Agent Host client", () => {
  it("executes a remote dispatch and uploads its verified report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-agent-host-client-"));
    directories.push(directory);
    const database = await startPlanweaveServer({
      dataDirectory: join(directory, "server"),
      databasePath: join(directory, "server", "server.sqlite"),
      busyTimeoutMs: 5000
    });
    databases.push(database);
    const coordination = createDistributedCoordination(database.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete: async () => {}, fail: async () => {} }
    });
    const registration = coordination.hosts.register("Test Agent Host");
    const artifacts = new ArtifactStore(database.database, join(directory, "server"), 1024 * 1024);
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
    webSocketServers.push(
      attachAgentHostWebSocketServer({
        server: httpServer,
        hosts: coordination.hosts,
        mailbox: coordination.mailbox,
        dispatches: coordination.dispatches,
        heartbeatIntervalMs: 100,
        leaseDurationMs: 60_000,
        allowInsecureTransport: true
      })
    );
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Expected an HTTP port.");

    const state = await openAgentHostState(join(directory, "host.sqlite"));
    states.push(state);
    const report = Buffer.from("# Remote result\n\nExecution completed.\n");
    const executor: AgentHostExecutor = {
      execute: async (_execution, context) => {
        const reportArtifactRef = await context.uploadArtifact({
          bytes: report,
          mediaType: "text/markdown; charset=utf-8",
          purpose: "report",
          operationKey: "primary-report"
        });
        return {
          summary: "Remote execution completed.",
          reportArtifactRef,
          artifactRefs: []
        };
      }
    };
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${address.port}`,
      hostId: registration.host.id,
      token: registration.token,
      capabilities: ["test"],
      capacity: 1,
      state,
      executor,
      allowInsecureTransport: true,
      reconnectDelayMs: 10
    });
    clients.push(client);
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async (...args) => {
      const response = await realFetch(...args);
      await response.arrayBuffer();
      throw new TypeError("simulated_lost_upload_response");
    });
    client.start();
    await waitFor(
      () => coordination.hosts.getRequired(registration.host.id).lastSeenAt !== undefined
    );

    const dispatch = coordination.dispatches.dispatchBlock({
      packageRef: "package://project-client/v1",
      envelope: executionEnvelopeFor("T-001#B-001", ["test"], "project-client")
    });
    await waitFor(() =>
      ["completed", "failed", "cancelled"].includes(
        coordination.dispatches.getRequired(dispatch.id).status
      )
    );
    const completed = coordination.dispatches.getRequired(dispatch.id);
    expect(completed.status).toBe("completed");
    expect(completed.result?.summary).toBe("Remote execution completed.");
    await expect(artifacts.read(completed.result?.reportArtifactRef ?? "")).resolves.toEqual(
      report
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(
      database.database.prepare("SELECT COUNT(*) AS count FROM artifact_grants").get()?.count
    ).toBe(1);
    expect(
      database.database
        .prepare("SELECT COUNT(*) AS count FROM dispatch_artifact_links WHERE purpose='report'")
        .get()?.count
    ).toBe(1);
    expect(
      database.database.prepare("SELECT COUNT(*) AS count FROM artifact_blobs").get()?.count
    ).toBe(1);
    expect(state.pendingExecutions(1)).toEqual([]);
  });
});

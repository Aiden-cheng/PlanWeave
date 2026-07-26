import { createHash } from "node:crypto";
import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRemoteBlockRuntimePort, type PlanPackageManifest } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTestWorkspace,
  basicManifest
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ArtifactStore } from "../artifacts.js";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { RemoteRuntimePortRegistry } from "../remoteRuntimeLocator.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function remoteManifest(): PlanPackageManifest {
  const manifest = basicManifest();
  manifest.execution.defaultExecutor = "codex-acp";
  manifest.executors = {
    "codex-acp": {
      adapter: "agent",
      agent: "codex",
      runner: { transport: "acp" }
    }
  };
  return manifest;
}

async function setup(withHost: boolean) {
  const workspace = await createTestWorkspace(remoteManifest());
  directories.push(workspace.home, workspace.root);
  const dataDirectory = join(workspace.root, "server-data");
  const server = await startPlanweaveServer({
    dataDirectory,
    databasePath: join(dataDirectory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  servers.push(server);
  const locator = { projectId: workspace.init.workspace.id, canvasId: "default" };
  const runtime = createRemoteBlockRuntimePort({ projectRoot: workspace.root });
  const registry = new RemoteRuntimePortRegistry();
  registry.bind(locator, runtime);
  const artifacts = new ArtifactStore(server.database, dataDirectory, 1024 * 1024);
  const coordination = createRemoteBlockCoordination(
    server.database,
    {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeResolver: registry,
      inputArtifacts: {
        materialize: async (candidate) => {
          if (candidate.inputArtifacts.length !== 0) throw new Error("unexpected_test_artifact");
        }
      },
      artifactContent: { readReport: async (ref) => artifacts.read(ref) }
    },
    { serverInstanceOwnerToken: server.serverInstanceOwnerToken }
  );
  const host = withHost ? coordination.hosts.register("Coordinator Host").host : undefined;
  if (host) coordination.hosts.reportOnline(host.id, ["acp.codex"], 1);
  return {
    workspace,
    server,
    locator,
    runtime,
    registry,
    hosts: coordination.hosts,
    host,
    mailbox: coordination.mailbox,
    artifacts,
    operations: coordination.operations,
    coordinator: coordination.coordinator,
    dispatches: coordination.dispatches,
    artifactAuthorization: coordination.artifactAuthorization
  };
}

describe("RemoteBlockCoordinator", () => {
  it("uses one stable identity and replays claim, grants, mailbox enqueue, and publish", async () => {
    const fixture = await setup(true);
    const publish = vi.fn();
    const unsubscribe = fixture.mailbox.subscribe(fixture.host?.id ?? "", publish);
    const request = {
      ...fixture.locator,
      blockRef: "T-001#B-001",
      idempotencyKey: "dispatch-request-1"
    };

    const first = await fixture.coordinator.dispatch(request);
    const replay = await fixture.coordinator.dispatch(request);
    unsubscribe();

    expect(first.status).toBe("activated");
    expect(replay.operation.id).toBe(first.operation.id);
    expect(replay.operation.dispatchId).toBe(first.operation.dispatchId);
    expect(replay.operation.executionAttemptId).toBe(first.operation.executionAttemptId);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(fixture.mailbox.listAfter(fixture.host?.id ?? "", 0)).toHaveLength(1);
    const command = fixture.mailbox.listAfter(fixture.host?.id ?? "", 0)[0]?.command;
    expect(command).toMatchObject({
      type: "execute_block",
      dispatchId: first.operation.dispatchId,
      executionAttemptId: first.operation.executionAttemptId,
      envelope: {
        execution: {
          dispatchId: first.operation.dispatchId,
          attemptId: first.operation.executionAttemptId
        }
      }
    });
    expect(JSON.stringify(command)).not.toContain(fixture.workspace.root);
    await expect(
      fixture.runtime.query({ ref: request.blockRef, operationId: first.operation.id })
    ).resolves.toMatchObject({ ownership: { phase: "active" } });
  });

  it("keeps a claimed operation actionable until capacity appears", async () => {
    const fixture = await setup(false);
    const request = {
      ...fixture.locator,
      blockRef: "T-001#B-001",
      idempotencyKey: "dispatch-request-no-host"
    };
    const pending = await fixture.coordinator.dispatch(request);
    expect(pending.status).toBe("awaiting_host");
    expect(pending.operation.state).toBe("claimed");
    expect(
      fixture.server.database
        .prepare("SELECT diagnostic_code FROM remote_operations WHERE id=?")
        .get(pending.operation.id)?.diagnostic_code
    ).toBe("no_compatible_agent_host");

    const host = fixture.hosts.register("Late Host").host;
    fixture.hosts.reportOnline(host.id, ["acp.codex"], 1);
    await expect(fixture.coordinator.reenter(pending.operation.id)).resolves.toMatchObject({
      status: "activated"
    });
  });

  it("fails closed on source drift and on a missing restart locator", async () => {
    const fixture = await setup(false);
    const pending = await fixture.coordinator.dispatch({
      ...fixture.locator,
      blockRef: "T-001#B-001",
      idempotencyKey: "dispatch-request-drift"
    });
    await appendFile(
      join(fixture.workspace.init.workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md"),
      "\nchanged after claim\n",
      "utf8"
    );
    const host = fixture.hosts.register("Drift Host").host;
    fixture.hosts.reportOnline(host.id, ["acp.codex"], 1);
    await expect(fixture.coordinator.reenter(pending.operation.id)).rejects.toThrowError(
      "remote_source_changed"
    );
    expect(
      fixture.server.database
        .prepare("SELECT diagnostic_code FROM remote_operations WHERE id=?")
        .get(pending.operation.id)?.diagnostic_code
    ).toBe("runtime_reconciliation_conflict");

    const unbindable = new RemoteRuntimePortRegistry();
    expect(() => unbindable.resolve(fixture.locator)).toThrowError(
      "remote_runtime_locator_unresolved"
    );
  });

  it("re-enters terminal completion through the Runtime authority", async () => {
    const fixture = await setup(true);
    const outcome = await fixture.coordinator.dispatch({
      ...fixture.locator,
      blockRef: "T-001#B-001",
      idempotencyKey: "dispatch-request-complete"
    });
    const report = Buffer.from("# Remote result\n\nCompleted by the remote host.\n");
    const artifact = await fixture.artifacts.put({
      expectedSha256: createHash("sha256").update(report).digest("hex"),
      expectedSizeBytes: report.byteLength,
      mediaType: "text/markdown",
      chunks: (async function* () {
        yield report;
      })()
    });
    const dispatch = fixture.dispatches.getRequired(outcome.operation.dispatchId);
    fixture.dispatches.accept(
      fixture.host?.id ?? "",
      "accept-completion",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    const grant = fixture.artifactAuthorization.createOutputGrant({
      operationId: "coordinator-completion-report",
      projectId: dispatch.projectId,
      hostId: dispatch.hostId,
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      permission: "report_write",
      expectedSha256: artifact.sha256,
      expectedSizeBytes: artifact.sizeBytes,
      expectedMediaType: artifact.mediaType
    });
    fixture.artifactAuthorization.acceptOutputUpload(
      {
        projectId: dispatch.projectId,
        hostId: dispatch.hostId,
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        grantId: grant.grantId
      },
      artifact
    );
    await fixture.dispatches.complete(
      dispatch.hostId,
      "complete-coordinator",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId,
      {
        summary: "Remote completion.",
        reportArtifactRef: artifact.ref,
        artifactRefs: []
      }
    );
    await expect(
      fixture.runtime.query({ ref: "T-001#B-001", operationId: outcome.operation.id })
    ).resolves.toMatchObject({ status: "completed" });
    expect(fixture.operations.getRequired(outcome.operation.id).state).toBe("completed");
  });
});

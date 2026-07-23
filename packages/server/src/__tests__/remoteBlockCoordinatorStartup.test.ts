import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createRemoteBlockRuntimePort, type RemoteBlockRuntimePort } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  basicManifest,
  createTestWorkspace
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ArtifactStore } from "../artifacts.js";
import {
  startRemoteBlockCoordinationServer,
  type RemoteBlockCoordinationOptions
} from "../distributedCoordination.js";
import type { PlanweaveServer } from "../lifecycle.js";
import type {
  RemoteCoordinatorCheckpoint,
  RemoteCoordinatorCheckpointPort
} from "../remoteBlockCoordinatorPorts.js";
import { RemoteRuntimePortRegistry } from "../remoteRuntimeLocator.js";

type StartedCoordination = Awaited<ReturnType<typeof startRemoteBlockCoordinationServer>>;
type Coordination = StartedCoordination["coordination"];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class CrashOnce implements RemoteCoordinatorCheckpointPort {
  private crashed = false;

  constructor(readonly target: RemoteCoordinatorCheckpoint) {}

  reached(checkpoint: RemoteCoordinatorCheckpoint): void {
    if (checkpoint === this.target && !this.crashed) {
      this.crashed = true;
      throw new Error(`injected_crash:${checkpoint}`);
    }
  }
}

class StartupHarness {
  private server?: PlanweaveServer;
  coordination?: Coordination;
  runtime?: RemoteBlockRuntimePort;
  artifacts?: ArtifactStore;

  private constructor(
    readonly workspace: Awaited<ReturnType<typeof createTestWorkspace>>,
    readonly dataDirectory: string,
    readonly databasePath: string,
    readonly locator: { projectId: string; canvasId: string }
  ) {}

  static async create(): Promise<StartupHarness> {
    const manifest = basicManifest();
    manifest.execution.defaultExecutor = "codex-acp";
    manifest.executors = {
      "codex-acp": {
        adapter: "agent",
        agent: "codex",
        runner: { transport: "acp" }
      }
    };
    const workspace = await createTestWorkspace(manifest);
    const dataDirectory = join(workspace.root, "server-data");
    const harness = new StartupHarness(
      workspace,
      dataDirectory,
      join(dataDirectory, "server.sqlite"),
      { projectId: workspace.init.workspace.id, canvasId: "default" }
    );
    cleanups.push(async () => {
      harness.close();
      await Promise.all([
        rm(workspace.home, { recursive: true, force: true }),
        rm(workspace.root, { recursive: true, force: true })
      ]);
    });
    await harness.start();
    return harness;
  }

  async start(
    checkpoints?: RemoteCoordinatorCheckpointPort,
    decorateRuntime: (runtime: RemoteBlockRuntimePort) => RemoteBlockRuntimePort = (runtime) =>
      runtime
  ): Promise<Coordination> {
    this.close();
    this.runtime = decorateRuntime(
      createRemoteBlockRuntimePort({ projectRoot: this.workspace.root })
    );
    const registry = new RemoteRuntimePortRegistry();
    registry.bind(this.locator, this.runtime);
    const started = await startRemoteBlockCoordinationServer(
      {
        dataDirectory: this.dataDirectory,
        databasePath: this.databasePath,
        busyTimeoutMs: 5_000
      },
      (database): RemoteBlockCoordinationOptions => {
        this.artifacts = new ArtifactStore(database, this.dataDirectory, 1024 * 1024);
        return {
          leaseDurationMs: 60_000,
          hostOfflineAfterMs: 60_000,
          runtimeResolver: registry,
          inputArtifacts: { materialize: async () => {} },
          artifactContent: { readReport: async (ref) => this.requireArtifacts().read(ref) },
          checkpoints
        };
      }
    );
    this.server = started.server;
    this.coordination = started.coordination;
    return started.coordination;
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
    this.coordination = undefined;
    this.runtime = undefined;
    this.artifacts = undefined;
  }

  requireCoordination(): Coordination {
    if (!this.coordination) throw new Error("test_coordination_not_started");
    return this.coordination;
  }

  requireServer(): PlanweaveServer {
    if (!this.server) throw new Error("test_server_not_started");
    return this.server;
  }

  requireArtifacts(): ArtifactStore {
    if (!this.artifacts) throw new Error("test_artifacts_not_started");
    return this.artifacts;
  }

  registerHost(): string {
    const host = this.requireCoordination().hosts.register("Startup Reconciliation Host").host;
    this.requireCoordination().hosts.reportOnline(host.id, ["acp.codex"], 1);
    return host.id;
  }

  request(idempotencyKey: string) {
    return { ...this.locator, blockRef: "T-001#B-001", idempotencyKey };
  }
}

function eventCount(database: PlanweaveServer["database"], table: string, type: string): number {
  return Number(
    database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE type=?`).get(type)?.count ?? 0
  );
}

describe("RemoteBlockCoordinator startup reconciliation", () => {
  it.each([
    "complete",
    "fail",
    "cancel"
  ] as const)("converges %s after dispatch terminal persistence without replaying Runtime writeback", async (action) => {
    const harness = await StartupHarness.create();
    const hostId = harness.registerHost();
    const writebacks = { complete: 0, fail: 0 };
    const decorateRuntime = (runtime: RemoteBlockRuntimePort): RemoteBlockRuntimePort => ({
      ...runtime,
      complete: async (input) => {
        writebacks.complete += 1;
        return runtime.complete(input);
      },
      fail: async (input) => {
        writebacks.fail += 1;
        return runtime.fail(input);
      }
    });
    await harness.start(new CrashOnce("after_dispatch_terminal_persistence"), decorateRuntime);
    const coordination = harness.requireCoordination();
    const outcome = await coordination.coordinator.dispatch(harness.request(`terminal-${action}`));
    const dispatch = coordination.dispatches.getRequired(outcome.operation.dispatchId);
    coordination.dispatches.accept(
      hostId,
      `accepted-${action}`,
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );

    if (action === "complete") {
      const report = Buffer.from("# Complete after restart\n");
      const artifact = await harness.requireArtifacts().put({
        expectedSha256: createHash("sha256").update(report).digest("hex"),
        expectedSizeBytes: report.byteLength,
        mediaType: "text/markdown",
        chunks: (async function* () {
          yield report;
        })()
      });
      const grant = coordination.artifactAuthorization.createOutputGrant({
        operationId: `terminal-${action}-grant`,
        projectId: dispatch.projectId,
        hostId,
        dispatchId: dispatch.id,
        leaseId: dispatch.leaseId,
        executionAttemptId: dispatch.executionAttemptId,
        permission: "report_write",
        expectedSha256: artifact.sha256,
        expectedSizeBytes: artifact.sizeBytes,
        expectedMediaType: artifact.mediaType
      });
      coordination.artifactAuthorization.acceptOutputUpload(
        {
          projectId: dispatch.projectId,
          hostId,
          dispatchId: dispatch.id,
          leaseId: dispatch.leaseId,
          executionAttemptId: dispatch.executionAttemptId,
          grantId: grant.grantId
        },
        artifact
      );
      await expect(
        coordination.dispatches.complete(
          hostId,
          `terminal-${action}`,
          dispatch.id,
          dispatch.leaseId,
          dispatch.executionAttemptId,
          {
            summary: "Completed remotely.",
            reportArtifactRef: artifact.ref,
            artifactRefs: []
          }
        )
      ).rejects.toThrowError("injected_crash:after_dispatch_terminal_persistence");
    } else {
      const failure =
        action === "cancel"
          ? { code: "execution_cancelled", message: "Cancelled.", retryable: false }
          : { code: "remote_test_failure", message: "Failed.", retryable: false };
      await expect(
        coordination.dispatches.fail(
          hostId,
          `terminal-${action}`,
          dispatch.id,
          dispatch.leaseId,
          dispatch.executionAttemptId,
          failure
        )
      ).rejects.toThrowError("injected_crash:after_dispatch_terminal_persistence");
    }

    const expectedStatus =
      action === "complete" ? "completed" : action === "cancel" ? "cancelled" : "failed";
    expect(coordination.dispatches.getRequired(dispatch.id).status).toBe(expectedStatus);
    expect(coordination.operations.getRequired(outcome.operation.id).state).toBe("activated");
    expect(coordination.reservations.getRequired(dispatch.leaseId).status).toBe("active");
    expect(writebacks).toEqual({
      complete: action === "complete" ? 1 : 0,
      fail: action === "complete" ? 0 : 1
    });

    const restarted = await harness.start(undefined, decorateRuntime);
    expect(restarted.operations.getRequired(outcome.operation.id).state).toBe(expectedStatus);
    expect(restarted.dispatches.getRequired(dispatch.id).status).toBe(expectedStatus);
    expect(restarted.reservations.getRequired(dispatch.leaseId).status).toBe(
      action === "cancel" ? "cancelled" : "released"
    );
    expect(writebacks).toEqual({
      complete: action === "complete" ? 1 : 0,
      fail: action === "complete" ? 0 : 1
    });
    expect(
      eventCount(harness.requireServer().database, "dispatch_events", `dispatch.${expectedStatus}`)
    ).toBe(1);
    expect(
      eventCount(
        harness.requireServer().database,
        "remote_operation_events",
        `remote.attempt.${expectedStatus}`
      )
    ).toBe(1);
  });

  it("fails startup visibly, closes the failed database, and succeeds on the next restart", async () => {
    const harness = await StartupHarness.create();
    const pending = await harness
      .requireCoordination()
      .coordinator.dispatch(harness.request("startup-visible-failure"));
    expect(pending.status).toBe("awaiting_host");

    await expect(harness.start(new CrashOnce("after_input_materialization"))).rejects.toThrowError(
      "injected_crash:after_input_materialization"
    );
    const restarted = await harness.start();
    expect(restarted.operations.getRequired(pending.operation.id).state).toBe("claimed");
  });
});

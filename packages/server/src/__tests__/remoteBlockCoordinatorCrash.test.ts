import { createHash } from "node:crypto";
import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createRemoteBlockRuntimePort,
  type PlanPackageManifest,
  type RemoteBlockDispatchCandidate,
  type RemoteBlockRuntimePort
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestWorkspace,
  basicManifest
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ArtifactStore } from "../artifacts.js";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import type { RemoteBlockCoordinationOptions } from "../distributedCoordination.js";
import type {
  RemoteCoordinatorCheckpoint,
  RemoteCoordinatorCheckpointPort
} from "../remoteBlockCoordinatorPorts.js";
import { RemoteRuntimePortRegistry } from "../remoteRuntimeLocator.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";

type Coordination = ReturnType<typeof createRemoteBlockCoordination>;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function remoteManifest(includeSecondTask = false): PlanPackageManifest {
  const manifest = basicManifest({
    parallel: includeSecondTask,
    maxConcurrent: includeSecondTask ? 2 : 1,
    includeSecondTask
  });
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

class CoordinatorHarness {
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

  static async create(includeSecondTask = false): Promise<CoordinatorHarness> {
    const workspace = await createTestWorkspace(remoteManifest(includeSecondTask));
    const dataDirectory = join(workspace.root, "server-data");
    const harness = new CoordinatorHarness(
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
    await harness.restart();
    return harness;
  }

  async restart(
    checkpoints?: RemoteCoordinatorCheckpointPort,
    decorateRuntime: (runtime: RemoteBlockRuntimePort) => RemoteBlockRuntimePort = (runtime) =>
      runtime,
    materialize: RemoteBlockCoordinationOptions["inputArtifacts"]["materialize"] = async () => {}
  ): Promise<Coordination> {
    this.close();
    this.server = await startPlanweaveServer({
      dataDirectory: this.dataDirectory,
      databasePath: this.databasePath,
      busyTimeoutMs: 5_000
    });
    this.runtime = decorateRuntime(
      createRemoteBlockRuntimePort({ projectRoot: this.workspace.root })
    );
    const registry = new RemoteRuntimePortRegistry();
    registry.bind(this.locator, this.runtime);
    this.artifacts = new ArtifactStore(this.server.database, this.dataDirectory, 1024 * 1024);
    const options: RemoteBlockCoordinationOptions = {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      runtimeResolver: registry,
      inputArtifacts: { materialize },
      artifactContent: { readReport: async (ref) => this.requireArtifacts().read(ref) },
      checkpoints
    };
    this.coordination = createRemoteBlockCoordination(this.server.database, options);
    return this.coordination;
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

  requireRuntime(): RemoteBlockRuntimePort {
    if (!this.runtime) throw new Error("test_runtime_not_started");
    return this.runtime;
  }

  requireArtifacts(): ArtifactStore {
    if (!this.artifacts) throw new Error("test_artifacts_not_started");
    return this.artifacts;
  }

  registerHost(capacity = 1): string {
    const coordination = this.requireCoordination();
    const host = coordination.hosts.register("Crash Matrix Host").host;
    coordination.hosts.reportOnline(host.id, ["acp.codex"], capacity);
    return host.id;
  }

  request(blockRef = "T-001#B-001", idempotencyKey = "crash-matrix-request") {
    return { ...this.locator, blockRef, idempotencyKey };
  }
}

const dispatchCrashPoints = [
  "before_operation_commit",
  "after_operation_commit",
  "after_candidate_persistence",
  "after_runtime_claim",
  "after_envelope_persistence",
  "after_input_materialization",
  "after_host_reservation",
  "after_dispatch_persistence",
  "after_runtime_binding",
  "after_mailbox_enqueue",
  "after_mailbox_publish"
] as const satisfies readonly RemoteCoordinatorCheckpoint[];

function count(database: PlanweaveServer["database"], table: string): number {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
}

function diagnosticCode(database: PlanweaveServer["database"], operationId: string): unknown {
  return database
    .prepare("SELECT diagnostic_code AS code FROM remote_operations WHERE id=?")
    .get(operationId)?.code;
}

describe("RemoteBlockCoordinator crash reconciliation", () => {
  it.each(dispatchCrashPoints)("recovers the same operation after %s", async (checkpoint) => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    await harness.restart(new CrashOnce(checkpoint));

    await expect(
      harness.requireCoordination().coordinator.dispatch(harness.request())
    ).rejects.toThrowError(`injected_crash:${checkpoint}`);

    const coordination = await harness.restart();
    const recovered = await coordination.coordinator.dispatch(harness.request());
    expect(recovered.status).toBe("activated");
    expect(recovered.operation.state).toBe("activated");
    const database = harness.requireServer().database;
    expect(count(database, "remote_operations")).toBe(1);
    expect(count(database, "remote_execution_attempts")).toBe(1);
    expect(count(database, "host_capacity_reservations")).toBe(1);
    expect(count(database, "dispatches")).toBe(1);
    expect(count(database, "dispatch_execution_envelopes")).toBe(1);
    expect(count(database, "mailbox_messages")).toBe(1);
    expect(
      database
        .prepare(
          `SELECT type,COUNT(*) AS count FROM remote_operation_events
           GROUP BY type HAVING COUNT(*)>1`
        )
        .all()
    ).toEqual([]);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM dispatch_events WHERE type='dispatch.leased'")
        .get()?.count
    ).toBe(1);
    await expect(
      harness.requireRuntime().query({
        ref: recovered.operation.blockRef,
        operationId: recovered.operation.id
      })
    ).resolves.toMatchObject({ ownership: { phase: "active" } });
  });

  it("does not reactivate or republish after Host acceptance", async () => {
    const harness = await CoordinatorHarness.create();
    const hostId = harness.registerHost();
    const outcome = await harness.requireCoordination().coordinator.dispatch(harness.request());
    const dispatch = harness
      .requireCoordination()
      .dispatches.getRequired(outcome.operation.dispatchId);
    harness
      .requireCoordination()
      .dispatches.accept(
        hostId,
        "accepted-before-restart",
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId
      );
    harness
      .requireCoordination()
      .dispatches.accept(
        hostId,
        "accepted-before-restart",
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId
      );

    const crashed = await harness.restart(new CrashOnce("after_host_acceptance_observed"));
    await expect(crashed.coordinator.reenterPending()).rejects.toThrowError(
      "injected_crash:after_host_acceptance_observed"
    );
    const restarted = await harness.restart();
    await expect(restarted.coordinator.reenterPending()).resolves.toMatchObject([
      { status: "active" }
    ]);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(1);
    expect(
      harness
        .requireServer()
        .database.prepare(
          "SELECT COUNT(*) AS count FROM dispatch_events WHERE type='dispatch.accepted'"
        )
        .get()?.count
    ).toBe(1);
  });

  it("preserves one input grant and materialization across dispatch persistence restart", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    const bytes = Buffer.from("durable coordinator input");
    const artifact = await harness.requireArtifacts().put({
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
      expectedSizeBytes: bytes.byteLength,
      mediaType: "text/plain",
      chunks: (async function* () {
        yield bytes;
      })()
    });
    const materialized = new Set<string>();
    const decorateRuntime = (runtime: RemoteBlockRuntimePort): RemoteBlockRuntimePort => ({
      ...runtime,
      inspect: async (input) => {
        const candidate = await runtime.inspect(input);
        return {
          ...candidate,
          inputArtifacts: [
            { artifactRef: artifact.ref, logicalName: "coordinator-input", mediaType: "text/plain" }
          ]
        };
      }
    });
    const materialize = async (candidate: RemoteBlockDispatchCandidate) => {
      for (const input of candidate.inputArtifacts) {
        await harness.requireArtifacts().read(input.artifactRef);
        materialized.add(input.artifactRef);
      }
    };
    await harness.restart(
      new CrashOnce("after_dispatch_persistence"),
      decorateRuntime,
      materialize
    );
    await expect(
      harness.requireCoordination().coordinator.dispatch(harness.request())
    ).rejects.toThrowError("injected_crash:after_dispatch_persistence");

    const restarted = await harness.restart(undefined, decorateRuntime, materialize);
    await expect(restarted.coordinator.dispatch(harness.request())).resolves.toMatchObject({
      status: "activated"
    });
    expect(materialized).toEqual(new Set([artifact.ref]));
    expect(count(harness.requireServer().database, "artifact_grants")).toBe(1);
    expect(count(harness.requireServer().database, "dispatch_artifact_links")).toBe(1);
  });

  it("blocks a restarted operation when its Runtime source has drifted", async () => {
    const harness = await CoordinatorHarness.create();
    const outcome = await harness.requireCoordination().coordinator.dispatch(harness.request());
    expect(outcome.status).toBe("awaiting_host");
    await appendFile(
      join(harness.workspace.init.workspace.packageDir, "nodes/T-001/blocks/B-001.prompt.md"),
      "\nsource drift after durable preparation\n",
      "utf8"
    );

    await harness.restart();
    harness.registerHost();
    await expect(harness.requireCoordination().coordinator.reenterPending()).rejects.toThrowError(
      "remote_source_changed"
    );
    expect(count(harness.requireServer().database, "host_capacity_reservations")).toBe(0);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(0);
    expect(diagnosticCode(harness.requireServer().database, outcome.operation.id)).toBe(
      "runtime_reconciliation_conflict"
    );
  });

  it("rejects foreign Runtime ownership before reserving a Host", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    const runtime = harness.requireRuntime();
    const candidate = await runtime.inspect({ ref: "T-001#B-001" });
    await runtime.claim({
      ref: candidate.blockRef,
      operationId: "foreign-operation",
      sourceRevision: candidate.sourceRevision,
      graphFingerprint: candidate.graphFingerprint
    });

    await expect(
      harness.requireCoordination().coordinator.dispatch(harness.request())
    ).rejects.toThrow();
    expect(count(harness.requireServer().database, "remote_operations")).toBe(0);
    expect(count(harness.requireServer().database, "host_capacity_reservations")).toBe(0);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(0);
    await expect(
      runtime.query({ ref: candidate.blockRef, operationId: "foreign-operation" })
    ).resolves.toMatchObject({
      ownership: { operationId: "foreign-operation", phase: "preparing" }
    });
  });

  it("surfaces an orphaned dispatch envelope instead of creating a second attempt", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    const outcome = await harness.requireCoordination().coordinator.dispatch(harness.request());
    harness
      .requireServer()
      .database.prepare("DELETE FROM dispatch_execution_envelopes WHERE dispatch_id=?")
      .run(outcome.operation.dispatchId);

    await harness.restart();
    await expect(harness.requireCoordination().coordinator.reenterPending()).rejects.toThrowError(
      "remote_persistence_inconsistent"
    );
    expect(diagnosticCode(harness.requireServer().database, outcome.operation.id)).toBe(
      "remote_persistence_inconsistent"
    );
    expect(count(harness.requireServer().database, "remote_execution_attempts")).toBe(1);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(1);
  });

  it("deduplicates cancel replay and rejects conflicting message identity", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost();
    const outcome = await harness.requireCoordination().coordinator.dispatch(harness.request());
    const coordinator = harness.requireCoordination().coordinator;

    coordinator.requestCancel(outcome.operation.id, "operator requested cancellation");
    coordinator.requestCancel(outcome.operation.id, "operator requested cancellation");
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(2);
    expect(() => coordinator.requestCancel(outcome.operation.id, "different reason")).toThrowError(
      "mailbox_message_identity_conflict"
    );
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(2);
  });

  it.each([
    "before_runtime_writeback",
    "after_runtime_writeback",
    "after_terminal_persistence"
  ] as const)("reconciles terminal failure after %s", async (checkpoint) => {
    const harness = await CoordinatorHarness.create();
    const hostId = harness.registerHost();
    const outcome = await harness.requireCoordination().coordinator.dispatch(harness.request());
    const dispatch = harness
      .requireCoordination()
      .dispatches.getRequired(outcome.operation.dispatchId);
    harness
      .requireCoordination()
      .dispatches.accept(
        hostId,
        `accepted-${checkpoint}`,
        dispatch.id,
        dispatch.leaseId,
        dispatch.executionAttemptId
      );
    await harness.restart(new CrashOnce(checkpoint));
    const current = harness.requireCoordination().dispatches.getRequired(dispatch.id);

    await expect(
      harness
        .requireCoordination()
        .dispatches.fail(
          hostId,
          `failed-${checkpoint}`,
          current.id,
          current.leaseId,
          current.executionAttemptId,
          { code: "remote_test_failure", message: "Injected terminal failure.", retryable: false }
        )
    ).rejects.toThrowError(`injected_crash:${checkpoint}`);

    const restarted = await harness.restart();
    await restarted.coordinator.reenterPending();
    expect(restarted.operations.getRequired(outcome.operation.id).state).toBe("failed");
    expect(restarted.dispatches.getRequired(dispatch.id).status).toBe("failed");
    expect(
      harness
        .requireServer()
        .database.prepare(
          "SELECT COUNT(*) AS count FROM remote_operation_events WHERE type='remote.attempt.failed'"
        )
        .get()?.count
    ).toBe(1);
    expect(
      harness
        .requireServer()
        .database.prepare(
          "SELECT COUNT(*) AS count FROM dispatch_events WHERE type='dispatch.failed'"
        )
        .get()?.count
    ).toBe(1);
  });
});

describe("RemoteBlockCoordinator concurrency reconciliation", () => {
  it("collapses concurrent identical requests to one logical execution", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost(2);
    const coordination = harness.requireCoordination();
    const [first, second] = await Promise.all([
      coordination.coordinator.dispatch(harness.request()),
      coordination.coordinator.dispatch(harness.request())
    ]);
    expect(second.operation.id).toBe(first.operation.id);
    expect(second.operation.executionAttemptId).toBe(first.operation.executionAttemptId);
    expect(count(harness.requireServer().database, "host_capacity_reservations")).toBe(1);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(1);
  });

  it("rejects foreign idempotency ownership without a second active attempt", async () => {
    const harness = await CoordinatorHarness.create();
    harness.registerHost(2);
    const coordination = harness.requireCoordination();
    const settled = await Promise.allSettled([
      coordination.coordinator.dispatch(harness.request("T-001#B-001", "owner-a")),
      coordination.coordinator.dispatch(harness.request("T-001#B-001", "owner-b"))
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      harness
        .requireServer()
        .database.prepare(
          `SELECT COUNT(*) AS count FROM remote_execution_attempts
           WHERE status IN ('reserved','activated','running','interrupted','action_required','awaiting_writeback')`
        )
        .get()?.count
    ).toBe(1);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(1);
  });

  it("keeps Host capacity transactional across different Blocks", async () => {
    const harness = await CoordinatorHarness.create(true);
    harness.registerHost(1);
    const coordination = harness.requireCoordination();
    const outcomes = await Promise.all([
      coordination.coordinator.dispatch(harness.request("T-001#B-001", "capacity-a")),
      coordination.coordinator.dispatch(harness.request("T-002#B-001", "capacity-b"))
    ]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      "activated",
      "awaiting_host"
    ]);
    expect(count(harness.requireServer().database, "host_capacity_reservations")).toBe(1);
    expect(count(harness.requireServer().database, "mailbox_messages")).toBe(1);
  });
});

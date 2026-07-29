import { createHash } from "node:crypto";
import { appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createRemoteBlockArtifactSource,
  createRemoteBlockRuntimePort,
  type PlanPackageManifest
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTestWorkspace,
  basicManifest
} from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { ArtifactStore } from "../artifacts.js";
import { canonicalRemoteRuntimePort } from "../canonicalRemoteRuntimePort.js";
import { createRemoteBlockCoordination } from "../distributedCoordination.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { RemoteRuntimePortRegistry } from "../remoteRuntimeLocator.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { ProjectAccessRepository } from "../projectAccessRepository.js";
import { AuthorityRepository } from "../work/authorityRepository.js";

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
  const workspaceId = new WorkspaceIdentityRepository(
    server.database
  ).ensureWorkspaceForLegacyProject(workspace.init.workspace.id);
  const locator = {
    workspaceId,
    projectId: workspace.init.workspace.id,
    canvasId: "default"
  };
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
  if (host) {
    coordination.hosts.bindToWorkspace(host.id, workspaceId);
    coordination.hosts.reportOnline(host.id, ["acp.codex"], 1, {
      workspaceMappings: [{ workspaceId, status: "ready" }],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          status: "ready",
          capabilities: ["acp.codex"]
        }
      ]
    });
  }
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
    reservations: coordination.reservations,
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
    const workspaceId = new WorkspaceIdentityRepository(
      fixture.server.database
    ).workspaceForLegacyProject(fixture.locator.projectId);
    if (!workspaceId) throw new Error("workspace_mapping_missing");
    fixture.hosts.bindToWorkspace(host.id, workspaceId);
    fixture.hosts.reportOnline(host.id, ["acp.codex"], 1);
    await expect(fixture.coordinator.reenter(pending.operation.id)).resolves.toMatchObject({
      status: "activated"
    });
  });

  it("rechecks separated authority revisions before reentering an active Host attempt", async () => {
    const fixture = await setup(true);
    if (!fixture.host) throw new Error("expected_test_host");
    const workspaceId = new WorkspaceIdentityRepository(
      fixture.server.database
    ).workspaceForLegacyProject(fixture.locator.projectId);
    if (!workspaceId) throw new Error("workspace_mapping_missing");
    const access = new ProjectAccessRepository(fixture.server.database);
    access.registerProjectInternal({
      workspaceId,
      projectId: fixture.locator.projectId,
      projectRoot: fixture.workspace.root
    });
    access.registerCanvasInternal({
      workspaceId,
      projectId: fixture.locator.projectId,
      canvasId: fixture.locator.canvasId,
      packageDir: fixture.workspace.init.workspace.packageDir
    });
    const authority = new AuthorityRepository(fixture.server.database);
    const scope = {
      kind: "block" as const,
      workspaceId,
      ...fixture.locator,
      blockRef: "T-001#B-001"
    };
    authority.applyExecutionTarget({
      mutation: {
        schemaVersion: "execution-target/v1",
        scope,
        target: { kind: "exact_host", hostId: fixture.host.id },
        expectedRevision: 0
      },
      actor: { kind: "system", id: "test-system" }
    });
    const outcome = await fixture.coordinator.dispatch({
      ...fixture.locator,
      blockRef: scope.blockRef,
      idempotencyKey: "strict-authority-recheck",
      expectedResponsibilityRevision: 0,
      expectedReviewerRevision: 0,
      expectedExecutionTargetRevision: 1,
      strictAuthority: true
    });
    authority.applyReviewer({
      mutation: {
        schemaVersion: "review-assignment/v1",
        scope,
        principal: null,
        expectedRevision: 0
      },
      actor: { kind: "system", id: "test-system" }
    });

    await expect(fixture.coordinator.reenter(outcome.operation.id)).rejects.toThrow(
      "host_authorization_denied:stale_reviewer_revision"
    );
    expect(
      fixture.server.database
        .prepare("SELECT status FROM host_capacity_reservations WHERE lease_id=?")
        .get(outcome.operation.attempt.leaseId)
    ).toEqual({ status: "expired" });
  });

  it("keeps an exact workspace Host authorized through reservation and final reentry", async () => {
    const fixture = await setup(true);
    const secondWorkspaceId = "workspace-2";
    const secondLocator = { ...fixture.locator, workspaceId: secondWorkspaceId };
    new WorkspaceIdentityRepository(fixture.server.database).ensureConfiguredWorkspace(
      secondWorkspaceId
    );
    fixture.registry.bind(secondLocator, fixture.runtime);

    const access = new ProjectAccessRepository(fixture.server.database);
    access.registerProjectInternal({
      workspaceId: secondWorkspaceId,
      projectId: secondLocator.projectId,
      projectRoot: fixture.workspace.root
    });
    access.registerCanvasInternal({
      workspaceId: secondWorkspaceId,
      projectId: secondLocator.projectId,
      canvasId: secondLocator.canvasId,
      packageDir: fixture.workspace.init.workspace.packageDir
    });
    const host = fixture.hosts.register("Second Workspace Host").host;
    fixture.hosts.bindToWorkspace(host.id, secondWorkspaceId);
    fixture.hosts.reportOnline(host.id, ["acp.codex"], 1, {
      workspaceMappings: [{ workspaceId: secondWorkspaceId, status: "ready" }],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          status: "ready",
          capabilities: ["acp.codex"]
        }
      ]
    });
    const scope = {
      kind: "block" as const,
      ...secondLocator,
      blockRef: "T-001#B-001"
    };
    new AuthorityRepository(fixture.server.database).applyExecutionTarget({
      mutation: {
        schemaVersion: "execution-target/v1",
        scope,
        target: { kind: "exact_host", hostId: host.id },
        expectedRevision: 0
      },
      actor: { kind: "system", id: "test-system" }
    });

    fixture.server.database
      .prepare("DELETE FROM legacy_project_workspace_mappings WHERE legacy_project_id=?")
      .run(secondLocator.projectId);
    expect(
      new WorkspaceIdentityRepository(fixture.server.database).workspaceForLegacyProject(
        secondLocator.projectId
      )
    ).toBeUndefined();

    const outcome = await fixture.coordinator.dispatch({
      ...secondLocator,
      blockRef: scope.blockRef,
      idempotencyKey: "strict-authority-exact-workspace",
      expectedResponsibilityRevision: 0,
      expectedReviewerRevision: 0,
      expectedExecutionTargetRevision: 1,
      strictAuthority: true
    });
    expect(outcome).toMatchObject({
      status: "activated",
      operation: {
        workspaceId: secondWorkspaceId,
        attempt: { hostId: host.id }
      }
    });
    const leaseId = outcome.operation.attempt.leaseId;
    if (!leaseId) throw new Error("expected_reservation_lease");
    expect(fixture.reservations.getRequired(leaseId)).toMatchObject({
      hostId: host.id,
      status: "active"
    });
    expect(fixture.dispatches.getRequired(outcome.operation.dispatchId)).toMatchObject({
      workspaceId: secondWorkspaceId,
      hostId: host.id,
      status: "leased"
    });
    await expect(fixture.coordinator.reenter(outcome.operation.id)).resolves.toMatchObject({
      status: "activated"
    });
  });

  it("retry_new_attempt follows authority tables after execution target change (not legacy)", async () => {
    const fixture = await setup(true);
    if (!fixture.host) throw new Error("expected_test_host");
    const workspaceId = new WorkspaceIdentityRepository(
      fixture.server.database
    ).workspaceForLegacyProject(fixture.locator.projectId);
    if (!workspaceId) throw new Error("workspace_mapping_missing");
    const access = new ProjectAccessRepository(fixture.server.database);
    access.registerProjectInternal({
      workspaceId,
      projectId: fixture.locator.projectId,
      projectRoot: fixture.workspace.root
    });
    access.registerCanvasInternal({
      workspaceId,
      projectId: fixture.locator.projectId,
      canvasId: fixture.locator.canvasId,
      packageDir: fixture.workspace.init.workspace.packageDir
    });

    const hostA = fixture.host;
    const hostB = fixture.hosts.register("Authority Host B").host;
    fixture.hosts.bindToWorkspace(hostB.id, workspaceId);
    fixture.hosts.reportOnline(hostB.id, ["acp.codex"], 1, {
      workspaceMappings: [{ workspaceId, status: "ready" }],
      acpProfiles: [
        {
          profileId: "codex-acp",
          agentId: "codex",
          status: "ready",
          capabilities: ["acp.codex"]
        }
      ]
    });

    const authority = new AuthorityRepository(fixture.server.database);
    const scope = {
      kind: "block" as const,
      workspaceId,
      ...fixture.locator,
      blockRef: "T-001#B-001"
    };
    // Authority-only: no work_assignments dual-write.
    authority.applyExecutionTarget({
      mutation: {
        schemaVersion: "execution-target/v1",
        scope,
        target: { kind: "exact_host", hostId: hostA.id },
        expectedRevision: 0
      },
      actor: { kind: "system", id: "test-system" }
    });
    expect(
      fixture.server.database.prepare("SELECT COUNT(*) AS count FROM work_assignments").get() as {
        count: number;
      }
    ).toEqual({ count: 0 });

    const dispatched = await fixture.coordinator.dispatch({
      ...fixture.locator,
      blockRef: scope.blockRef,
      idempotencyKey: "retry-authority-only",
      expectedResponsibilityRevision: 0,
      expectedReviewerRevision: 0,
      expectedExecutionTargetRevision: 1,
      strictAuthority: true
    });
    expect(dispatched.operation.attempt.hostId).toBe(hostA.id);
    expect(dispatched.operation.hostSelection?.authorityRevisions).toEqual({
      responsibilityRevision: 0,
      reviewerRevision: 0,
      executionTargetRevision: 1
    });

    const dispatch = fixture.dispatches.getRequired(dispatched.operation.dispatchId);
    fixture.dispatches.accept(
      hostA.id,
      "retry-authority-accepted",
      dispatch.id,
      dispatch.leaseId,
      dispatch.executionAttemptId
    );
    fixture.dispatches.interrupt(hostA.id, "retry-authority-interrupted", {
      type: "dispatch.interrupted",
      protocolVersion: 1,
      messageId: "retry-authority-interrupted",
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId,
      executionAttemptId: dispatch.executionAttemptId,
      reason: "acp_session_lost",
      resumable: false
    });
    const lease = fixture.reservations.getRequired(dispatch.leaseId);
    fixture.reservations.release({
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expectedVersion: lease.version,
      reason: "expired"
    });
    await fixture.coordinator.reenter(dispatched.operation.id);

    // Change execution target to Host B via authority tables only (no legacy dual-write).
    authority.applyExecutionTarget({
      mutation: {
        schemaVersion: "execution-target/v1",
        scope,
        target: { kind: "exact_host", hostId: hostB.id },
        expectedRevision: 1
      },
      actor: { kind: "system", id: "test-system" }
    });

    const interrupted = fixture.operations.getRequired(dispatched.operation.id);
    await fixture.coordinator.executeAction({
      actionId: "retry-authority-only-action",
      operationId: interrupted.id,
      dispatchId: interrupted.dispatchId,
      executionAttemptId: interrupted.executionAttemptId,
      expectedAttemptVersion: interrupted.attempt.stateVersion,
      kind: "retry_new_attempt",
      priorLeaseId: dispatch.leaseId,
      newDispatchId: "dispatch-retry-authority-2",
      newExecutionAttemptId: "attempt-retry-authority-2",
      reason: "retry after authority execution target moved to Host B"
    });

    const retried = fixture.operations.getRequired(dispatched.operation.id);
    expect(retried).toMatchObject({
      state: "activated",
      dispatchId: "dispatch-retry-authority-2",
      executionAttemptId: "attempt-retry-authority-2",
      attempt: { hostId: hostB.id },
      hostSelection: {
        selection: "exact",
        preferredHostId: hostB.id,
        authorityRevisions: {
          responsibilityRevision: 0,
          reviewerRevision: 0,
          executionTargetRevision: 2
        }
      }
    });
    expect(retried.hostSelection?.preferredHostId).not.toBe(hostA.id);
    expect(
      fixture.server.database.prepare("SELECT COUNT(*) AS count FROM work_assignments").get() as {
        count: number;
      }
    ).toEqual({ count: 0 });
  });

  it("fails closed on source drift and on a missing restart locator", async () => {
    const fixture = await setup(false);
    const acquireScoped = vi.fn(() => ({
      runtime: canonicalRemoteRuntimePort(fixture.runtime, fixture.locator.workspaceId),
      artifacts: createRemoteBlockArtifactSource({ projectRoot: fixture.workspace.root }),
      release: vi.fn()
    }));
    fixture.registry.setScopedResolver(acquireScoped);
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
    expect(acquireScoped).toHaveBeenCalled();
    for (const binding of acquireScoped.mock.results) {
      expect(binding.value.release).toHaveBeenCalledOnce();
    }
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
      workspaceId: dispatch.workspaceId,
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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDistributedCoordination } from "../distributedCoordination.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];
const reportArtifactRef = `artifact:sha256:${"a".repeat(64)}`;

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function createServer(): Promise<PlanweaveServer> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "planweave-dispatch-"));
  directories.push(dataDirectory);
  const server = await startPlanweaveServer({
    dataDirectory,
    databasePath: join(dataDirectory, "server.sqlite"),
    busyTimeoutMs: 5000
  });
  servers.push(server);
  return server;
}

describe("distributed dispatch coordination", () => {
  it("selects a compatible online host and writes a completed result back", async () => {
    const server = await createServer();
    const complete = vi.fn(async () => {});
    const fail = vi.fn(async () => {});
    const coordination = createDistributedCoordination(server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete, fail }
    });
    const registration = coordination.hosts.register("Linux Builder");

    expect(registration.token).toMatch(/^pw_host_/);
    expect(coordination.hosts.authenticate(registration.host.id, registration.token)?.id).toBe(
      registration.host.id
    );
    expect(
      server.database
        .prepare("SELECT credential_hash FROM agent_hosts WHERE id=?")
        .get(registration.host.id)?.credential_hash
    ).not.toBe(registration.token);

    coordination.hosts.reportOnline(registration.host.id, ["linux", "node-22"], 2);
    const dispatch = coordination.dispatches.dispatchBlock({
      projectId: "project-a",
      blockRef: "T-001#B-001",
      packageRef: "https://packages.example.test/project-a-v1.tar.zst",
      requiredCapabilities: ["linux", "node-22"]
    });

    const messages = coordination.mailbox.listAfter(registration.host.id, 0);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.command).toMatchObject({
      type: "execute_block",
      dispatchId: dispatch.id,
      leaseId: dispatch.leaseId
    });
    expect(
      coordination.dispatches.accept(
        registration.host.id,
        "accept-1",
        dispatch.id,
        dispatch.leaseId
      ).status
    ).toBe("running");
    expect(() =>
      coordination.dispatches.accept(
        registration.host.id,
        "accept-1",
        dispatch.id,
        "different-lease"
      )
    ).toThrowError("host_event_message_id_reused");

    const previousExpiry = dispatch.leaseExpiresAt;
    const renewed = coordination.dispatches.heartbeat(registration.host.id, "heartbeat-1", [
      { dispatchId: dispatch.id, leaseId: dispatch.leaseId }
    ]);
    expect(renewed).toHaveLength(1);
    expect(renewed[0]?.leaseExpiresAt >= previousExpiry).toBe(true);

    const result = {
      summary: "Block completed.",
      reportArtifactRef,
      artifactRefs: [reportArtifactRef]
    };
    const completed = await coordination.dispatches.complete(
      registration.host.id,
      "complete-1",
      dispatch.id,
      dispatch.leaseId,
      result
    );
    expect(completed.status).toBe("completed");
    expect(complete).toHaveBeenCalledWith({
      dispatchId: dispatch.id,
      projectId: "project-a",
      blockRef: "T-001#B-001",
      packageRef: "https://packages.example.test/project-a-v1.tar.zst",
      result
    });
    expect(fail).not.toHaveBeenCalled();

    coordination.mailbox.acknowledge(
      registration.host.id,
      "ack-direct-1",
      messages[0]?.sequence ?? 0
    );
    expect(coordination.hosts.getRequired(registration.host.id).lastAcknowledgedSequence).toBe(
      messages[0]?.sequence
    );
  });

  it("keeps a result pending when runtime writeback fails and retries it", async () => {
    const server = await createServer();
    let rejectWriteback = true;
    const coordination = createDistributedCoordination(server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: {
        complete: async () => {
          if (rejectWriteback) throw new Error("runtime unavailable");
        },
        fail: async () => {}
      }
    });
    const registration = coordination.hosts.register("Recovery Host");
    coordination.hosts.reportOnline(registration.host.id, ["linux"], 1);
    const dispatch = coordination.dispatches.dispatchBlock({
      projectId: "project-a",
      blockRef: "T-001#B-002",
      packageRef: "package://project-a/v1",
      requiredCapabilities: ["linux"]
    });
    coordination.dispatches.accept(registration.host.id, "accept-2", dispatch.id, dispatch.leaseId);

    await expect(
      coordination.dispatches.complete(
        registration.host.id,
        "complete-2",
        dispatch.id,
        dispatch.leaseId,
        { summary: "Done", reportArtifactRef, artifactRefs: [] }
      )
    ).rejects.toThrowError("runtime unavailable");
    expect(coordination.dispatches.getRequired(dispatch.id).status).toBe("awaiting_writeback");

    rejectWriteback = false;
    await expect(coordination.dispatches.retryPendingWritebacks()).resolves.toMatchObject([
      { id: dispatch.id, status: "completed" }
    ]);
  });

  it("rejects mismatched leases and hosts without required capabilities", async () => {
    const server = await createServer();
    const coordination = createDistributedCoordination(server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete: async () => {}, fail: async () => {} }
    });
    const registration = coordination.hosts.register("macOS Host");
    coordination.hosts.reportOnline(registration.host.id, ["macos"], 1);

    expect(() =>
      coordination.dispatches.dispatchBlock({
        projectId: "project-a",
        blockRef: "T-001#B-003",
        packageRef: "package://project-a/v1",
        requiredCapabilities: ["linux"]
      })
    ).toThrowError("no_compatible_agent_host");

    const dispatch = coordination.dispatches.dispatchBlock({
      projectId: "project-a",
      blockRef: "T-001#B-003",
      packageRef: "package://project-a/v1",
      requiredCapabilities: ["macos"]
    });
    expect(() =>
      coordination.dispatches.accept(
        registration.host.id,
        "accept-invalid",
        dispatch.id,
        "wrong-lease"
      )
    ).toThrowError("lease_mismatch");
  });

  it("rejects late results after recovering an expired lease", async () => {
    const server = await createServer();
    const fail = vi.fn(async () => {});
    const coordination = createDistributedCoordination(server.database, {
      leaseDurationMs: 60_000,
      hostOfflineAfterMs: 60_000,
      writeback: { complete: async () => {}, fail }
    });
    const registration = coordination.hosts.register("Expiring Host");
    coordination.hosts.reportOnline(registration.host.id, ["linux"], 1);
    const dispatch = coordination.dispatches.dispatchBlock({
      projectId: "project-a",
      blockRef: "T-001#B-004",
      packageRef: "package://project-a/v1",
      requiredCapabilities: ["linux"]
    });
    coordination.dispatches.accept(
      registration.host.id,
      "accept-expiring",
      dispatch.id,
      dispatch.leaseId
    );
    server.database
      .prepare("UPDATE dispatches SET lease_expires_at=? WHERE id=?")
      .run("2020-01-01T00:00:00.000Z", dispatch.id);

    await expect(
      coordination.dispatches.recoverExpiredLeases(new Date("2020-01-01T00:00:01.000Z"))
    ).resolves.toMatchObject([{ id: dispatch.id, status: "failed" }]);
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatchId: dispatch.id,
        failure: expect.objectContaining({ code: "lease_expired", retryable: true })
      })
    );
    await expect(
      coordination.dispatches.complete(
        registration.host.id,
        "late-result",
        dispatch.id,
        dispatch.leaseId,
        { summary: "Too late", reportArtifactRef, artifactRefs: [] }
      )
    ).rejects.toThrowError("lease_expired");
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostReservationRepository } from "../hostReservations.js";
import { AgentHostRepository } from "../hosts.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { RemoteOperationRepository } from "../remoteOperations.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup(): Promise<PlanweaveServer> {
  const directory = await mkdtemp(join(tmpdir(), "planweave-host-reservation-"));
  directories.push(directory);
  const server = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  servers.push(server);
  return server;
}

function createOperation(
  repository: RemoteOperationRepository,
  suffix: string,
  capabilities = ["linux"]
) {
  const operation = repository.create({
    projectId: "project-a",
    canvasId: "default",
    blockRef: `RC-002#${suffix}`,
    ownershipGeneration: "generation-1",
    idempotencyKey: `request-${suffix}`,
    sourceFingerprint: `fingerprint-${suffix}`,
    requiredCapabilities: capabilities
  });
  return repository.markClaimed(operation.id);
}

describe("HostReservationRepository", () => {
  it("selects deterministically under capacity and prevents a capacity race", async () => {
    const server = await setup();
    const hosts = new AgentHostRepository(server.database);
    const first = hosts.register("First").host;
    const second = hosts.register("Second").host;
    hosts.reportOnline(first.id, ["linux"], 1);
    hosts.reportOnline(second.id, ["linux"], 1);
    server.database
      .prepare("UPDATE agent_hosts SET last_seen_at=? WHERE id IN (?,?)")
      .run("2030-01-01T00:00:00.000Z", first.id, second.id);
    const operations = new RemoteOperationRepository(server.database);
    const reservations = new HostReservationRepository(server.database, {
      hostOfflineAfterMs: 60_000,
      leaseDurationMs: 60_000
    });

    const reservedA = reservations.reserve(createOperation(operations, "B-001").id);
    const reservedB = reservations.reserve(createOperation(operations, "B-002").id);
    expect([reservedA.hostId, reservedB.hostId]).toEqual([first.id, second.id].sort());
    expect(() => reservations.reserve(createOperation(operations, "B-003").id)).toThrowError(
      "no_compatible_agent_host"
    );
  });

  it("rejects offline, revoked, and incompatible Hosts", async () => {
    const server = await setup();
    let now = new Date("2030-01-01T00:00:00.000Z");
    const hosts = new AgentHostRepository(server.database, () => now);
    const offline = hosts.register("Offline").host;
    hosts.reportOnline(offline.id, ["linux"], 1);
    now = new Date("2030-01-01T00:02:00.000Z");
    const revoked = hosts.register("Revoked").host;
    hosts.reportOnline(revoked.id, ["linux"], 1);
    hosts.revoke(revoked.id);
    const incompatible = hosts.register("Incompatible").host;
    hosts.reportOnline(incompatible.id, ["macos"], 1);
    const operations = new RemoteOperationRepository(server.database, () => now);
    const reservations = new HostReservationRepository(server.database, {
      clock: () => now,
      hostOfflineAfterMs: 60_000,
      leaseDurationMs: 60_000
    });

    expect(() => reservations.reserve(createOperation(operations, "B-004").id)).toThrowError(
      "no_compatible_agent_host"
    );
  });

  it("releases capacity only with the current fence and preserves interrupted attempt uniqueness", async () => {
    const server = await setup();
    const hosts = new AgentHostRepository(server.database);
    const host = hosts.register("Only Host").host;
    hosts.reportOnline(host.id, ["linux"], 1);
    const operations = new RemoteOperationRepository(server.database);
    const reservations = new HostReservationRepository(server.database, {
      hostOfflineAfterMs: 60_000,
      leaseDurationMs: 60_000
    });
    const first = createOperation(operations, "B-005");
    const lease = reservations.reserve(first.id);
    const activated = reservations.transition({
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expectedAttemptVersion: 1,
      status: "activated"
    });
    const running = reservations.transition({
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expectedAttemptVersion: activated.attempt.stateVersion,
      status: "running"
    });
    expect(running.attempt.status).toBe("running");

    expect(() =>
      reservations.release({
        leaseId: lease.leaseId,
        fencingToken: lease.fencingToken + 1,
        expectedVersion: lease.version,
        reason: "expired"
      })
    ).toThrowError("reservation_fence_conflict");
    const released = reservations.release({
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expectedVersion: lease.version,
      reason: "expired"
    });
    expect(released.status).toBe("expired");
    expect(operations.getRequired(first.id).attempt.status).toBe("interrupted");
    expect(
      server.database
        .prepare("SELECT type FROM remote_operation_events WHERE operation_id=? ORDER BY sequence")
        .all(first.id)
        .map((row) => row.type)
    ).toEqual([
      "remote.operation.created",
      "remote.operation.claimed",
      "remote.attempt.reserved",
      "remote.attempt.activated",
      "remote.attempt.running",
      "remote.attempt.interrupted",
      "remote.reservation.expired"
    ]);

    expect(() =>
      reservations.reserve(
        operations.create({
          projectId: first.projectId,
          canvasId: first.canvasId,
          blockRef: first.blockRef,
          ownershipGeneration: first.ownershipGeneration,
          idempotencyKey: "another-request",
          sourceFingerprint: first.sourceFingerprint,
          requiredCapabilities: first.requiredCapabilities
        }).id
      )
    ).toThrowError("remote_active_attempt_conflict");
  });
});

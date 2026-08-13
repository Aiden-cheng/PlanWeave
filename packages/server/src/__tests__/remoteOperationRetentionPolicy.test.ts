import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHostRepository } from "../hosts.js";
import { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { startPlanweaveServer, type PlanweaveServer } from "../lifecycle.js";
import { RemoteOperationRepository } from "../remoteOperations.js";
import {
  REMOTE_OPERATION_RETENTION_BATCH_SIZE,
  REMOTE_OPERATION_RETENTION_FULL_PER_SCOPE,
  REMOTE_OPERATION_RETENTION_MAX_AGE_MS,
  RemoteOperationRetention
} from "../remoteOperationRetention.js";

const directories: string[] = [];
const servers: PlanweaveServer[] = [];
const oldTime = "2029-01-01T00:00:00.000Z";

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-remote-retention-policy-"));
  directories.push(directory);
  const server = await startPlanweaveServer({
    dataDirectory: directory,
    databasePath: join(directory, "server.sqlite"),
    busyTimeoutMs: 5_000
  });
  servers.push(server);
  const hostId = new AgentHostRepository(server.database, () => new Date(oldTime)).register(
    "Retention Policy Host"
  ).host.id;
  const workspaceId = new WorkspaceIdentityRepository(
    server.database
  ).ensureWorkspaceForLegacyProject("project-retention-policy");
  return { server, hostId, workspaceId };
}

function seedTerminal(
  fixture: Awaited<ReturnType<typeof setup>>,
  suffix: string,
  canvasId = "default"
) {
  const operations = new RemoteOperationRepository(
    fixture.server.database,
    () => new Date(oldTime)
  );
  const operation = operations.create({
    workspaceId: fixture.workspaceId,
    projectId: "project-retention-policy",
    canvasId,
    blockRef: `T-001#B-${suffix}`,
    ownershipGeneration: `generation-${suffix}`,
    idempotencyKey: `retention-${suffix}`,
    sourceFingerprint: `fingerprint-${suffix}`,
    requiredCapabilities: ["acp.codex"]
  });
  const leaseId = `lease-${suffix}`;
  fixture.server.database
    .prepare(
      `UPDATE remote_execution_attempts
       SET status='completed',host_id=?,lease_id=?,lease_fencing_token=1,lease_expires_at=?,
         state_version=1,updated_at=?,terminal_at=? WHERE execution_attempt_id=?`
    )
    .run(fixture.hostId, leaseId, oldTime, oldTime, oldTime, operation.executionAttemptId);
  fixture.server.database
    .prepare("UPDATE remote_operations SET state='completed',updated_at=?,terminal_at=? WHERE id=?")
    .run(oldTime, oldTime, operation.id);
  fixture.server.database
    .prepare(
      `INSERT INTO dispatches(
        id,workspace_id,project_id,block_ref,host_id,required_capabilities_json,status,
        lease_id,execution_attempt_id,lease_expires_at,created_at,finished_at
      ) VALUES (?,?,?,?,?,?,'completed',?,?,?,?,?)`
    )
    .run(
      operation.dispatchId,
      fixture.workspaceId,
      operation.projectId,
      operation.blockRef,
      fixture.hostId,
      JSON.stringify(operation.requiredCapabilities),
      leaseId,
      operation.executionAttemptId,
      oldTime,
      oldTime,
      oldTime
    );
  return operation;
}

describe("remote operation retention policy", () => {
  it("keeps the default count and age windows per exact scope and bounds each batch", async () => {
    expect(REMOTE_OPERATION_RETENTION_FULL_PER_SCOPE).toBe(100);
    expect(REMOTE_OPERATION_RETENTION_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1_000);
    expect(REMOTE_OPERATION_RETENTION_BATCH_SIZE).toBe(25);
    const fixture = await setup();
    const oldDefaultScope = Array.from({ length: 126 }, (_, index) =>
      seedTerminal(fixture, `default-${String(index).padStart(3, "0")}`)
    );
    const otherScope = seedTerminal(fixture, "other-000", "other");
    const recentOutsideCount = seedTerminal(fixture, "recent-000");
    fixture.server.database
      .prepare("UPDATE remote_operations SET terminal_at=? WHERE id=?")
      .run("2029-12-20T00:00:00.000Z", recentOutsideCount.id);

    const retention = new RemoteOperationRetention(
      fixture.server.database,
      () => new Date("2030-01-01T00:00:00.000Z")
    );
    expect(retention.compactBatch()).toEqual({ selected: 25, compacted: 25, skipped: 0 });
    expect(oldDefaultScope.filter((operation) => retention.getReceipt(operation.id))).toHaveLength(
      25
    );
    expect(retention.getReceipt(otherScope.id)).toBeUndefined();
    expect(retention.getReceipt(recentOutsideCount.id)).toBeUndefined();
  });

  it("converges past twenty-five ineligible operations to the next eligible operation", async () => {
    const fixture = await setup();
    const blocked = Array.from({ length: 25 }, (_, index) =>
      seedTerminal(fixture, `blocked-${String(index).padStart(2, "0")}`)
    );
    for (const [index, operation] of blocked.entries()) {
      fixture.server.database
        .prepare("UPDATE remote_operations SET terminal_at=? WHERE id=?")
        .run(`2028-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`, operation.id);
      fixture.server.database
        .prepare("UPDATE dispatches SET status='awaiting_writeback' WHERE id=?")
        .run(operation.dispatchId);
    }
    const eligible = seedTerminal(fixture, "eligible-26");
    const retention = new RemoteOperationRetention(
      fixture.server.database,
      () => new Date("2030-01-01T00:00:00.000Z"),
      0,
      1,
      1
    );

    expect(retention.compactBatch()).toEqual({ selected: 1, compacted: 1, skipped: 0 });
    expect(retention.getReceipt(eligible.id)?.operationId).toBe(eligible.id);
    expect(retention.compactBatch()).toEqual({ selected: 0, compacted: 0, skipped: 0 });
    expect(blocked.every((operation) => retention.getReceipt(operation.id) === undefined)).toBe(
      true
    );
  });

  it.each([
    ["missing dispatch", "missing"],
    ["attempt identity mismatch", "attempt"],
    ["dispatch scope mismatch", "scope"]
  ])("fails closed for %s", async (_label, mismatch) => {
    const fixture = await setup();
    const operation = seedTerminal(fixture, `mismatch-${mismatch}`);
    if (mismatch === "missing") {
      fixture.server.database
        .prepare("DELETE FROM dispatches WHERE id=?")
        .run(operation.dispatchId);
    } else if (mismatch === "attempt") {
      fixture.server.database
        .prepare("UPDATE dispatches SET execution_attempt_id=? WHERE id=?")
        .run("attempt-mismatched", operation.dispatchId);
    } else {
      fixture.server.database
        .prepare("UPDATE dispatches SET workspace_id=? WHERE id=?")
        .run("workspace-mismatched", operation.dispatchId);
    }
    const retention = new RemoteOperationRetention(
      fixture.server.database,
      () => new Date("2030-01-01T00:00:00.000Z"),
      0,
      1,
      25
    );

    expect(retention.compactBatch()).toEqual({ selected: 0, compacted: 0, skipped: 0 });
    expect(retention.getReceipt(operation.id)).toBeUndefined();
  });
});

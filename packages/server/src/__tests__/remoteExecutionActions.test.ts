import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RemoteExecutionActionRepository,
  RemoteExecutionActionService
} from "../remoteExecutionActions.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const directories: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-remote-actions-"));
  directories.push(directory);
  const database = await openServerDatabase(join(directory, "server.sqlite"), 5_000);
  databases.push(database);
  database.exec(`
    CREATE TABLE remote_execution_actions(
      action_id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL,
      dispatch_id TEXT NOT NULL,
      execution_attempt_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      request_json TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      acknowledged_at TEXT,
      settled_at TEXT
    );
  `);
  let now = Date.parse("2030-01-01T00:00:00.000Z");
  return {
    repository: new RemoteExecutionActionRepository(database, () => new Date(now++)),
    database
  };
}

const cancelAction = {
  actionId: "action-1",
  operationId: "operation-1",
  dispatchId: "dispatch-1",
  executionAttemptId: "attempt-1",
  expectedAttemptVersion: 2,
  kind: "cancel",
  leaseId: "lease-1",
  reason: "operator requested cancellation"
} as const;

describe("RemoteExecutionActionRepository", () => {
  it("replays an identical action and rejects an action-id payload conflict", async () => {
    const { repository } = await setup();
    const recorded = repository.record(cancelAction);
    expect(repository.record(cancelAction)).toEqual(recorded);
    expect(recorded).toMatchObject({ state: "recorded", request: cancelAction });
    expect(() =>
      repository.record({ ...cancelAction, reason: "a conflicting reason" })
    ).toThrowError("remote_action_idempotency_conflict");
  });

  it("persists each delivery phase and replays identical transitions", async () => {
    const { repository } = await setup();
    repository.record(cancelAction);
    const delivered = repository.transition(cancelAction.actionId, "delivered");
    expect(repository.transition(cancelAction.actionId, "delivered")).toEqual(delivered);
    const acknowledged = repository.transition(cancelAction.actionId, "acknowledged");
    const settled = repository.transition(cancelAction.actionId, "settled");
    expect(acknowledged.acknowledgedAt).toBeDefined();
    expect(settled).toMatchObject({ state: "settled" });
    expect(settled.settledAt).toBeDefined();
    expect(repository.listUnsettled()).toEqual([]);
  });

  it("advances command actions from mailbox acknowledgement to attempt settlement", async () => {
    const { repository } = await setup();
    repository.record(cancelAction);
    expect(repository.acknowledgeMailbox(cancelAction.actionId)).toMatchObject({
      state: "acknowledged"
    });
    expect(
      repository.settleAttemptCommands({
        dispatchId: cancelAction.dispatchId,
        executionAttemptId: cancelAction.executionAttemptId,
        kinds: ["cancel"]
      })
    ).toMatchObject([{ state: "settled" }]);
    expect(repository.listUnsettled()).toEqual([]);
  });

  it("recovers an application effect before stale snapshot validation", async () => {
    const { repository } = await setup();
    let snapshots = 0;
    const service = new RemoteExecutionActionService(repository, {
      recover: () => "settled",
      snapshot: () => {
        snapshots += 1;
        throw new Error("stale_snapshot_must_not_be_read");
      },
      apply: () => {
        throw new Error("effect_must_not_be_reapplied");
      }
    });
    await expect(service.execute(cancelAction)).resolves.toMatchObject({ state: "settled" });
    expect(snapshots).toBe(0);
  });

  it("fails closed on invalid transition and persisted payload tampering", async () => {
    const { repository, database } = await setup();
    repository.record(cancelAction);
    expect(() => repository.transition(cancelAction.actionId, "acknowledged")).toThrowError(
      "remote_action_state_transition_invalid"
    );
    database
      .prepare("UPDATE remote_execution_actions SET request_json=? WHERE action_id=?")
      .run(JSON.stringify({ ...cancelAction, leaseId: "lease-foreign" }), cancelAction.actionId);
    expect(() => repository.getRequired(cancelAction.actionId)).toThrowError(
      "remote_action_row_payload_mismatch"
    );
  });

  it("persists an exact action before invoking its application side effect", async () => {
    const { repository, database } = await setup();
    const applied: string[] = [];
    const service = new RemoteExecutionActionService(repository, {
      snapshot: (request) => ({
        operationId: request.operationId,
        dispatchId: request.dispatchId,
        executionAttemptId: request.executionAttemptId,
        attemptStatus: "running",
        attemptVersion: request.expectedAttemptVersion,
        leaseId: request.kind === "cancel" ? request.leaseId : undefined,
        leaseFenced: false,
        hostCapabilities: []
      }),
      apply: (request, decision) => {
        expect(
          database
            .prepare("SELECT state FROM remote_execution_actions WHERE action_id=?")
            .get(request.actionId)?.state
        ).toBe("recorded");
        expect(decision).toEqual({ transition: "cancel", sendsCommand: true });
        applied.push(request.actionId);
        return "delivered";
      }
    });

    await expect(service.execute(cancelAction)).resolves.toMatchObject({ state: "delivered" });
    await expect(service.execute(cancelAction)).resolves.toMatchObject({ state: "delivered" });
    expect(applied).toEqual([cancelAction.actionId]);
  });
});

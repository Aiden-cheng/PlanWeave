import { describe, expect, it } from "vitest";
import { remoteBlockExecutionReadModelSchema } from "../schema/remoteExecutionReadModel.js";
import { projectRemoteBlockExecution } from "../taskManager/remoteExecutionReadModel.js";
import type { BlockState } from "../types.js";

const source = {
  operationId: "operation-001",
  controlPlane: "owner" as const,
  sourceRevision: "revision-001",
  graphFingerprint: "fingerprint-001"
};

const dispatchAttempt = {
  dispatchId: "dispatch-001",
  executionAttemptId: "attempt-001"
};

function project(state: BlockState) {
  const result = projectRemoteBlockExecution(state);
  expect(result).not.toBeNull();
  return remoteBlockExecutionReadModelSchema.parse(result);
}

describe("remote execution read model", () => {
  it("projects preparing and active ownership without infrastructure details", () => {
    expect(
      project({ status: "in_progress", remoteOwnership: { phase: "preparing", ...source } })
    ).toEqual({
      identity: { operationId: "operation-001" },
      controlPlane: "owner",
      phase: "preparing",
      status: "owned",
      actionRequired: false,
      source: { revision: "revision-001", graphFingerprint: "fingerprint-001" },
      dispatchAttempt: null
    });

    const active = project({
      status: "in_progress",
      remoteOwnership: { phase: "active", ...source, ...dispatchAttempt }
    });
    expect(active).toMatchObject({
      controlPlane: "owner",
      phase: "active",
      status: "owned",
      actionRequired: false,
      dispatchAttempt
    });
    expect(JSON.stringify(active)).not.toMatch(/host|lease|credential|url|path|database/i);
  });

  it("marks interruption and source drift as action-required", () => {
    expect(
      project({
        status: "diverged",
        remoteOwnership: { phase: "active", ...source, ...dispatchAttempt },
        remoteInterruption: { reason: "transport_lost", resumable: true }
      })
    ).toMatchObject({ controlPlane: "owner", status: "interrupted", actionRequired: true });

    expect(
      project({
        status: "diverged",
        remoteOwnership: { phase: "active", ...source, ...dispatchAttempt }
      })
    ).toMatchObject({ controlPlane: "owner", status: "source_drift", actionRequired: true });
  });

  it("projects completed and failed terminal receipts with fixed action semantics", () => {
    expect(
      project({
        status: "completed",
        lastRunId: "RUN-001",
        remoteOperationReceipt: {
          outcome: "completed",
          ...source,
          ...dispatchAttempt,
          runId: "RUN-001"
        }
      })
    ).toMatchObject({
      controlPlane: "owner",
      phase: "terminal",
      status: "completed",
      actionRequired: false
    });

    expect(
      project({
        status: "blocked",
        remoteOperationReceipt: {
          outcome: "failed",
          ...source,
          ...dispatchAttempt,
          failure: { code: "executor_failed", message: "Public failure.", retryable: false }
        }
      })
    ).toMatchObject({
      controlPlane: "owner",
      phase: "terminal",
      status: "failed",
      actionRequired: true
    });
  });

  it("returns null for local execution state", () => {
    expect(projectRemoteBlockExecution({ status: "in_progress" })).toBeNull();
  });

  it("reads legacy remote ownership without a control-plane field as collaboration", () => {
    expect(
      project({
        status: "in_progress",
        remoteOwnership: {
          phase: "preparing",
          operationId: source.operationId,
          sourceRevision: source.sourceRevision,
          graphFingerprint: source.graphFingerprint
        }
      })
    ).toMatchObject({ controlPlane: "collaboration", status: "owned" });
  });

  it.each([
    "/tmp/workspace",
    "https://server.example",
    "has space"
  ])("rejects non-logical public identity %s", (operationId) => {
    expect(
      remoteBlockExecutionReadModelSchema.safeParse({
        identity: { operationId },
        controlPlane: "owner",
        phase: "preparing",
        status: "owned",
        actionRequired: false,
        source: { revision: "revision-001", graphFingerprint: "fingerprint-001" },
        dispatchAttempt: null
      }).success
    ).toBe(false);
  });
});

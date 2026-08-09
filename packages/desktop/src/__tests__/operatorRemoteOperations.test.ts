import { describe, expect, it } from "vitest";
import { operatorObservationToRemoteRun } from "../main/operatorControl/operatorRemoteOperations.js";

describe("operatorRemoteOperations", () => {
  it("maps operator operation view to remote-run observation", () => {
    const observation = operatorObservationToRemoteRun({
      operationId: "operation-1",
      projectId: "project-a",
      canvasId: "canvas-main",
      blockRef: "T-001#B-001",
      state: "running",
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      createdAt: "2026-08-03T08:00:00.000Z",
      updatedAt: "2026-08-03T08:00:01.000Z",
      attempt: {
        executionAttemptId: "attempt-1",
        dispatchId: "dispatch-1",
        status: "running",
        stateVersion: 1
      },
      runtime: {
        ref: "T-001#B-001",
        status: "in_progress",
        ownership: {
          phase: "active",
          operationId: "operation-1",
          sourceRevision: "source-revision-1",
          graphFingerprint: "graph-fingerprint-1",
          dispatchId: "dispatch-1",
          executionAttemptId: "attempt-1"
        }
      },
      agentEndpoint: {
        schemaVersion: "agent-endpoint/v1",
        endpointId: "aep_test",
        agentId: "codex",
        profileId: "codex-acp",
        displayName: "Codex",
        hostDisplayName: "Fleet Host",
        status: "available",
        capabilities: ["acp.codex"],
        resolvedAt: "2026-08-03T08:00:00.000Z"
      }
    });
    expect(observation.operationId).toBe("operation-1");
    expect(observation.agentEndpoint?.endpointId).toBe("aep_test");
    expect(observation.runtime.ownership).toEqual({
      operationId: "operation-1",
      phase: "active",
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1"
    });
  });

  it("projects terminal Runtime receipts without leaking internal source identities", () => {
    const observation = operatorObservationToRemoteRun({
      operationId: "operation-2",
      projectId: "project-a",
      canvasId: "canvas-main",
      blockRef: "T-001#B-001",
      state: "completed",
      dispatchId: "dispatch-2",
      executionAttemptId: "attempt-2",
      createdAt: "2026-08-03T08:00:00.000Z",
      updatedAt: "2026-08-03T08:00:01.000Z",
      terminalAt: "2026-08-03T08:00:01.000Z",
      attempt: {
        executionAttemptId: "attempt-2",
        dispatchId: "dispatch-2",
        status: "completed",
        stateVersion: 2
      },
      runtime: {
        ref: "T-001#B-001",
        status: "completed",
        terminalReceipt: {
          outcome: "completed",
          operationId: "operation-2",
          sourceRevision: "source-revision-2",
          graphFingerprint: "graph-fingerprint-2",
          dispatchId: "dispatch-2",
          executionAttemptId: "attempt-2",
          runId: "run-2",
          blockType: "implementation"
        }
      }
    });

    expect(observation.runtime.terminalReceipt).toEqual({
      operationId: "operation-2",
      outcome: "completed"
    });
  });
});

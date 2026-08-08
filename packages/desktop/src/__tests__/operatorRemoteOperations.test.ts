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
        status: "in_progress"
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
  });
});

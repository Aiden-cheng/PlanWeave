import { describe, expect, it } from "vitest";
import {
  remoteDispatchIntentSchema,
  remoteDispatchIntentV3Schema,
  remoteDispatchVersionedIntentSchema,
  remoteEndpointOperationObservationSchema,
  remoteOperationObservationSchema
} from "../remoteRun.js";

const v3 = {
  schemaVersion: "remote-run/v3" as const,
  projectId: "project-a",
  canvasId: "default",
  blockRef: "T-001#B-001",
  agentEndpointId: "aep_endpoint",
  idempotencyKey: "dispatch-once",
  expectedResponsibilityRevision: 3,
  expectedReviewerRevision: 2
};

describe("remote-run/v3 dispatch contract", () => {
  it("accepts only the endpoint-scoped authority fields", () => {
    expect(remoteDispatchIntentV3Schema.parse(v3)).toEqual(v3);
    for (const forbidden of [
      { hostId: "host-a" },
      { executionTarget: { kind: "exact_host", hostId: "host-a" } },
      { expectedExecutionTargetRevision: 1 },
      { unknown: true }
    ]) {
      expect(() => remoteDispatchIntentV3Schema.parse({ ...v3, ...forbidden })).toThrow();
    }
  });

  it("rejects endpoint observations that mix in an internal Host ID", () => {
    const endpointObservation = {
      operationId: "operation-1",
      projectId: "project-a",
      canvasId: "default",
      blockRef: "T-001#B-001",
      state: "running" as const,
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:01:00.000Z",
      attempt: {
        executionAttemptId: "attempt-1",
        dispatchId: "dispatch-1",
        status: "running" as const,
        leaseId: "lease-1",
        stateVersion: 1
      },
      agentEndpoint: {
        schemaVersion: "agent-endpoint/v1" as const,
        endpointId: "endpoint-1",
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        hostDisplayName: "Build Mac",
        capabilities: ["acp.codex"],
        status: "available" as const,
        resolvedAt: "2030-01-01T00:00:00.000Z"
      },
      runtime: { ref: "T-001#B-001", status: "in_progress" }
    };
    expect(remoteEndpointOperationObservationSchema.parse(endpointObservation)).toEqual(
      endpointObservation
    );
    expect(() =>
      remoteOperationObservationSchema.parse({
        ...endpointObservation,
        attempt: { ...endpointObservation.attempt, hostId: "host-internal" }
      })
    ).toThrowError("endpoint_observation_must_redact_host_id");
  });

  it("keeps v2 strict and independently parseable", () => {
    const v2 = {
      schemaVersion: "remote-run/v2" as const,
      projectId: "project-a",
      canvasId: "default",
      blockRef: "T-001#B-001",
      idempotencyKey: "legacy-dispatch",
      expectedResponsibilityRevision: 3,
      expectedReviewerRevision: 2,
      expectedExecutionTargetRevision: 4
    };
    expect(remoteDispatchIntentSchema.parse(v2)).toEqual(v2);
    expect(remoteDispatchVersionedIntentSchema.parse(v2)).toEqual(v2);
    expect(remoteDispatchVersionedIntentSchema.parse(v3)).toEqual(v3);
    expect(() => remoteDispatchIntentSchema.parse(v3)).toThrow();
  });
});

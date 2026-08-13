import { describe, expect, it } from "vitest";
import {
  auditRows,
  canonicalJson,
  parseRetentionSummary,
  retentionDigest,
  serializeRetentionSummary,
  type RemoteOperationRetentionSummary
} from "../remoteOperationRetentionReceipt.js";

const emptyDigest = auditRows([]).digest;

function summary(): RemoteOperationRetentionSummary {
  return {
    version: "remote-operation-retention-receipt/v1",
    scope: { workspaceId: "workspace", projectId: "project", canvasId: "canvas" },
    operation: {
      operationId: "operation",
      terminalState: "completed",
      terminalAt: "2030-01-01T00:00:00.000Z",
      executionAttemptId: "attempt",
      dispatchId: "dispatch",
      envelopeDigest: null
    },
    attempts: [
      {
        executionAttemptId: "attempt",
        dispatchId: "dispatch",
        status: "completed",
        terminalAt: "2030-01-01T00:00:00.000Z",
        dispatchStatus: "completed",
        finishedAt: "2030-01-01T00:00:00.000Z",
        resultReferences: null,
        resultDigest: null,
        failureCode: null,
        failureDigest: null
      }
    ],
    streams: {
      operationEvents: { count: 0, digest: emptyDigest },
      candidates: { count: 0, digest: emptyDigest },
      actions: { count: 0, digest: emptyDigest },
      interactions: { count: 0, digest: emptyDigest },
      reservations: { count: 0, digest: emptyDigest },
      acpStreams: { count: 0, digest: emptyDigest },
      acpEvents: { count: 0, digest: emptyDigest },
      historicalAttempts: { count: 0, digest: emptyDigest },
      historicalDispatches: { count: 0, digest: emptyDigest },
      historicalDispatchEvents: { count: 0, digest: emptyDigest },
      historicalDispatchEnvelopes: { count: 0, digest: emptyDigest },
      historicalArtifactGrants: { count: 0, digest: emptyDigest },
      historicalArtifactLinks: { count: 0, digest: emptyDigest }
    },
    historicalArtifactProvenance: []
  };
}

describe("remote operation retention receipt", () => {
  it("canonicalizes object keys and row ordering", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(auditRows([{ id: "second" }, { id: "first" }])).toEqual(
      auditRows([{ id: "first" }, { id: "second" }])
    );
  });

  it("changes a category and overall digest when deleted content changes", () => {
    const first = summary();
    const second = summary();
    first.streams.operationEvents = auditRows([{ type: "remote.attempt.completed" }]);
    second.streams.operationEvents = auditRows([{ type: "remote.attempt.failed" }]);

    expect(first.streams.operationEvents.digest).not.toBe(second.streams.operationEvents.digest);
    expect(serializeRetentionSummary(first).digest).not.toBe(
      serializeRetentionSummary(second).digest
    );
  });

  it("rejects a schema-invalid summary even when its digest is recomputed", () => {
    const json = canonicalJson({ ...summary(), version: "tampered" });
    expect(retentionDigest(json)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => parseRetentionSummary(json)).toThrow();
  });
});

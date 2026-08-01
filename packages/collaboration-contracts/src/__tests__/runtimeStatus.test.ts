import { describe, expect, it } from "vitest";
import { canvasRuntimeStatusProjectionSchema } from "../runtimeStatus.js";

describe("canvas runtime status projection", () => {
  it("accepts only the redacted task and block execution state needed by replicas", () => {
    const parsed = canvasRuntimeStatusProjectionSchema.parse({
      schemaVersion: "canvas-runtime-status/v1",
      scope: {
        workspaceId: "workspace-1",
        projectId: "project-1",
        canvasId: "default"
      },
      packageFingerprint: `pkg-${"a".repeat(64)}`,
      capturedAt: "2026-08-01T00:00:00.000Z",
      tasks: [{ taskId: "T-001", status: "implemented", openFeedbackCount: 0 }],
      blocks: [
        {
          ref: "T-001#B-001",
          status: "completed",
          completionReason: null,
          blockedReason: null,
          divergenceReason: null
        }
      ]
    });

    expect(parsed.tasks[0]?.status).toBe("implemented");
    expect(parsed.blocks[0]).not.toHaveProperty("lastRunId");
    expect(parsed.blocks[0]).not.toHaveProperty("remoteOwnership");
  });

  it("rejects duplicate task and block identities", () => {
    const base = {
      schemaVersion: "canvas-runtime-status/v1" as const,
      scope: { workspaceId: "workspace-1", projectId: "project-1", canvasId: "default" },
      packageFingerprint: `pkg-${"a".repeat(64)}`,
      capturedAt: "2026-08-01T00:00:00.000Z"
    };
    expect(() =>
      canvasRuntimeStatusProjectionSchema.parse({
        ...base,
        tasks: [
          { taskId: "T-001", status: "ready", openFeedbackCount: 0 },
          { taskId: "T-001", status: "implemented", openFeedbackCount: 0 }
        ],
        blocks: []
      })
    ).toThrow();
    expect(() =>
      canvasRuntimeStatusProjectionSchema.parse({
        ...base,
        tasks: [],
        blocks: [
          {
            ref: "T-001#B-001",
            status: "ready",
            completionReason: null,
            blockedReason: null,
            divergenceReason: null
          },
          {
            ref: "T-001#B-001",
            status: "completed",
            completionReason: null,
            blockedReason: null,
            divergenceReason: null
          }
        ]
      })
    ).toThrow();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { CanvasRuntimeStatusProjection } from "@planweave-ai/collaboration-protocol/canvas/status";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import {
  isAgentEndpointScopeExecutableBlock,
  runAgentEndpointScope
} from "../renderer/collaboration/agentEndpointScopeRun";

const graphTasks: DesktopGraphViewModel["tasks"] = [
  {
    taskId: "T-001",
    title: "Task",
    status: "in_progress",
    executor: "codex",
    executorLabel: "codex",
    promptMarkdown: "# Task",
    promptMissing: false,
    promptPreview: "Task",
    sharedResources: [],
    blocks: [
      {
        ref: "T-001#B-001",
        blockId: "B-001",
        type: "implementation",
        title: "Implement",
        status: "completed",
        executor: null,
        requiredCapabilities: ["acp.codex"],
        promptMissing: false,
        exceptionReason: null,
        dispatchable: false,
        remoteExecution: null
      },
      {
        ref: "T-001#R-001",
        blockId: "R-001",
        type: "review",
        title: "Review",
        status: "ready",
        executor: null,
        requiredCapabilities: ["acp.codex"],
        promptMissing: false,
        exceptionReason: null,
        dispatchable: false,
        remoteExecution: null
      }
    ],
    blockPreview: [],
    hiddenBlockRefs: [],
    overflowBlockCount: 0,
    exceptions: []
  }
];

function statusAfterImplementation(): CanvasRuntimeStatusProjection {
  return {
    schemaVersion: "canvas-runtime-status/v2",
    scope: {
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "canvas-main"
    },
    packageFingerprint: `pkg-${"a".repeat(64)}`,
    capturedAt: "2030-01-01T00:00:00.000Z",
    tasks: [{ taskId: "T-001", status: "in_progress", openFeedbackCount: 0 }],
    blocks: [
      {
        ref: "T-001#B-001",
        status: "completed",
        completionReason: null,
        blockedReason: null,
        divergenceReason: null,
        dispatchable: false
      },
      {
        ref: "T-001#R-001",
        status: "ready",
        completionReason: null,
        blockedReason: null,
        divergenceReason: null,
        // Runtime never marks review gates dispatchable (implementation-only flag).
        dispatchable: false
      }
    ]
  };
}

describe("agent endpoint scope run", () => {
  it("treats ready review blocks as executable even when dispatchable is false", () => {
    const review = statusAfterImplementation().blocks[1]!;
    expect(
      isAgentEndpointScopeExecutableBlock({ type: "review" }, review)
    ).toBe(true);
    expect(
      isAgentEndpointScopeExecutableBlock({ type: "implementation" }, review)
    ).toBe(false);
  });

  it("continues from completed implementation into the ready review gate", async () => {
    let phase: "after_impl" | "after_review" = "after_impl";
    const executeBlock = vi.fn(async (_task, block) => {
      expect(block.ref).toBe("T-001#R-001");
      phase = "after_review";
    });
    const readRuntimeStatus = vi.fn(async () => {
      if (phase === "after_impl") return statusAfterImplementation();
      return {
        ...statusAfterImplementation(),
        tasks: [{ taskId: "T-001", status: "implemented", openFeedbackCount: 0 }],
        blocks: statusAfterImplementation().blocks.map((block) =>
          block.ref === "T-001#R-001"
            ? { ...block, status: "completed" as const, completionReason: "passed" as const }
            : block
        )
      };
    });

    await runAgentEndpointScope({
      tasks: graphTasks,
      readRuntimeStatus,
      executeBlock
    });

    expect(executeBlock).toHaveBeenCalledTimes(1);
    expect(executeBlock.mock.calls[0]?.[1]?.ref).toBe("T-001#R-001");
  });

  it("surfaces per-block diagnostics when nothing is executable", async () => {
    await expect(
      runAgentEndpointScope({
        tasks: graphTasks,
        readRuntimeStatus: async () => ({
          ...statusAfterImplementation(),
          blocks: statusAfterImplementation().blocks.map((block) =>
            block.ref === "T-001#R-001" ? { ...block, status: "planned" as const } : block
          )
        }),
        executeBlock: vi.fn()
      })
    ).rejects.toThrow(/agent_endpoint_scope_has_no_dispatchable_block.*T-001#R-001/);
  });
});

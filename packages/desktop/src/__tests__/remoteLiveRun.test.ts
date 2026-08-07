import { describe, expect, it } from "vitest";
import {
  agentFamilyFromExecutorName,
  diskSelectedRecordId,
  isRemoteLiveRecordId,
  remoteLiveRecordId,
  withRemoteLiveTimelineRuns
} from "../renderer/task-workspace/remoteLiveRun";
import {
  timelineBlockFixture,
  timelineRunFixture,
  timelineWorkspaceFixture
} from "./helpers/taskWorkspaceTimelineFixture";

describe("remote live timeline runs", () => {
  it("injects an active remote-live row with the specified agent", () => {
    const blockRef = "T-001#B-001";
    const base = timelineWorkspaceFixture([
      timelineBlockFixture({
        blockId: "B-001",
        runs: [timelineRunFixture(blockRef, "RUN-DONE", { retryIndex: 1 })]
      })
    ]);
    const workspace = {
      ...base,
      blocks: base.blocks.map((block) =>
        block.ref === blockRef
          ? {
              ...block,
              executor: "grok",
              remoteExecution: {
                identity: { operationId: "operation-abc" },
                phase: "active" as const,
                status: "owned" as const,
                actionRequired: false,
                source: { revision: "rev-1", graphFingerprint: "fp-1" },
                dispatchAttempt: {
                  dispatchId: "dispatch-1",
                  executionAttemptId: "attempt-1"
                }
              }
            }
          : block
      )
    };

    const projected = withRemoteLiveTimelineRuns(workspace);
    const runs = projected.blocks[0]?.runs ?? [];
    expect(runs).toHaveLength(2);
    const live = runs.find((item) => isRemoteLiveRecordId(item.run.record.recordId));
    expect(live).toMatchObject({
      active: true,
      retryIndex: 2,
      run: {
        record: { recordId: remoteLiveRecordId(blockRef, "operation-abc") },
        metadata: { agentId: "grok", executor: "grok", terminalState: null }
      }
    });
    expect(diskSelectedRecordId(live?.run.record.recordId)).toBeNull();
    expect(agentFamilyFromExecutorName("grok-acp")).toBe("grok");
  });

  it("does not inject a live row for terminal remoteExecution", () => {
    const blockRef = "T-001#B-001";
    const base = timelineWorkspaceFixture([
      timelineBlockFixture({
        blockId: "B-001",
        runs: [timelineRunFixture(blockRef, "RUN-DONE")]
      })
    ]);
    const workspace = {
      ...base,
      blocks: base.blocks.map((block) =>
        block.ref === blockRef
          ? {
              ...block,
              remoteExecution: {
                identity: { operationId: "operation-done" },
                phase: "terminal" as const,
                status: "completed" as const,
                actionRequired: false,
                source: { revision: "rev-1", graphFingerprint: "fp-1" },
                dispatchAttempt: null
              }
            }
          : block
      )
    };
    expect(withRemoteLiveTimelineRuns(workspace).blocks[0]?.runs).toHaveLength(1);
  });
});

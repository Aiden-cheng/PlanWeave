import { describe, expect, it } from "vitest";
import {
  assignmentActivitySourceId,
  buildAssignmentActivity,
  buildCommentActivity,
  buildMembershipActivity,
  buildRemoteRunActivity,
  commentActivitySourceId,
  membershipActivitySourceId,
  remoteRunActivitySourceId
} from "../comments/activityProjection.js";

const task = { kind: "task" as const, canvasId: "default", taskId: "T-001" };
const block = {
  kind: "block" as const,
  canvasId: "default",
  blockRef: "T-001#B-001"
};

describe("activity projection builders", () => {
  it("builds membership activities with stable source ids", () => {
    const joined = buildMembershipActivity({
      activityId: "act-1",
      projectId: "project-a",
      type: "member_joined",
      membershipId: "membership-1",
      transitionRevision: 1,
      humanPrincipalId: "human-1",
      displayName: "Ada",
      membershipRole: "member",
      occurredAt: "2026-07-24T12:00:00.000Z"
    });
    expect(joined.source).toEqual({
      kind: "membership",
      sourceId: membershipActivitySourceId("project-a", "membership-1", "member_joined", 1)
    });
    expect(joined.summary.humanPrincipalId).toBe("human-1");
    expect(joined.summary.headline).toContain("Ada");

    expect(membershipActivitySourceId("project-a", "m1", "owner_promoted", 2)).toMatch(
      /^membership:v1:[0-9a-f]{64}$/
    );
    expect(membershipActivitySourceId("project-a", "m1", "member_removed", 4)).not.toBe(
      membershipActivitySourceId("project-a", "m1", "owner_promoted", 4)
    );
    expect(membershipActivitySourceId("project-a", "m1", "owner_promoted", 4)).not.toBe(
      membershipActivitySourceId("project-a", "m1", "owner_promoted", 2)
    );

    const maximal = buildMembershipActivity({
      activityId: "act-max-membership",
      projectId: "p".repeat(128),
      type: "owner_promoted",
      membershipId: "m".repeat(128),
      transitionRevision: Number.MAX_SAFE_INTEGER,
      humanPrincipalId: "human-max",
      occurredAt: "2026-07-24T12:00:00.000Z"
    });
    expect(maximal.source.sourceId).toMatch(/^membership:v1:[0-9a-f]{64}$/);
    expect(maximal.source.sourceId.length).toBeLessThanOrEqual(128);
  });

  it("builds assignment and remote-run activities without embedding prompts", () => {
    const assignment = buildAssignmentActivity({
      activityId: "act-2",
      projectId: "project-a",
      workItem: block,
      assignmentRevision: 3,
      targetHeadline: "Assigned block to host",
      actor: { kind: "human", humanPrincipalId: "human-1", displayName: "Ada" },
      occurredAt: "2026-07-24T12:01:00.000Z"
    });
    expect(assignment.type).toBe("assignment_updated");
    expect(assignment.source.sourceId).toBe(assignmentActivitySourceId("project-a", block, 3));
    expect(assignment.source.sourceId).not.toContain("#");
    expect(JSON.stringify(assignment)).not.toMatch(/prompt|token|tool_call/i);

    const remote = buildRemoteRunActivity({
      activityId: "act-3",
      projectId: "project-a",
      type: "remote_run_succeeded",
      dispatchId: "dispatch-1",
      hostId: "host-1",
      workItem: block,
      occurredAt: "2026-07-24T12:02:00.000Z"
    });
    expect(remote.source.sourceId).toBe(
      remoteRunActivitySourceId("dispatch-1", "remote_run_succeeded")
    );
    expect(remote.summary.dispatchId).toBe("dispatch-1");
    expect(remote.subjects.some((s) => s.kind === "host")).toBe(true);
  });

  it("uses bounded distinct source ids for maximal remote-run dispatch ids", () => {
    const dispatchId = "d".repeat(128);
    const types = [
      "remote_run_started",
      "remote_run_succeeded",
      "remote_run_failed",
      "remote_run_interrupted"
    ] as const;
    const sourceIds = types.map((type) => remoteRunActivitySourceId(dispatchId, type));

    expect(new Set(sourceIds).size).toBe(types.length);
    for (const sourceId of sourceIds) {
      expect(sourceId).toMatch(/^remote_run:v1:[0-9a-f]{64}$/);
      expect(sourceId.length).toBeLessThanOrEqual(128);
    }
    expect(
      buildRemoteRunActivity({
        activityId: "act-max-remote-run",
        projectId: "project-a",
        type: "remote_run_started",
        dispatchId,
        occurredAt: "2026-07-24T12:02:00.000Z"
      }).source.sourceId
    ).toBe(sourceIds[0]);
  });

  it("uses bounded collision-resistant assignment source ids for complete work-item refs", () => {
    const first = {
      kind: "block" as const,
      canvasId: "default",
      blockRef: "A#B--C"
    };
    const second = {
      kind: "block" as const,
      canvasId: "default",
      blockRef: "A--B#C"
    };
    expect(assignmentActivitySourceId("project-a", first, 1)).not.toBe(
      assignmentActivitySourceId("project-a", second, 1)
    );
    expect(assignmentActivitySourceId("project-b", first, 1)).not.toBe(
      assignmentActivitySourceId("project-a", first, 1)
    );

    const maximalTask = {
      kind: "task" as const,
      canvasId: "c".repeat(128),
      taskId: "t".repeat(128)
    };
    const maximal = buildAssignmentActivity({
      activityId: "act-max",
      projectId: "p".repeat(128),
      workItem: maximalTask,
      assignmentRevision: Number.MAX_SAFE_INTEGER,
      targetHeadline: "Assignment updated",
      occurredAt: "2026-07-24T12:01:00.000Z"
    });
    expect(maximal.source.sourceId).toMatch(/^assignment:v1:[0-9a-f]{64}$/);
    expect(maximal.source.sourceId.length).toBeLessThanOrEqual(128);
  });

  it("distinguishes schema-level delimiter boundaries outside manifest canvas routing", () => {
    const first = {
      kind: "task" as const,
      canvasId: "A",
      taskId: "B:task:C"
    };
    const second = {
      kind: "task" as const,
      canvasId: "A:task:B",
      taskId: "C"
    };
    expect(assignmentActivitySourceId("project-a", first, 1)).not.toBe(
      assignmentActivitySourceId("project-a", second, 1)
    );
  });

  it("builds comment activities keyed by comment lifecycle", () => {
    const created = buildCommentActivity({
      activityId: "act-4",
      projectId: "project-a",
      type: "comment_created",
      commentId: "comment-1",
      workItem: task,
      authorHumanPrincipalId: "human-1",
      authorDisplayName: "Ada",
      revision: 1,
      occurredAt: "2026-07-24T12:03:00.000Z"
    });
    expect(created.source.sourceId).toBe(commentActivitySourceId("comment-1", "comment_created"));
    expect(created.summary.commentId).toBe("comment-1");

    const edited = buildCommentActivity({
      activityId: "act-5",
      projectId: "project-a",
      type: "comment_edited",
      commentId: "comment-1",
      workItem: task,
      authorHumanPrincipalId: "human-1",
      revision: 2,
      occurredAt: "2026-07-24T12:04:00.000Z"
    });
    expect(edited.source.sourceId).toBe(commentActivitySourceId("comment-1", "comment_edited", 2));
  });
});

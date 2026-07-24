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
      humanPrincipalId: "human-1",
      displayName: "Ada",
      membershipRole: "member",
      occurredAt: "2026-07-24T12:00:00.000Z"
    });
    expect(joined.source).toEqual({
      kind: "membership",
      sourceId: membershipActivitySourceId("membership-1", "member_joined")
    });
    expect(joined.summary.humanPrincipalId).toBe("human-1");
    expect(joined.summary.headline).toContain("Ada");

    expect(membershipActivitySourceId("m1", "owner_promoted")).toBe("m1:promoted");
    expect(membershipActivitySourceId("m1", "member_removed")).toBe("m1:removed");
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
    expect(assignment.source.sourceId).toBe(
      assignmentActivitySourceId(block, 3)
    );
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
    expect(created.source.sourceId).toBe(
      commentActivitySourceId("comment-1", "comment_created")
    );
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
    expect(edited.source.sourceId).toBe(
      commentActivitySourceId("comment-1", "comment_edited", 2)
    );
  });
});

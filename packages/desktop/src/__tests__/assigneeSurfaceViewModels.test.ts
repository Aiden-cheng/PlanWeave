import { describe, expect, it } from "vitest";
import {
  exampleActivityListPage,
  exampleAssignmentProjection
} from "@planweave-ai/collaboration-contracts";
import {
  buildAssigneeSurfaceIndex,
  buildCollaborationNotificationDrafts,
  buildCompactAssigneeChip,
  lookupBlockAssigneeChip,
  lookupTaskCardAssigneeChip,
  taskWorkItemKey
} from "../renderer/collaboration/assigneeSurfaceViewModels";
import { assigneeDisplayLabelsFromTranslator } from "../renderer/collaboration/assignmentViewModels";
import { createTranslator } from "../renderer/i18n";
import type { CollaborationReadModelSnapshot } from "../shared/collaborationReadModels";
import { workItemKey } from "../shared/collaborationReadModels";

function baseSnapshot(
  overrides: Partial<CollaborationReadModelSnapshot> = {}
): CollaborationReadModelSnapshot {
  return {
    profileId: "profile-1",
    projectId: "project-1",
    canvasId: "canvas-1",
    syncPhase: "ready",
    observerCursor: 1,
    members: [],
    hosts: [],
    assignmentsByWorkItem: {},
    commentsByWorkItem: {},
    activity: [],
    remoteRunsByDispatchId: {},
    mutationsById: {},
    lastError: null,
    loadingKinds: [],
    updatedAt: "2030-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("assigneeSurfaceViewModels", () => {
  it("hides unassigned chips without issues on dense surfaces", () => {
    const unassigned = buildCompactAssigneeChip(
      {
        ...exampleAssignmentProjection,
        target: { kind: "unassigned" },
        availability: { status: "unassigned", reason: "unassigned" },
        human: undefined,
        host: undefined
      },
      exampleAssignmentProjection.workItem
    );
    expect(unassigned.visible).toBe(false);
    expect(unassigned.tone).toBe("unassigned");
  });

  it("indexes assignments and resolves task/block chips by stable keys", () => {
    const assignment = {
      ...exampleAssignmentProjection,
      workItem: {
        kind: "block" as const,
        canvasId: "canvas-1",
        blockRef: "T-1#B-001"
      },
      target: { kind: "human" as const, humanPrincipalId: "human-1" },
      human: {
        humanPrincipalId: "human-1",
        displayName: "Ada",
        membershipActive: true
      },
      availability: { status: "ready" as const, reason: "ready" as const }
    };
    const index = buildAssigneeSurfaceIndex(
      baseSnapshot({
        assignmentsByWorkItem: {
          [workItemKey(assignment.workItem)]: assignment
        }
      })
    );
    expect(index.surfaceActive).toBe(true);
    expect(lookupBlockAssigneeChip(index, "canvas-1", "T-1#B-001")?.label).toBe("Ada");
    expect(
      lookupTaskCardAssigneeChip(index, "canvas-1", "T-1", ["T-1#B-001"])?.workItemKey
    ).toBe(workItemKey(assignment.workItem));
    expect(taskWorkItemKey("canvas-1", "T-1")).toBe("task:canvas-1:T-1");
  });

  it("localizes automatic host compact chips via catalog labels", () => {
    const zhLabels = assigneeDisplayLabelsFromTranslator(createTranslator("zh-CN"));
    const assignment = {
      ...exampleAssignmentProjection,
      workItem: {
        kind: "block" as const,
        canvasId: "canvas-1",
        blockRef: "T-1#B-001"
      },
      target: { kind: "automatic_host" as const },
      human: undefined,
      host: undefined,
      availability: {
        status: "pending" as const,
        reason: "automatic_pending_selection" as const
      }
    };
    const chip = buildCompactAssigneeChip(assignment, assignment.workItem, zhLabels);
    expect(chip.label).toBe("自动 Host");
    expect(chip.visible).toBe(true);

    const index = buildAssigneeSurfaceIndex(
      baseSnapshot({
        assignmentsByWorkItem: {
          [workItemKey(assignment.workItem)]: assignment
        }
      }),
      zhLabels
    );
    expect(lookupBlockAssigneeChip(index, "canvas-1", "T-1#B-001")?.label).toBe("自动 Host");
  });

  it("builds collaboration notifications from activity and confirmed/rejected mutations only", () => {
    const drafts = buildCollaborationNotificationDrafts({
      activity: [
        {
          ...exampleActivityListPage.items[0]!,
          activityId: "activity-assign-1",
          type: "assignment_updated",
          source: { kind: "assignment", sourceId: "assignment-1" },
          summary: {
            headline: "Ada assigned to T-1#B-001",
            workItem: { kind: "block", canvasId: "canvas-1", blockRef: "T-1#B-001" },
            assignmentRevision: 2
          }
        },
        {
          ...exampleActivityListPage.items[0]!,
          activityId: "activity-member-1",
          type: "member_joined",
          source: { kind: "membership", sourceId: "membership-1" },
          summary: {
            headline: "Grace joined the project",
            humanPrincipalId: "human-2",
            membershipRole: "member"
          }
        }
      ],
      mutations: [
        {
          mutationId: "mut-ok",
          kind: "assignment",
          workItemKey: "block:canvas-1:T-1#B-001",
          status: "confirmed",
          submittedAt: "2030-01-01T00:00:00.000Z",
          resolvedAt: "2030-01-01T00:00:01.000Z"
        },
        {
          mutationId: "mut-pending",
          kind: "assignment",
          status: "pending",
          submittedAt: "2030-01-01T00:00:00.000Z"
        },
        {
          mutationId: "mut-bad",
          kind: "assignment",
          status: "rejected",
          errorMessage: "stale revision",
          submittedAt: "2030-01-01T00:00:00.000Z",
          resolvedAt: "2030-01-01T00:00:02.000Z"
        }
      ],
      labels: {
        assignmentUpdated: "Assignment updated",
        assignmentFailed: "Assignment failed",
        membershipChanged: "Membership changed",
        mutationConfirmed: "Assignment confirmed",
        mutationRejected: "Assignment rejected"
      }
    });
    expect(drafts.some((item) => item.id === "collab-mutation:mut-ok")).toBe(true);
    expect(drafts.some((item) => item.id === "collab-mutation:mut-pending")).toBe(false);
    expect(drafts.find((item) => item.id === "collab-mutation:mut-bad")?.tone).toBe(
      "destructive"
    );
  });
});

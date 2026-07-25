import { describe, expect, it } from "vitest";
import {
  activityIsAfterCursor,
  activitySourceIdempotencyKey,
  authorizeActivityList,
  authorizeCommentEdit,
  authorizeCommentMutation,
  authorizeCommentTombstone,
  commentIsAfterCursor,
  compareActivityOrder,
  compareCommentOrder,
  decideCommentCreate,
  decideCommentEdit,
  decideCommentTombstone,
  evaluateCommentAttachments,
  evaluateCommentCreateWorkItem,
  evaluateCommentRevision,
  nextActivityCursor,
  nextCommentCursor,
  projectCommentDisplay
} from "../comments/index.js";
import type { CommentRecord } from "../comments/schemas.js";
import type { WorkItemPackageFacts } from "../work/schemas.js";

const now = new Date("2026-07-24T12:00:00.000Z");

const member = {
  humanPrincipalId: "human-1",
  displayName: "Ada",
  deviceCredentialId: "device-1",
  projectId: "project-a",
  role: "member" as const,
  membershipId: "membership-1"
};

const owner = {
  ...member,
  humanPrincipalId: "human-owner",
  displayName: "Olivia",
  deviceCredentialId: "device-owner",
  role: "owner" as const,
  membershipId: "membership-owner"
};

const otherMember = {
  ...member,
  humanPrincipalId: "human-2",
  displayName: "Bob",
  deviceCredentialId: "device-2",
  membershipId: "membership-2"
};

const taskRef = {
  kind: "task" as const,
  canvasId: "default",
  taskId: "T-001"
};

function packageTask(exists = true): WorkItemPackageFacts {
  return {
    canvasId: "default",
    kind: "task",
    exists,
    taskId: "T-001",
    requiredCapabilities: []
  };
}

function baseRecord(overrides: Partial<CommentRecord> = {}): CommentRecord {
  return {
    commentId: "comment-1",
    projectId: "project-a",
    workItem: taskRef,
    authorHumanPrincipalId: "human-1",
    body: "original body",
    bodyFormat: "markdown",
    revision: 1,
    createdAt: "2026-07-24T11:00:00.000Z",
    updatedAt: "2026-07-24T11:00:00.000Z",
    attachments: [],
    ...overrides
  };
}

describe("comment and activity policy", () => {
  it("authorizes comment/activity for members and owners; denies unauthenticated and Host-like subjects", () => {
    expect(
      authorizeCommentMutation({
        subject: { kind: "human", context: member },
        projectId: "project-a"
      }).allowed
    ).toBe(true);
    expect(
      authorizeCommentMutation({
        subject: { kind: "human", context: owner },
        projectId: "project-a"
      }).allowed
    ).toBe(true);
    expect(
      authorizeCommentMutation({
        subject: { kind: "unauthenticated" },
        projectId: "project-a"
      }).allowed
    ).toBe(false);
    expect(
      authorizeCommentMutation({
        subject: { kind: "human", context: { ...member, projectId: "project-b" } },
        projectId: "project-a"
      }).code
    ).toBe("comment_auth_project_mismatch");

    expect(
      authorizeActivityList({
        subject: { kind: "human", context: member },
        projectId: "project-a"
      }).allowed
    ).toBe(true);
    expect(
      authorizeActivityList({
        subject: { kind: "unauthenticated" },
        projectId: "project-a"
      }).allowed
    ).toBe(false);
  });

  it("requires WorkItemRef present for create; missing package item denies new comments", () => {
    expect(
      evaluateCommentCreateWorkItem({
        workItem: taskRef,
        packageFacts: packageTask(true)
      }).allowed
    ).toBe(true);
    expect(
      evaluateCommentCreateWorkItem({
        workItem: taskRef,
        packageFacts: packageTask(false)
      }).code
    ).toBe("comment_work_item_not_found");

    const created = decideCommentCreate({
      command: {
        projectId: "project-a",
        workItem: taskRef,
        body: "hello **world**",
        actor: member,
        attachments: []
      },
      packageFacts: packageTask(true),
      commentId: "comment-1",
      now
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.record.revision).toBe(1);
      expect(created.record.authorHumanPrincipalId).toBe("human-1");
      expect(created.record.bodyFormat).toBe("markdown");
    }

    const missing = decideCommentCreate({
      command: {
        projectId: "project-a",
        workItem: taskRef,
        body: "orphan",
        actor: member,
        attachments: []
      },
      packageFacts: packageTask(false),
      commentId: "comment-2",
      now
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe("comment_work_item_not_found");
    }
  });

  it("allows author edit with CAS; denies non-author body rewrite and revision conflicts", () => {
    const record = baseRecord();

    const ok = decideCommentEdit({
      command: {
        projectId: "project-a",
        commentId: "comment-1",
        body: "updated",
        expectedRevision: 1,
        actor: member
      },
      current: record,
      now
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.record.revision).toBe(2);
      expect(ok.record.body).toBe("updated");
      expect(ok.previousRevision).toBe(1);
    }

    const notAuthor = authorizeCommentEdit({
      subject: { kind: "human", context: otherMember },
      projectId: "project-a",
      record
    });
    expect(notAuthor.allowed).toBe(false);
    if (!notAuthor.allowed) {
      expect(notAuthor.code).toBe("comment_not_author");
    }

    // Owner cannot rewrite another member's body (moderation is tombstone-only).
    expect(
      authorizeCommentEdit({
        subject: { kind: "human", context: owner },
        projectId: "project-a",
        record
      }).code
    ).toBe("comment_not_author");

    expect(evaluateCommentRevision({ expectedRevision: 1, currentRevision: 2 }).code).toBe(
      "comment_revision_conflict"
    );

    const conflict = decideCommentEdit({
      command: {
        projectId: "project-a",
        commentId: "comment-1",
        body: "stale",
        expectedRevision: 1,
        actor: member
      },
      current: baseRecord({ revision: 3, updatedAt: "2026-07-24T11:30:00.000Z" }),
      now
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.code).toBe("comment_revision_conflict");
    }
  });

  it("allows author or owner tombstone; rejects double tombstone and non-owner members", () => {
    const record = baseRecord();

    const byAuthor = decideCommentTombstone({
      command: {
        projectId: "project-a",
        commentId: "comment-1",
        expectedRevision: 1,
        actor: member,
        reason: "retract"
      },
      current: record,
      now
    });
    expect(byAuthor.ok).toBe(true);
    if (byAuthor.ok) {
      expect(byAuthor.record.tombstonedAt).toBe(now.toISOString());
      expect(byAuthor.record.body).toBe("original body");
      expect(byAuthor.record.revision).toBe(2);
    }

    const byOwner = authorizeCommentTombstone({
      subject: { kind: "human", context: owner },
      projectId: "project-a",
      record
    });
    expect(byOwner.allowed).toBe(true);

    const byOther = authorizeCommentTombstone({
      subject: { kind: "human", context: otherMember },
      projectId: "project-a",
      record
    });
    expect(byOther.allowed).toBe(false);
    if (!byOther.allowed) {
      expect(byOther.code).toBe("comment_role_insufficient");
    }

    const already = authorizeCommentTombstone({
      subject: { kind: "human", context: member },
      projectId: "project-a",
      record: baseRecord({
        tombstonedAt: "2026-07-24T11:30:00.000Z",
        tombstonedBy: { kind: "human", id: "human-1" }
      })
    });
    expect(already.code).toBe("comment_already_tombstoned");
  });

  it("allows edit/tombstone on orphaned comments when WorkItemRef is missing from package", () => {
    const orphan = baseRecord();
    const edited = decideCommentEdit({
      command: {
        projectId: "project-a",
        commentId: "comment-1",
        body: "still fixable",
        expectedRevision: 1,
        actor: member
      },
      current: orphan,
      now
    });
    expect(edited.ok).toBe(true);

    const projection = projectCommentDisplay({
      record: orphan,
      authorDisplayName: "Ada",
      authorMembershipActive: false,
      packageFacts: packageTask(false)
    });
    expect(projection.workItemPresence).toBe("missing");
    expect(projection.body).toBe("original body");

    const tombstonedProjection = projectCommentDisplay({
      record: baseRecord({
        revision: 2,
        updatedAt: now.toISOString(),
        tombstonedAt: now.toISOString(),
        tombstonedBy: { kind: "human", id: "human-1", displayName: "Ada" }
      }),
      authorDisplayName: "Ada",
      authorMembershipActive: true,
      packageFacts: packageTask(false)
    });
    expect(tombstonedProjection.tombstoned).toBe(true);
    expect(tombstonedProjection.body).toBeNull();
  });

  it("enforces attachment count/size/media policy bounds", () => {
    expect(evaluateCommentAttachments([]).allowed).toBe(true);
    expect(
      evaluateCommentAttachments([
        {
          pendingUploadId: "pending-1",
          digestSha256: "b".repeat(64),
          sizeBytes: 100,
          mediaType: "image/png"
        }
      ]).allowed
    ).toBe(true);

    const many = Array.from({ length: 9 }, (_, i) => ({
      pendingUploadId: `pending-${i}`,
      digestSha256: "b".repeat(64),
      sizeBytes: 100,
      mediaType: "text/plain" as const
    }));
    expect(evaluateCommentAttachments(many).code).toBe("comment_attachment_limit");

    expect(
      evaluateCommentAttachments([
        {
          pendingUploadId: "pending-1",
          digestSha256: "b".repeat(64),
          sizeBytes: 9 * 1024 * 1024,
          mediaType: "image/png"
        }
      ]).code
    ).toBe("comment_attachment_size");
  });

  it("orders comment cursors ascending and activity cursors descending", () => {
    const c1 = { createdAt: "2026-07-24T10:00:00.000Z", commentId: "c-a" };
    const c2 = { createdAt: "2026-07-24T11:00:00.000Z", commentId: "c-b" };
    const c3 = { createdAt: "2026-07-24T11:00:00.000Z", commentId: "c-c" };

    expect(compareCommentOrder(c1, c2)).toBeLessThan(0);
    expect(compareCommentOrder(c2, c3)).toBeLessThan(0);
    expect(commentIsAfterCursor(c2, c1)).toBe(true);
    expect(commentIsAfterCursor(c1, c2)).toBe(false);
    expect(commentIsAfterCursor(c3, c2)).toBe(true);

    const page = [c1, c2];
    expect(nextCommentCursor(page, 2)).toEqual(c2);
    expect(nextCommentCursor(page, 3)).toBeNull();

    const a1 = { occurredAt: "2026-07-24T12:00:00.000Z", activityId: "a-2" };
    const a2 = { occurredAt: "2026-07-24T11:00:00.000Z", activityId: "a-1" };
    const a3 = { occurredAt: "2026-07-24T11:00:00.000Z", activityId: "a-0" };

    // Newer first in feed order.
    expect(compareActivityOrder(a1, a2)).toBeLessThan(0);
    expect(compareActivityOrder(a2, a3)).toBeLessThan(0);
    expect(activityIsAfterCursor(a2, a1)).toBe(true);
    expect(activityIsAfterCursor(a1, a2)).toBe(false);
    expect(nextActivityCursor([a1, a2], 2)).toEqual(a2);
  });

  it("builds stable activity source idempotency keys", () => {
    const key = activitySourceIdempotencyKey({
      projectId: "project-a",
      source: { kind: "comment", sourceId: "comment-1:create" }
    });
    expect(key).toContain("project-a");
    expect(key).toContain("comment");
    expect(key).toContain("comment-1:create");
    expect(
      activitySourceIdempotencyKey({
        projectId: "project-a",
        source: { kind: "comment", sourceId: "comment-1:create" }
      })
    ).toBe(key);
    expect(
      activitySourceIdempotencyKey({
        projectId: "project-a",
        source: { kind: "comment", sourceId: "comment-1:edit:2" }
      })
    ).not.toBe(key);
  });
});

import { describe, expect, it } from "vitest";
import {
  activityListQuerySchema,
  activityRecordSchema,
  activityTypeSchema,
  commentAttachmentFileNameSchema,
  commentAttachmentInputSchema,
  commentAttachmentMetadataSchema,
  commentCreateCommandSchema,
  commentDisplayProjectionSchema,
  commentEditCommandSchema,
  commentListCursorSchema,
  commentListQuerySchema,
  commentRecordSchema,
  commentTombstoneCommandSchema,
  pendingAttachmentUploadSchema,
  workItemsEqual
} from "../comments/schemas.js";
import {
  COMMENT_ATTACHMENT_MAX_BYTES,
  COMMENT_ATTACHMENTS_MAX_COUNT,
  COMMENT_BODY_MAX_LENGTH
} from "../comments/limits.js";

const actor = {
  humanPrincipalId: "human-1",
  displayName: "Ada",
  deviceCredentialId: "device-1",
  projectId: "project-a",
  role: "member" as const,
  membershipId: "membership-1"
};

const taskRef = {
  kind: "task" as const,
  canvasId: "default",
  taskId: "T-001"
};

const blockRef = {
  kind: "block" as const,
  canvasId: "default",
  blockRef: "T-001#B-001"
};

const digest = "a".repeat(64);

function attachmentMeta(overrides: Record<string, unknown> = {}) {
  return commentAttachmentMetadataSchema.parse({
    digestSha256: digest,
    sizeBytes: 1024,
    mediaType: "image/png",
    fileName: "shot.png",
    createdAt: "2026-07-24T12:00:00.000Z",
    ...overrides
  });
}

describe("comment and activity schemas", () => {
  it("accepts Task/Block comment records with human author only and Markdown body", () => {
    const record = commentRecordSchema.parse({
      commentId: "comment-1",
      projectId: "project-a",
      workItem: taskRef,
      authorHumanPrincipalId: "human-1",
      body: "Looks good — please verify **edge cases**.",
      bodyFormat: "markdown",
      revision: 1,
      createdAt: "2026-07-24T12:00:00.000Z",
      updatedAt: "2026-07-24T12:00:00.000Z",
      attachments: [attachmentMeta()]
    });
    expect(record.bodyFormat).toBe("markdown");
    expect(record.authorHumanPrincipalId).toBe("human-1");
    expect(record.attachments).toHaveLength(1);

    expect(() =>
      commentRecordSchema.parse({
        commentId: "comment-1",
        projectId: "project-a",
        workItem: taskRef,
        authorHumanPrincipalId: "human-1",
        body: "x",
        bodyFormat: "html",
        revision: 1,
        createdAt: "2026-07-24T12:00:00.000Z",
        updatedAt: "2026-07-24T12:00:00.000Z",
        attachments: []
      })
    ).toThrow();

    expect(() =>
      commentRecordSchema.parse({
        commentId: "comment-1",
        projectId: "project-a",
        workItem: taskRef,
        authorHostId: "host-1",
        body: "nope",
        bodyFormat: "markdown",
        revision: 1,
        createdAt: "2026-07-24T12:00:00.000Z",
        updatedAt: "2026-07-24T12:00:00.000Z",
        attachments: []
      })
    ).toThrow();
  });

  it("rejects body over budget, empty body, and attachment limit/size/media violations", () => {
    expect(() =>
      commentCreateCommandSchema.parse({
        projectId: "project-a",
        workItem: blockRef,
        body: "a".repeat(COMMENT_BODY_MAX_LENGTH + 1),
        actor
      })
    ).toThrow();

    expect(() =>
      commentCreateCommandSchema.parse({
        projectId: "project-a",
        workItem: blockRef,
        body: "",
        actor
      })
    ).toThrow();

    const tooMany = Array.from({ length: COMMENT_ATTACHMENTS_MAX_COUNT + 1 }, (_, i) =>
      commentAttachmentInputSchema.parse({
        pendingUploadId: `pending-${i}`,
        digestSha256: digest,
        sizeBytes: 10,
        mediaType: "text/plain"
      })
    );
    expect(() =>
      commentCreateCommandSchema.parse({
        projectId: "project-a",
        workItem: blockRef,
        body: "with attachments",
        actor,
        attachments: tooMany
      })
    ).toThrow();

    expect(() =>
      commentAttachmentMetadataSchema.parse({
        digestSha256: digest,
        sizeBytes: COMMENT_ATTACHMENT_MAX_BYTES + 1,
        mediaType: "image/png",
        createdAt: "2026-07-24T12:00:00.000Z"
      })
    ).toThrow();

    expect(() =>
      commentAttachmentMetadataSchema.parse({
        digestSha256: digest,
        sizeBytes: 10,
        mediaType: "application/x-msdownload",
        createdAt: "2026-07-24T12:00:00.000Z"
      })
    ).toThrow();
  });

  it("rejects path-like attachment file names and invalid digests", () => {
    expect(commentAttachmentFileNameSchema.parse("report.pdf")).toBe("report.pdf");
    expect(() => commentAttachmentFileNameSchema.parse("../secret")).toThrow();
    expect(() => commentAttachmentFileNameSchema.parse("a/b.png")).toThrow();
    expect(() => commentAttachmentFileNameSchema.parse("a\\b.png")).toThrow();
    expect(() => commentAttachmentFileNameSchema.parse(".")).toThrow();
    expect(() => commentAttachmentFileNameSchema.parse("..")).toThrow();

    expect(() =>
      commentAttachmentMetadataSchema.parse({
        digestSha256: "A".repeat(64),
        sizeBytes: 10,
        mediaType: "image/png",
        createdAt: "2026-07-24T12:00:00.000Z"
      })
    ).toThrow();
  });

  it("requires actor project match on create/edit/tombstone/list commands", () => {
    expect(() =>
      commentCreateCommandSchema.parse({
        projectId: "project-a",
        workItem: taskRef,
        body: "hello",
        actor: { ...actor, projectId: "project-b" }
      })
    ).toThrow();

    expect(() =>
      commentEditCommandSchema.parse({
        projectId: "project-a",
        commentId: "comment-1",
        body: "edited",
        expectedRevision: 1,
        actor: { ...actor, projectId: "project-b" }
      })
    ).toThrow();

    expect(() =>
      commentTombstoneCommandSchema.parse({
        projectId: "project-a",
        commentId: "comment-1",
        expectedRevision: 1,
        actor: { ...actor, projectId: "project-b" }
      })
    ).toThrow();

    expect(() =>
      commentListQuerySchema.parse({
        projectId: "project-a",
        workItem: taskRef,
        limit: 10,
        actor: { ...actor, projectId: "project-b" }
      })
    ).toThrow();
  });

  it("models tombstone markers and redacts body only in display projections", () => {
    const durable = commentRecordSchema.parse({
      commentId: "comment-1",
      projectId: "project-a",
      workItem: taskRef,
      authorHumanPrincipalId: "human-1",
      body: "sensitive note",
      bodyFormat: "markdown",
      revision: 2,
      createdAt: "2026-07-24T12:00:00.000Z",
      updatedAt: "2026-07-24T13:00:00.000Z",
      attachments: [],
      tombstonedAt: "2026-07-24T13:00:00.000Z",
      tombstonedBy: { kind: "human", id: "human-1", displayName: "Ada" },
      tombstoneReason: "off-topic"
    });
    expect(durable.body).toBe("sensitive note");

    expect(() =>
      commentRecordSchema.parse({
        ...durable,
        tombstonedAt: "2026-07-24T13:00:00.000Z",
        tombstonedBy: undefined
      })
    ).toThrow();

    const projection = commentDisplayProjectionSchema.parse({
      commentId: "comment-1",
      projectId: "project-a",
      workItem: taskRef,
      author: {
        humanPrincipalId: "human-1",
        displayName: "Ada",
        membershipActive: true
      },
      body: null,
      bodyFormat: "markdown",
      revision: 2,
      createdAt: "2026-07-24T12:00:00.000Z",
      updatedAt: "2026-07-24T13:00:00.000Z",
      tombstoned: true,
      tombstonedAt: "2026-07-24T13:00:00.000Z",
      tombstonedBy: { kind: "human", id: "human-1", displayName: "Ada" },
      attachments: [],
      workItemPresence: "missing"
    });
    expect(projection.body).toBeNull();
    expect(projection.workItemPresence).toBe("missing");

    expect(() =>
      commentDisplayProjectionSchema.parse({
        ...projection,
        body: "still visible"
      })
    ).toThrow();
  });

  it("bounds comment list queries and structured cursors", () => {
    const cursor = commentListCursorSchema.parse({
      createdAt: "2026-07-24T12:00:00.000Z",
      commentId: "comment-1"
    });
    const query = commentListQuerySchema.parse({
      projectId: "project-a",
      workItem: blockRef,
      limit: 20,
      cursor,
      actor
    });
    expect(query.includeTombstoned).toBe(false);
    expect(query.limit).toBe(20);

    expect(() =>
      commentListQuerySchema.parse({
        projectId: "project-a",
        workItem: blockRef,
        limit: 999,
        actor
      })
    ).toThrow();
  });

  it("accepts staged pending attachment metadata without dispatch grant fields", () => {
    const pending = pendingAttachmentUploadSchema.parse({
      pendingUploadId: "pending-1",
      projectId: "project-a",
      uploaderHumanPrincipalId: "human-1",
      expectedSizeBytes: 2048,
      mediaType: "application/pdf",
      fileName: "spec.pdf",
      createdAt: "2026-07-24T12:00:00.000Z",
      expiresAt: "2026-07-24T13:00:00.000Z"
    });
    expect(pending.expectedDigestSha256).toBeUndefined();
    expect(() =>
      pendingAttachmentUploadSchema.parse({
        ...pending,
        dispatchGrantId: "grant-1"
      })
    ).toThrow();
  });

  it("covers stable activity types with source kind and required summary fields", () => {
    expect(activityTypeSchema.options).toContain("comment_created");
    expect(activityTypeSchema.options).not.toContain("acp_token");
    expect(activityTypeSchema.options).not.toContain("proposal_approved");

    const commentActivity = activityRecordSchema.parse({
      activityId: "activity-1",
      projectId: "project-a",
      type: "comment_created",
      source: { kind: "comment", sourceId: "comment-1:create" },
      summary: {
        headline: "Ada commented on T-001",
        commentId: "comment-1",
        workItem: taskRef,
        humanPrincipalId: "human-1"
      },
      subjects: [{ kind: "human", humanPrincipalId: "human-1", displayName: "Ada" }],
      workItem: taskRef,
      occurredAt: "2026-07-24T12:00:00.000Z"
    });
    expect(commentActivity.source.kind).toBe("comment");

    expect(() =>
      activityRecordSchema.parse({
        activityId: "activity-2",
        projectId: "project-a",
        type: "comment_created",
        source: { kind: "assignment", sourceId: "x" },
        summary: { headline: "bad source kind", commentId: "comment-1" },
        subjects: [],
        workItem: taskRef,
        occurredAt: "2026-07-24T12:00:00.000Z"
      })
    ).toThrow();

    const remote = activityRecordSchema.parse({
      activityId: "activity-3",
      projectId: "project-a",
      type: "remote_run_started",
      source: { kind: "remote_run", sourceId: "dispatch-1:start" },
      summary: {
        headline: "Host builder started remote run",
        dispatchId: "dispatch-1",
        hostId: "host-1",
        workItem: blockRef
      },
      subjects: [
        { kind: "host", hostId: "host-1", displayName: "Builder" },
        { kind: "human", humanPrincipalId: "human-1", displayName: "Ada" }
      ],
      workItem: blockRef,
      occurredAt: "2026-07-24T12:05:00.000Z"
    });
    expect(remote.subjects[0]?.kind).toBe("host");

    const assignment = activityRecordSchema.parse({
      activityId: "activity-4",
      projectId: "project-a",
      type: "assignment_updated",
      source: { kind: "assignment", sourceId: "project-a:default:T-001:rev:3" },
      summary: {
        headline: "Assignment updated",
        workItem: taskRef,
        assignmentRevision: 3,
        humanPrincipalId: "human-2"
      },
      subjects: [{ kind: "human", humanPrincipalId: "human-2" }],
      workItem: taskRef,
      occurredAt: "2026-07-24T12:06:00.000Z"
    });
    expect(assignment.summary.assignmentRevision).toBe(3);

    expect(() =>
      activityRecordSchema.parse({
        activityId: "activity-5",
        projectId: "project-a",
        type: "member_joined",
        source: { kind: "membership", sourceId: "membership-1:join" },
        summary: { headline: "joined without principal" },
        subjects: [],
        occurredAt: "2026-07-24T12:07:00.000Z"
      })
    ).toThrow();
  });

  it("rejects free-form chat room or channel fields on list queries", () => {
    expect(() =>
      commentListQuerySchema.parse({
        projectId: "project-a",
        workItem: taskRef,
        limit: 10,
        actor,
        channelId: "general"
      })
    ).toThrow();

    expect(() =>
      activityListQuerySchema.parse({
        projectId: "project-a",
        limit: 10,
        actor,
        roomId: "planning-room"
      })
    ).toThrow();

    const activityQuery = activityListQuerySchema.parse({
      projectId: "project-a",
      workItem: blockRef,
      limit: 10,
      actor
    });
    expect(activityQuery.workItem).toEqual(blockRef);
  });

  it("compares WorkItemRef equality without rename aliasing", () => {
    expect(workItemsEqual(taskRef, { ...taskRef })).toBe(true);
    expect(workItemsEqual(taskRef, { ...taskRef, taskId: "T-002" })).toBe(false);
    expect(workItemsEqual(taskRef, blockRef)).toBe(false);
    expect(
      workItemsEqual(blockRef, { kind: "block", canvasId: "default", blockRef: "T-001#B-002" })
    ).toBe(false);
  });
});

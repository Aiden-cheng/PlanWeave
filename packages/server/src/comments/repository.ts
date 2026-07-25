import { randomUUID } from "node:crypto";
import {
  actorRefSchema,
  humanPrincipalIdSchema,
  humanProjectIdSchema,
  type ActorRef
} from "../identity/schemas.js";
import { inWriteTransaction, type SqliteDatabase } from "../sqlite.js";
import { workItemKeyParts } from "../work/repository.js";
import { workItemRefSchema, type WorkItemRef } from "../work/schemas.js";
import { COMMENT_ACTIVITY_ERROR_MESSAGES, type CommentActivityErrorCode } from "./errors.js";
import {
  commentAttachmentMetadataSchema,
  commentIdSchema,
  commentRecordSchema,
  type CommentAttachmentMetadata,
  type CommentId,
  type CommentListCursor,
  type CommentRecord
} from "./schemas.js";

export class CommentRepositoryError extends Error {
  constructor(
    readonly code: CommentActivityErrorCode,
    message: string = COMMENT_ACTIVITY_ERROR_MESSAGES[code]
  ) {
    super(message);
    this.name = "CommentRepositoryError";
  }
}

type CommentRow = {
  comment_id: string;
  project_id: string;
  canvas_id: string;
  work_item_kind: string;
  work_item_key: string;
  author_human_principal_id: string;
  body: string;
  body_format: string;
  revision: number;
  created_at: string;
  updated_at: string;
  attachments_json: string;
  tombstoned_at: string | null;
  tombstoned_by_kind: string | null;
  tombstoned_by_id: string | null;
  tombstoned_by_display_name: string | null;
  tombstone_reason: string | null;
};

function workItemFromRow(row: CommentRow): WorkItemRef {
  return workItemRefSchema.parse(
    row.work_item_kind === "task"
      ? { kind: "task", canvasId: row.canvas_id, taskId: row.work_item_key }
      : { kind: "block", canvasId: row.canvas_id, blockRef: row.work_item_key }
  );
}

function tombstonedByFromRow(row: CommentRow): ActorRef | undefined {
  if (!row.tombstoned_at || !row.tombstoned_by_kind || !row.tombstoned_by_id) {
    return undefined;
  }
  return actorRefSchema.parse({
    kind: row.tombstoned_by_kind,
    id: row.tombstoned_by_id,
    ...(row.tombstoned_by_display_name ? { displayName: row.tombstoned_by_display_name } : {})
  });
}

function toRecord(row: CommentRow): CommentRecord {
  const attachments = commentAttachmentMetadataSchema
    .array()
    .parse(JSON.parse(row.attachments_json));
  return commentRecordSchema.parse({
    commentId: row.comment_id,
    projectId: row.project_id,
    workItem: workItemFromRow(row),
    authorHumanPrincipalId: row.author_human_principal_id,
    body: row.body,
    bodyFormat: row.body_format,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachments,
    ...(row.tombstoned_at
      ? {
          tombstonedAt: row.tombstoned_at,
          tombstonedBy: tombstonedByFromRow(row),
          ...(row.tombstone_reason ? { tombstoneReason: row.tombstone_reason } : {})
        }
      : {})
  });
}

/**
 * Durable comment store. Does not authorize actors or resolve package facts —
 * the application service validates those first.
 */
export class CommentRepository {
  constructor(readonly database: SqliteDatabase) {}

  get(projectId: string, commentId: string): CommentRecord | undefined {
    const row = this.database
      .prepare(`SELECT * FROM comments WHERE project_id=? AND comment_id=?`)
      .get(humanProjectIdSchema.parse(projectId), commentIdSchema.parse(commentId)) as
      | CommentRow
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  getRequired(projectId: string, commentId: string): CommentRecord {
    const record = this.get(projectId, commentId);
    if (!record) {
      throw new CommentRepositoryError("comment_not_found");
    }
    return record;
  }

  /**
   * Insert a new comment (revision must be 1). Caller supplies fully validated record.
   * Must run inside a write transaction when combined with attachment bind + activity.
   */
  insertUnlocked(record: CommentRecord): CommentRecord {
    const parsed = commentRecordSchema.parse(record);
    if (parsed.revision !== 1 || parsed.tombstonedAt !== undefined) {
      throw new CommentRepositoryError("comment_input_invalid");
    }
    const parts = workItemKeyParts(parsed.workItem);
    try {
      this.database
        .prepare(
          `INSERT INTO comments(
            comment_id,project_id,canvas_id,work_item_kind,work_item_key,
            author_human_principal_id,body,body_format,revision,created_at,updated_at,
            attachments_json,tombstoned_at,tombstoned_by_kind,tombstoned_by_id,
            tombstoned_by_display_name,tombstone_reason
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, NULL, NULL, NULL, NULL, NULL)`
        )
        .run(
          parsed.commentId,
          parsed.projectId,
          parts.canvasId,
          parts.workItemKind,
          parts.workItemKey,
          parsed.authorHumanPrincipalId,
          parsed.body,
          parsed.bodyFormat,
          parsed.revision,
          parsed.createdAt,
          parsed.updatedAt,
          JSON.stringify(parsed.attachments)
        );
    } catch (error) {
      if (error instanceof Error && /UNIQUE/i.test(error.message)) {
        throw new CommentRepositoryError("comment_input_invalid", "Comment id already exists.");
      }
      throw error;
    }
    return this.getRequired(parsed.projectId, parsed.commentId);
  }

  insert(record: CommentRecord): CommentRecord {
    return inWriteTransaction(this.database, () => this.insertUnlocked(record));
  }

  /**
   * Compare-and-set update of body/revision/tombstone fields.
   * expectedRevision must match the stored revision; concurrent losers get comment_revision_conflict.
   */
  applyCasUpdateUnlocked(input: {
    record: CommentRecord;
    expectedRevision: number;
  }): CommentRecord {
    const record = commentRecordSchema.parse(input.record);
    if (
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      record.revision !== input.expectedRevision + 1
    ) {
      throw new CommentRepositoryError("comment_input_invalid");
    }

    const tombstonedBy = record.tombstonedBy;
    const result = this.database
      .prepare(
        `UPDATE comments SET
          body=?,
          revision=?,
          updated_at=?,
          attachments_json=?,
          tombstoned_at=?,
          tombstoned_by_kind=?,
          tombstoned_by_id=?,
          tombstoned_by_display_name=?,
          tombstone_reason=?
         WHERE project_id=? AND comment_id=? AND revision=?`
      )
      .run(
        record.body,
        record.revision,
        record.updatedAt,
        JSON.stringify(record.attachments),
        record.tombstonedAt ?? null,
        tombstonedBy?.kind ?? null,
        tombstonedBy?.id ?? null,
        tombstonedBy?.displayName ?? null,
        record.tombstoneReason ?? null,
        record.projectId,
        record.commentId,
        input.expectedRevision
      );
    if (result.changes !== 1) {
      const current = this.get(record.projectId, record.commentId);
      if (!current) throw new CommentRepositoryError("comment_not_found");
      throw new CommentRepositoryError("comment_revision_conflict");
    }
    return this.getRequired(record.projectId, record.commentId);
  }

  applyCasUpdate(input: { record: CommentRecord; expectedRevision: number }): CommentRecord {
    return inWriteTransaction(this.database, () => this.applyCasUpdateUnlocked(input));
  }

  /**
   * Keyset list: createdAt ASC, commentId ASC. Fetches limit+1 so callers can detect next page.
   */
  listByWorkItem(input: {
    projectId: string;
    workItem: WorkItemRef;
    limit: number;
    cursor?: CommentListCursor;
    includeTombstoned: boolean;
  }): CommentRecord[] {
    const projectId = humanProjectIdSchema.parse(input.projectId);
    const parts = workItemKeyParts(input.workItem);
    const limit = input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new CommentRepositoryError("comment_input_invalid");
    }

    const tombstoneClause = input.includeTombstoned ? "" : "AND tombstoned_at IS NULL";
    if (input.cursor) {
      const rows = this.database
        .prepare(
          `SELECT * FROM comments
           WHERE project_id=? AND canvas_id=? AND work_item_kind=? AND work_item_key=?
             ${tombstoneClause}
             AND (
               created_at > ?
               OR (created_at = ? AND comment_id > ?)
             )
           ORDER BY created_at ASC, comment_id ASC
           LIMIT ?`
        )
        .all(
          projectId,
          parts.canvasId,
          parts.workItemKind,
          parts.workItemKey,
          input.cursor.createdAt,
          input.cursor.createdAt,
          input.cursor.commentId,
          limit
        ) as CommentRow[];
      return rows.map(toRecord);
    }

    const rows = this.database
      .prepare(
        `SELECT * FROM comments
         WHERE project_id=? AND canvas_id=? AND work_item_kind=? AND work_item_key=?
           ${tombstoneClause}
         ORDER BY created_at ASC, comment_id ASC
         LIMIT ?`
      )
      .all(projectId, parts.canvasId, parts.workItemKind, parts.workItemKey, limit) as CommentRow[];
    return rows.map(toRecord);
  }

  /** Allocate a new branded comment id. */
  allocateCommentId(): CommentId {
    return commentIdSchema.parse(randomUUID());
  }

  /** Convenience: author principal scope helper for callers that need typed ids. */
  parseAuthorId(humanPrincipalId: string): string {
    return humanPrincipalIdSchema.parse(humanPrincipalId);
  }

  /** Replace attachment metadata on an existing row (used when binding after create). */
  setAttachmentsUnlocked(
    projectId: string,
    commentId: string,
    attachments: readonly CommentAttachmentMetadata[]
  ): void {
    const parsed = commentAttachmentMetadataSchema.array().parse(attachments);
    this.database
      .prepare(`UPDATE comments SET attachments_json=? WHERE project_id=? AND comment_id=?`)
      .run(
        JSON.stringify(parsed),
        humanProjectIdSchema.parse(projectId),
        commentIdSchema.parse(commentId)
      );
  }
}
